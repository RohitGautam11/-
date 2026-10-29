import { after } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { cleanup } from "@/lib/server/cleanup";
import { query } from "@/lib/server/db";
import { json, route } from "@/lib/server/http";
import { PUBLIC_USER_COLUMNS, publicView, type PublicUserRow } from "@/lib/server/users";

const PAGE = 300;
// Rows touched within this window may still have concurrent, lower-seq transactions committing,
// so the cursor never advances past them; clients de-duplicate the overlap.
const SETTLE_MS = 2500;

type MessageRow = {
  id: string; conversation_id: string; sender_id: string; kind: string; epoch: number;
  iv: string | null; ciphertext: string | null; system_text: string | null; ref_id: string | null;
  reveal_at: Date | null; expires_at: Date | null; edited_at: Date | null; deleted_at: Date | null;
  seq: number; created_at: Date; touched_at: Date;
};

type ConversationRow = {
  id: string; kind: string; created_by: string; key_epoch: number; needs_rotation: boolean;
  encrypted_meta: string | null; disappearing_seconds: number | null; change_seq: number;
  touched_at: Date; created_at: Date; role: string; left_at: Date | null;
};

/**
 * Incremental sync. Returns every message and conversation change after `cursor` that the
 * user may see. Message bodies are ciphertext; the server cannot read them.
 */
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const cursor = Math.max(0, Number(req.nextUrl.searchParams.get("cursor") ?? 0) || 0);

  // Open any time capsules that are due, bumping their seq so recipients receive them now.
  await query(
    `UPDATE messages SET revealed = true, seq = nextval('change_seq'), touched_at = clock_timestamp()
      WHERE NOT revealed AND reveal_at <= now()
        AND conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1 AND left_at IS NULL)`,
    [user.id],
  );

  const messages = await query<MessageRow>(
    `SELECT m.id, m.conversation_id, m.sender_id, m.kind, m.epoch, m.system_text, m.ref_id, m.reveal_at,
            m.expires_at, m.edited_at, m.deleted_at, m.seq, m.created_at, m.touched_at,
            CASE WHEN m.revealed OR m.sender_id = $1 THEN m.iv END AS iv,
            CASE WHEN m.revealed OR m.sender_id = $1 THEN m.ciphertext END AS ciphertext
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
      WHERE m.seq > $2
        AND m.created_at >= cm.joined_at
        AND (cm.left_at IS NULL OR m.created_at <= cm.left_at)
        AND (m.expires_at IS NULL OR m.expires_at > now())
      ORDER BY m.seq
      LIMIT ${PAGE + 1}`,
    [user.id, cursor],
  );
  const more = messages.length > PAGE;
  if (more) messages.length = PAGE;

  const conversations = await query<ConversationRow>(
    `SELECT c.id, c.kind, c.created_by, c.key_epoch, c.needs_rotation, c.encrypted_meta, c.disappearing_seconds,
            c.change_seq, c.touched_at, c.created_at, cm.role, cm.left_at
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
      WHERE c.change_seq > $2
      ORDER BY c.change_seq`,
    [user.id, cursor],
  );

  const ids = conversations.map((c) => c.id);
  const [members, keys] = ids.length
    ? await Promise.all([
        query<PublicUserRow & { conversation_id: string; role: string; last_read_seq: number; left_at: Date | null; joined_at: Date }>(
          `SELECT cm.conversation_id, cm.role, cm.last_read_seq, cm.left_at, cm.joined_at, ${PUBLIC_USER_COLUMNS}
             FROM conversation_members cm JOIN users u ON u.id = cm.user_id
            WHERE cm.conversation_id = ANY($1::uuid[])`,
          [ids],
        ),
        query<{ conversation_id: string; epoch: number; wrapped_key: string }>(
          `SELECT conversation_id, epoch, wrapped_key FROM conversation_keys
            WHERE user_id = $1 AND conversation_id = ANY($2::uuid[])`,
          [user.id, ids],
        ),
      ])
    : [[], []];

  // Payment cards carry authoritative ledger data next to the (encrypted) note.
  const refIds = messages.filter((m) => m.ref_id && (m.kind === "payment" || m.kind === "request")).map((m) => m.ref_id!);
  type Split = { kind: "split"; requesterId: string; items: { id: string; payerId: string; amount: number; status: string }[] };
  const refMap = new Map<string, Split | { kind: "transfer"; amount: number; fromId: string; toId: string }>();
  if (refIds.length) {
    const [transfers, requests] = await Promise.all([
      query<{ id: string; amount_paise: number; from_user: string; to_user: string }>(
        "SELECT id, amount_paise, from_user, to_user FROM transfers WHERE id = ANY($1::uuid[])",
        [refIds],
      ),
      query<{ id: string; split_id: string; requester_id: string; payer_id: string; amount_paise: number; status: string }>(
        "SELECT id, split_id, requester_id, payer_id, amount_paise, status FROM payment_requests WHERE split_id = ANY($1::uuid[]) ORDER BY created_at",
        [refIds],
      ),
    ]);
    for (const t of transfers) refMap.set(t.id, { kind: "transfer", amount: t.amount_paise, fromId: t.from_user, toId: t.to_user });
    for (const r of requests) {
      const split = (refMap.get(r.split_id) as Split | undefined) ?? { kind: "split" as const, requesterId: r.requester_id, items: [] };
      split.items.push({ id: r.id, payerId: r.payer_id, amount: r.amount_paise, status: r.status });
      refMap.set(r.split_id, split);
    }
  }

  const settled = Date.now() - SETTLE_MS;
  let next = cursor;
  if (more) {
    next = messages[messages.length - 1].seq;
  } else {
    for (const m of messages) if (new Date(m.touched_at).getTime() < settled) next = Math.max(next, m.seq);
    for (const c of conversations) if (new Date(c.touched_at).getTime() < settled) next = Math.max(next, c.change_seq);
    // Anything not yet settled must be re-read next time, so never jump past it.
    const unsettled = [
      ...messages.filter((m) => new Date(m.touched_at).getTime() >= settled).map((m) => m.seq),
      ...conversations.filter((c) => new Date(c.touched_at).getTime() >= settled).map((c) => c.change_seq),
    ];
    if (unsettled.length) next = Math.min(next, Math.min(...unsettled) - 1);
  }

  // Hobby-plan crons run daily, so also sweep expired data opportunistically after responding.
  if (Math.random() < 0.02) after(() => cleanup().catch(() => undefined));

  return json({
    cursor: Math.max(cursor, next),
    more,
    serverTime: new Date().toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      kind: m.kind,
      epoch: m.epoch,
      iv: m.iv,
      ciphertext: m.ciphertext,
      systemText: m.system_text,
      ref: m.ref_id ? refMap.get(m.ref_id) ?? null : null,
      revealAt: m.reveal_at,
      expiresAt: m.expires_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      seq: m.seq,
      createdAt: m.created_at,
    })),
    conversations: conversations.map((c) => ({
      id: c.id,
      kind: c.kind,
      createdBy: c.created_by,
      keyEpoch: c.key_epoch,
      needsRotation: c.needs_rotation,
      encryptedMeta: c.encrypted_meta,
      disappearingSeconds: c.disappearing_seconds,
      role: c.role,
      leftAt: c.left_at,
      createdAt: c.created_at,
      changeSeq: c.change_seq,
      members: members
        .filter((m) => m.conversation_id === c.id)
        .map((m) => ({ ...publicView(m), role: m.role, lastReadSeq: m.last_read_seq, leftAt: m.left_at, joinedAt: m.joined_at })),
      keys: keys.filter((k) => k.conversation_id === c.id).map((k) => ({ epoch: k.epoch, wrappedKey: k.wrapped_key })),
    })),
  });
});
