import { requireUser } from "@/lib/server/auth";
import { one } from "@/lib/server/db";
import { json, notFound, route } from "@/lib/server/http";
import { PUBLIC_USER_COLUMNS, publicView, type PublicUserRow } from "@/lib/server/users";

type Ctx = { params: Promise<{ username: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const me = await requireUser(req);
  const username = decodeURIComponent((await ctx.params).username).toLowerCase().replace(/^@/, "");
  const row = await one<PublicUserRow & { followers: number; following: number; posts: number; followed: boolean }>(
    `SELECT ${PUBLIC_USER_COLUMNS},
            (SELECT count(*)::int FROM follows WHERE followee_id = u.id) AS followers,
            (SELECT count(*)::int FROM follows WHERE follower_id = u.id) AS following,
            (SELECT count(*)::int FROM posts WHERE author_id = u.id) AS posts,
            EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id) AS followed
       FROM users u WHERE u.username = $1`,
    [username, me.id],
  );
  if (!row) throw notFound("No one with that username.");
  return json({
    user: publicView(row),
    stats: { followers: row.followers, following: row.following, posts: row.posts },
    followed: row.followed,
    isMe: row.id === me.id,
  });
});
