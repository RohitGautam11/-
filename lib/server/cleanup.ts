import { query } from "./db";

/** Hard-deletes data that has passed its lifetime. Safe to run as often as you like. */
export async function cleanup() {
  const expired = await query<{ n: number }>(
    "WITH d AS (DELETE FROM messages WHERE expires_at < now() RETURNING 1) SELECT count(*)::int AS n FROM d",
  );
  await query("DELETE FROM sessions WHERE expires_at < now()");
  await query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  // Public uploads that never made it into a post.
  await query(
    `DELETE FROM blobs b WHERE b.is_public AND b.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.image_blob_id = b.id)`,
  );
  return { expiredMessages: expired[0]?.n ?? 0 };
}
