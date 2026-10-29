import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { query, tx } from "@/lib/server/db";
import { body, json, notFound, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };
type CommentRow = { id: string; body: string; created_at: Date; author_id: string; username: string; display_name: string; avatar_hue: number };

const view = (c: CommentRow) => ({
  id: c.id, body: c.body, createdAt: c.created_at,
  author: { id: c.author_id, username: c.username, displayName: c.display_name, avatarHue: c.avatar_hue },
});

export const GET = route<Ctx>(async (req, ctx) => {
  await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const rows = await query<CommentRow>(
    `SELECT c.id, c.body, c.created_at, u.id AS author_id, u.username, u.display_name, u.avatar_hue
       FROM post_comments c JOIN users u ON u.id = c.author_id
      WHERE c.post_id = $1 ORDER BY c.created_at LIMIT 200`,
    [id],
  );
  return json({ comments: rows.map(view) });
});

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, z.object({ body: z.string().trim().min(1).max(1000) }));
  await rateLimit(`comment:${user.id}`, 60, 3600);
  const commentId = randomUUID();
  await tx(async (q) => {
    const { rows } = await q.query("UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1 RETURNING 1", [id]);
    if (!rows.length) throw notFound("Post not found.");
    await q.query("INSERT INTO post_comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)", [commentId, id, user.id, input.body]);
  });
  return json({
    comment: view({
      id: commentId, body: input.body, created_at: new Date(), author_id: user.id,
      username: user.username, display_name: user.display_name, avatar_hue: user.avatar_hue,
    }),
  }, { status: 201 });
});
