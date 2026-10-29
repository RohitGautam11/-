import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { assertKeysCover, insertKeys, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { badRequest, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { encryptedMeta, MAX_GROUP_MEMBERS, uuid, wrappedKey } from "@/lib/server/validation";

const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), id: uuid, peerId: uuid, keys: z.array(wrappedKey).length(2) }),
  z.object({
    kind: z.literal("group"),
    id: uuid,
    memberIds: z.array(uuid).min(1).max(MAX_GROUP_MEMBERS - 1),
    keys: z.array(wrappedKey).min(2).max(MAX_GROUP_MEMBERS),
    encryptedMeta,
  }),
]);

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, schema);
  await rateLimit(`conv-create:${user.id}`, 30, 3600);

  const memberIds = input.kind === "direct" ? [input.peerId] : [...new Set(input.memberIds)].filter((id) => id !== user.id);
  if (memberIds.length === 0) throw badRequest("Add at least one other person.");
  const everyone = [user.id, ...memberIds];
  assertKeysCover(input.keys, everyone);

  return tx(async (q) => {
    const found = await q.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::uuid[])", [everyone]);
    if (found.rows.length !== everyone.length) throw badRequest("One of these people does not exist.");

    const directKey = input.kind === "direct" ? [user.id, input.peerId].sort().join(":") : null;
    if (directKey) {
      const existing = await q.query<{ id: string }>("SELECT id FROM conversations WHERE direct_key = $1", [directKey]);
      if (existing.rows[0]) return json({ id: existing.rows[0].id, existing: true });
    }

    const id = input.id;
    const taken = await q.query("SELECT 1 FROM conversations WHERE id = $1", [id]);
    if (taken.rows.length) throw badRequest("Conversation id already in use.");
    await q.query(
      `INSERT INTO conversations (id, kind, direct_key, created_by, encrypted_meta) VALUES ($1, $2, $3, $4, $5)`,
      [id, input.kind, directKey, user.id, input.kind === "group" ? input.encryptedMeta : null],
    );
    for (const memberId of everyone) {
      const role = input.kind === "group" && memberId === user.id ? "owner" : "member";
      await q.query(
        "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)",
        [id, memberId, role],
      );
    }
    await insertKeys(q, id, 1, user.id, input.keys);
    if (input.kind === "group") await systemMessage(q, id, user.id, `${user.display_name} created the group`);
    return json({ id, existing: false }, { status: 201 });
  });
});
