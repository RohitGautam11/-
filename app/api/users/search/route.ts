import { requireUser } from "@/lib/server/auth";
import { query } from "@/lib/server/db";
import { json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { PUBLIC_USER_COLUMNS, publicView, type PublicUserRow } from "@/lib/server/users";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`search:${user.id}`, 60, 60);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 32);
  if (q.length < 2) return json({ users: [] });
  const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await query<PublicUserRow>(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users u
      WHERE u.id <> $1 AND (u.username LIKE $2 OR lower(u.display_name) LIKE $2 OR lower(u.display_name) LIKE '% ' || $2)
      ORDER BY (u.username = $3) DESC, u.username LIMIT 20`,
    [user.id, like, q],
  );
  return json({ users: rows.map(publicView) });
});
