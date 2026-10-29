import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { bump, displayNameOf, membership, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, body, forbidden, json, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, z.object({ userId: uuid, role: z.enum(["admin", "member"]) }));
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    if (conversation.kind !== "group") throw badRequest("Direct chats have no roles.");
    if (conversation.role === "member") throw forbidden("Only admins can change roles.");
    const { rows } = await q.query(
      `UPDATE conversation_members SET role = $3
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL AND role <> 'owner' RETURNING 1`,
      [id, input.userId, input.role],
    );
    if (!rows.length) throw badRequest("That person cannot be changed.");
    const name = await displayNameOf(q, input.userId);
    await systemMessage(q, id, user.id, input.role === "admin" ? `${name} is now an admin` : `${name} is no longer an admin`);
    await bump(q, id);
    return json({ ok: true });
  });
});
