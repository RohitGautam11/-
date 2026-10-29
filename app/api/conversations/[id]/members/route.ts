import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { activeMemberIds, membership, requireAdmin, rotate, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, body, json, route } from "@/lib/server/http";
import { MAX_GROUP_MEMBERS, rotation, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Add people to a group. The admin's device rotates to a new key epoch wrapped for everyone,
 * so newcomers can read what is said from now on but never the earlier history.
 */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, rotation.extend({ userIds: z.array(uuid).min(1).max(50) }));
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    if (conversation.kind !== "group") throw badRequest("You can only add people to groups.");
    requireAdmin(conversation);
    const current = await activeMemberIds(q, id);
    const added = [...new Set(input.userIds)].filter((uid) => !current.includes(uid));
    if (!added.length) throw badRequest("Everyone selected is already in the group.");
    if (current.length + added.length > MAX_GROUP_MEMBERS) throw badRequest(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    const found = await q.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])", [added],
    );
    if (found.rows.length !== added.length) throw badRequest("One of these people does not exist.");

    for (const uid of added) {
      await q.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now(), role = 'member', last_read_seq = 0`,
        [id, uid],
      );
    }
    await rotate(q, conversation, user.id, [...current, ...added], input);
    const names = found.rows.map((r) => r.display_name).join(", ");
    await systemMessage(q, id, user.id, `${user.display_name} added ${names}`);
    return json({ ok: true });
  });
});
