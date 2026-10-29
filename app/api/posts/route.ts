import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { one, query } from "@/lib/server/db";
import { badRequest, body, json, route } from "@/lib/server/http";
import { MOODS, POST_SELECT, postView, type PostRow } from "@/lib/server/posts";
import { rateLimit } from "@/lib/server/rate-limit";
import { uuid } from "@/lib/server/validation";

const PAGE = 20;

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const params = req.nextUrl.searchParams;
  const scope = params.get("scope") ?? "feed";
  const before = params.get("before");
  const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : new Date(Date.now() + 60_000);

  let where: string;
  const args: unknown[] = [user.id, beforeDate];
  if (scope === "user") {
    args.push(uuid.parse(params.get("userId")));
    where = "p.author_id = $3";
  } else if (scope === "explore") {
    where = "true";
  } else {
    where = "(p.author_id = $1 OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1))";
  }
  const rows = await query<PostRow>(
    `${POST_SELECT} WHERE ${where} AND p.created_at < $2 ORDER BY p.created_at DESC LIMIT ${PAGE}`,
    args,
  );
  return json({ posts: rows.map(postView), more: rows.length === PAGE });
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, z.object({
    body: z.string().trim().max(2000),
    imageBlobId: uuid.nullish(),
    mood: z.enum(MOODS).nullish(),
  }));
  if (!input.body && !input.imageBlobId) throw badRequest("Write something or add a photo.");
  await rateLimit(`post:${user.id}`, 30, 3600);
  if (input.imageBlobId) {
    const blob = await one("SELECT 1 FROM blobs WHERE id = $1 AND owner_id = $2 AND is_public", [input.imageBlobId, user.id]);
    if (!blob) throw badRequest("That image upload was not found.");
  }
  const id = randomUUID();
  await query(
    "INSERT INTO posts (id, author_id, body, image_blob_id, mood) VALUES ($1, $2, $3, $4, $5)",
    [id, user.id, input.body, input.imageBlobId ?? null, input.mood ?? null],
  );
  const row = await one<PostRow>(`${POST_SELECT} WHERE p.id = $2`, [user.id, id]);
  return json({ post: postView(row!) }, { status: 201 });
});
