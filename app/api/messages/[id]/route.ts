import { requireUser } from "@/lib/server/auth";
import { membership } from "@/lib/server/conversations";
import { tx, type Queryable } from "@/lib/server/db";
import { ApiError, body, forbidden, json, notFound, route } from "@/lib/server/http";
import { envelope, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };
const EDIT_WINDOW_MS = 48 * 3600_000;

type Row = { id: string; conversation_id: string; sender_id: string; kind: string; created_at: Date; deleted_at: Date | null };

async function load(q: Queryable, id: string) {
  const { rows } = await q.query<Row>(
    "SELECT id, conversation_id, sender_id, kind, created_at, deleted_at FROM messages WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw notFound("Message not found.");
  return rows[0];
}

/** Edit: the sender replaces the ciphertext with a newly encrypted version. */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, envelope.omit({ id: true }));
  return tx(async (q) => {
    const message = await load(q, id);
    const conversation = await membership(q, message.conversation_id, user.id);
    if (message.sender_id !== user.id || message.kind !== "e2e") throw forbidden("You can only edit your own messages.");
    if (message.deleted_at) throw notFound("This message was deleted.");
    if (Date.now() - new Date(message.created_at).getTime() > EDIT_WINDOW_MS) throw forbidden("Messages can be edited for 48 hours.");
    if (input.epoch !== conversation.key_epoch) throw new ApiError(409, "The conversation key changed.", "stale_epoch");
    await q.query(
      `UPDATE messages SET iv = $2, ciphertext = $3, epoch = $4, edited_at = now(),
              seq = nextval('change_seq'), touched_at = clock_timestamp() WHERE id = $1`,
      [id, input.iv, input.ciphertext, input.epoch],
    );
    return json({ ok: true });
  });
});

/** Delete for everyone: the ciphertext is erased from the database, not just hidden. */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  return tx(async (q) => {
    const message = await load(q, id);
    const conversation = await membership(q, message.conversation_id, user.id);
    const isAdmin = conversation.kind === "group" && conversation.role !== "member";
    if (message.sender_id !== user.id && !isAdmin) throw forbidden("You can only delete your own messages.");
    if (message.kind !== "e2e") throw forbidden("This message cannot be deleted.");
    await q.query(
      `UPDATE messages SET iv = NULL, ciphertext = NULL, deleted_at = now(),
              seq = nextval('change_seq'), touched_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
    // Attachment ids live inside the ciphertext, so the client names the ones to erase.
    const blobIds = (req.nextUrl.searchParams.get("blobs") ?? "").split(",").filter((v) => uuid.safeParse(v).success);
    if (blobIds.length) {
      await q.query(
        "DELETE FROM blobs WHERE id = ANY($1::uuid[]) AND conversation_id = $2 AND owner_id = $3",
        [blobIds, message.conversation_id, message.sender_id],
      );
    }
    return json({ ok: true });
  });
});
