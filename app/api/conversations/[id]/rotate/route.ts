import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, membership, rotate } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { body, forbidden, json, route } from "@/lib/server/http";
import { rotation, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Any member may complete a pending rotation (after someone left); admins may rotate any time. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, rotation);
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    if (!conversation.needs_rotation && conversation.kind === "group" && conversation.role === "member") {
      throw forbidden("Only admins can refresh the group key.");
    }
    await rotate(q, conversation, user.id, await activeMemberIds(q, id), input);
    return json({ ok: true, epoch: input.epoch });
  });
});
