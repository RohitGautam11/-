import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { membership } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, body, forbidden, json, notFound, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";
import { transfer } from "@/lib/server/wallet";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pay"), idempotencyKey: z.string().min(8).max(64) }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("cancel") }),
]);

/** Pay, decline (payer) or cancel (requester) one share of a split. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, schema);
  return tx(async (q) => {
    const { rows } = await q.query<{
      id: string; split_id: string; conversation_id: string; requester_id: string; payer_id: string; amount_paise: number; status: string;
    }>("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [id]);
    const request = rows[0];
    if (!request) throw notFound("Request not found.");
    await membership(q, request.conversation_id, user.id);
    if (request.status !== "pending") throw badRequest(`This request is already ${request.status}.`);

    if (input.action === "cancel") {
      if (request.requester_id !== user.id) throw forbidden("Only the requester can cancel.");
    } else if (request.payer_id !== user.id) {
      throw forbidden("This request is not addressed to you.");
    }

    let transferId: string | null = null;
    if (input.action === "pay") {
      transferId = (await transfer(q, {
        from: user.id, to: request.requester_id, amount: request.amount_paise,
        idempotencyKey: input.idempotencyKey, conversationId: request.conversation_id, requestId: request.id,
      })).id;
    }
    const status = input.action === "pay" ? "paid" : input.action === "decline" ? "declined" : "cancelled";
    await q.query(
      "UPDATE payment_requests SET status = $2, transfer_id = $3, resolved_at = now() WHERE id = $1",
      [id, status, transferId],
    );
    // Re-deliver the chat card so everyone sees the new status.
    await q.query(
      "UPDATE messages SET seq = nextval('change_seq'), touched_at = clock_timestamp() WHERE ref_id = $1",
      [request.split_id],
    );
    return json({ ok: true, status, transferId });
  });
});
