import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { query } from "@/lib/server/db";
import { badRequest, body, json, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, z.object({ userId: uuid, follow: z.boolean() }));
  if (input.userId === user.id) throw badRequest("You cannot follow yourself.");
  if (input.follow) {
    await query(
      `INSERT INTO follows (follower_id, followee_id) SELECT $1, id FROM users WHERE id = $2 ON CONFLICT DO NOTHING`,
      [user.id, input.userId],
    );
  } else {
    await query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [user.id, input.userId]);
  }
  return json({ ok: true, followed: input.follow });
});
