import { requireUser } from "@/lib/server/auth";
import { tx } from "@/lib/server/db";
import { json, notFound, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Toggles the current user's like and returns the new state. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  return tx(async (q) => {
    const post = await q.query("SELECT 1 FROM posts WHERE id = $1 FOR UPDATE", [id]);
    if (!post.rows.length) throw notFound("Post not found.");
    const removed = await q.query("DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING 1", [id, user.id]);
    const liked = removed.rows.length === 0;
    if (liked) await q.query("INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)", [id, user.id]);
    const { rows } = await q.query<{ like_count: number }>(
      "UPDATE posts SET like_count = GREATEST(0, like_count + $2) WHERE id = $1 RETURNING like_count",
      [id, liked ? 1 : -1],
    );
    return json({ liked, likeCount: rows[0].like_count });
  });
});
