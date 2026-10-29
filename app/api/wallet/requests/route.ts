import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, membership } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { ApiError, badRequest, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { envelope, uuid } from "@/lib/server/validation";
import { MAX_TRANSFER_PAISE } from "@/lib/server/wallet";

const schema = z.object({
  conversationId: uuid,
  // One share per payer; for an even split the client divides the bill.
  shares: z.array(z.object({ payerId: uuid, amount: z.number().int().min(100).max(MAX_TRANSFER_PAISE) })).min(1).max(100),
  message: envelope,
});

/** Request money / split a bill. Shows up as one live card in the chat. */
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, schema);
  await rateLimit(`request:${user.id}`, 30, 3600);
  return tx(async (q) => {
    const conversation = await membership(q, input.conversationId, user.id);
    if (input.message.epoch !== conversation.key_epoch || conversation.needs_rotation) {
      throw new ApiError(409, "The conversation key changed. Refreshing…", "stale_epoch");
    }
    const members = await activeMemberIds(q, conversation.id);
    const payers = new Set(input.shares.map((s) => s.payerId));
    if (payers.size !== input.shares.length) throw badRequest("Each person can appear only once.");
    for (const share of input.shares) {
      if (share.payerId === user.id) throw badRequest("You cannot request money from yourself.");
      if (!members.includes(share.payerId)) throw badRequest("Everyone must be in this conversation.");
    }
    const splitId = randomUUID();
    for (const share of input.shares) {
      await q.query(
        `INSERT INTO payment_requests (id, split_id, conversation_id, requester_id, payer_id, amount_paise)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), splitId, conversation.id, user.id, share.payerId, share.amount],
      );
    }
    await q.query(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, epoch, iv, ciphertext, ref_id)
       VALUES ($1, $2, $3, 'request', $4, $5, $6, $7)`,
      [input.message.id, conversation.id, user.id, input.message.epoch, input.message.iv, input.message.ciphertext, splitId],
    );
    return json({ splitId }, { status: 201 });
  });
});
