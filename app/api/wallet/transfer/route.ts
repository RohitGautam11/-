import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, membership } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { ApiError, badRequest, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { envelope, uuid } from "@/lib/server/validation";
import { transfer } from "@/lib/server/wallet";

const schema = z.object({
  toUserId: uuid,
  amount: z.number().int().min(100),
  idempotencyKey: z.string().min(8).max(64),
  conversationId: uuid,
  // The private note travels as an end-to-end encrypted message attached to the payment card.
  message: envelope,
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, schema);
  await rateLimit(`pay:${user.id}`, 30, 300);
  return tx(async (q) => {
    const conversation = await membership(q, input.conversationId, user.id);
    if (!(await activeMemberIds(q, conversation.id)).includes(input.toUserId)) {
      throw badRequest("You can only pay people in this conversation.");
    }
    if (input.message.epoch !== conversation.key_epoch || conversation.needs_rotation) {
      throw new ApiError(409, "The conversation key changed. Refreshing…", "stale_epoch");
    }
    const result = await transfer(q, {
      from: user.id, to: input.toUserId, amount: input.amount,
      idempotencyKey: input.idempotencyKey, conversationId: conversation.id,
    });
    if (!result.replayed) {
      await q.query(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, epoch, iv, ciphertext, ref_id)
         VALUES ($1, $2, $3, 'payment', $4, $5, $6, $7)`,
        [input.message.id, conversation.id, user.id, input.message.epoch, input.message.iv, input.message.ciphertext, result.id],
      );
    }
    return json({ transferId: result.id, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  });
});
