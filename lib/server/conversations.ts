import { randomUUID } from "node:crypto";
import type { Queryable } from "./db";
import { ApiError, badRequest, forbidden, notFound } from "./http";

export type ConversationRow = {
  id: string;
  kind: "direct" | "group";
  created_by: string;
  key_epoch: number;
  needs_rotation: boolean;
  encrypted_meta: string | null;
  disappearing_seconds: number | null;
  role: "owner" | "admin" | "member";
};

/** Loads a conversation the user is an active member of, optionally locking it for update. */
export async function membership(q: Queryable, conversationId: string, userId: string, lock = false) {
  const { rows } = await q.query<ConversationRow>(
    `SELECT c.id, c.kind, c.created_by, c.key_epoch, c.needs_rotation, c.encrypted_meta, c.disappearing_seconds, cm.role
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL
      ${lock ? "FOR UPDATE OF c" : ""}`,
    [conversationId, userId],
  );
  if (!rows[0]) throw notFound("Conversation not found.");
  return rows[0];
}

export function requireAdmin(conversation: ConversationRow) {
  if (conversation.kind === "group" && conversation.role === "member") throw forbidden("Only group admins can do that.");
}

export async function activeMemberIds(q: Queryable, conversationId: string) {
  const { rows } = await q.query<{ user_id: string }>(
    "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL",
    [conversationId],
  );
  return rows.map((row) => row.user_id);
}

/** Marks a conversation as changed so every member picks it up on their next sync. */
export async function bump(q: Queryable, conversationId: string) {
  await q.query(
    "UPDATE conversations SET change_seq = nextval('change_seq'), touched_at = clock_timestamp() WHERE id = $1",
    [conversationId],
  );
}

export async function systemMessage(q: Queryable, conversationId: string, senderId: string, text: string) {
  await q.query(
    "INSERT INTO messages (id, conversation_id, sender_id, kind, system_text) VALUES ($1, $2, $3, 'system', $4)",
    [randomUUID(), conversationId, senderId, text],
  );
}

/** Every key epoch must be wrapped for exactly the set of members who will hold it. */
export function assertKeysCover(keys: { userId: string }[], members: string[]) {
  const expected = new Set(members);
  const given = new Set(keys.map((k) => k.userId));
  if (given.size !== keys.length || given.size !== expected.size || [...expected].some((id) => !given.has(id))) {
    throw badRequest("Encryption keys must be provided for exactly the current members.");
  }
}

export async function insertKeys(
  q: Queryable,
  conversationId: string,
  epoch: number,
  createdBy: string,
  keys: { userId: string; wrappedKey: string }[],
) {
  for (const key of keys) {
    await q.query(
      `INSERT INTO conversation_keys (conversation_id, epoch, user_id, wrapped_key, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, epoch, key.userId, key.wrappedKey, createdBy],
    );
  }
}

export type Rotation = { epoch: number; keys: { userId: string; wrappedKey: string }[]; encryptedMeta?: string | null };

/**
 * Installs a fresh conversation key epoch, wrapped for exactly `members`. Old epochs stay so history
 * remains readable to those who held them; anyone who did not receive the new epoch cannot read on.
 */
export async function rotate(q: Queryable, conversation: ConversationRow, byUserId: string, members: string[], rotation: Rotation) {
  if (rotation.epoch !== conversation.key_epoch + 1) {
    throw new ApiError(409, "Someone else just refreshed the group key. Try again.", "stale_epoch");
  }
  assertKeysCover(rotation.keys, members);
  await insertKeys(q, conversation.id, rotation.epoch, byUserId, rotation.keys);
  await q.query(
    `UPDATE conversations SET key_epoch = $2, needs_rotation = false, encrypted_meta = COALESCE($3, encrypted_meta)
      WHERE id = $1`,
    [conversation.id, rotation.epoch, rotation.encryptedMeta ?? null],
  );
  await bump(q, conversation.id);
}

export async function displayNameOf(q: Queryable, userId: string) {
  const { rows } = await q.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [userId]);
  return rows[0]?.display_name ?? "Someone";
}

export function describeDuration(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}
