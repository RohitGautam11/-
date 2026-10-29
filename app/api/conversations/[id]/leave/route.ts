import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, bump, membership, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, json, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Leave a group. The leaver must not pick the next key, so the group is flagged and the next
 * remaining member's device rotates it before anyone can send again.
 */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    if (conversation.kind !== "group") throw badRequest("Direct chats cannot be left.");
    const remaining = (await activeMemberIds(q, id)).filter((uid) => uid !== user.id);
    await q.query("UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2", [id, user.id]);
    if (remaining.length) {
      // Hand ownership on if the owner leaves, preferring an existing admin.
      if (conversation.role === "owner") {
        await q.query(
          `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = (
             SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL
              ORDER BY (role = 'admin') DESC, joined_at LIMIT 1)`,
          [id],
        );
      }
      await q.query("UPDATE conversations SET needs_rotation = true WHERE id = $1", [id]);
      await systemMessage(q, id, user.id, `${user.display_name} left`);
    }
    await bump(q, id);
    return json({ ok: true });
  });
});
