import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { membership } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { ApiError, badRequest, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { envelope, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

const schema = envelope.extend({
  // Time capsule: held back from recipients until this moment (max one year ahead).
  revealAt: z.iso.datetime().optional(),
});

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const conversationId = uuid.parse((await ctx.params).id);
  const input = await body(req, schema);
  await rateLimit(`send:${user.id}`, 120, 60);

  let revealAt: Date | null = null;
  if (input.revealAt) {
    revealAt = new Date(input.revealAt);
    const ahead = revealAt.getTime() - Date.now();
    if (ahead < 60_000) throw badRequest("A time capsule must open at least a minute from now.");
    if (ahead > 366 * 86_400_000) throw badRequest("A time capsule can open at most a year from now.");
  }

  return tx(async (q) => {
    const conversation = await membership(q, conversationId, user.id);
    if (conversation.needs_rotation || input.epoch !== conversation.key_epoch) {
      throw new ApiError(409, "The conversation key changed. Refreshing…", "stale_epoch");
    }
    const expiresAt = conversation.disappearing_seconds
      ? new Date(Date.now() + conversation.disappearing_seconds * 1000)
      : null;
    const { rows } = await q.query<{ id: string; seq: number; created_at: Date; sender_id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, epoch, iv, ciphertext, reveal_at, revealed, expires_at)
       VALUES ($1, $2, $3, 'e2e', $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET id = messages.id
       RETURNING id, seq, created_at, sender_id`,
      [input.id, conversationId, user.id, input.epoch, input.iv, input.ciphertext, revealAt, revealAt === null, expiresAt],
    );
    if (rows[0].sender_id !== user.id) throw badRequest("Message id already in use.");
    return json({ id: rows[0].id, seq: rows[0].seq, createdAt: rows[0].created_at, expiresAt, revealAt }, { status: 201 });
  });
});
