import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, displayNameOf, membership, requireAdmin, rotate, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, body, forbidden, json, route } from "@/lib/server/http";
import { rotation, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Remove a member. The admin's device rotates the key in the same request, excluding them. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, rotation.extend({ userId: uuid }));
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    if (conversation.kind !== "group") throw badRequest("You can only remove people from groups.");
    requireAdmin(conversation);
    if (input.userId === user.id) throw badRequest("Use “Leave group” to remove yourself.");
    if (input.userId === conversation.created_by) throw forbidden("The group owner cannot be removed.");
    const current = await activeMemberIds(q, id);
    if (!current.includes(input.userId)) throw badRequest("That person is not in the group.");

    await q.query(
      "UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2",
      [id, input.userId],
    );
    await rotate(q, conversation, user.id, current.filter((uid) => uid !== input.userId), input);
    await systemMessage(q, id, user.id, `${user.display_name} removed ${await displayNameOf(q, input.userId)}`);
    return json({ ok: true });
  });
});
