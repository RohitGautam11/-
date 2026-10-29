import { one } from "./db";
import { ApiError } from "./http";

// Local development and test runs hit endpoints far harder than people do.
const FACTOR = process.env.NODE_ENV === "production" ? Number(process.env.RATE_LIMIT_FACTOR ?? 1) : 50;

/** Fixed-window limiter stored in Postgres, so it holds across serverless instances. */
export async function rateLimit(bucket: string, limit: number, windowSeconds: number) {
  limit *= FACTOR;
  const row = await one<{ hits: number }>(
    `INSERT INTO rate_limits (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING hits`,
    [bucket, windowSeconds],
  );
  if ((row?.hits ?? 0) > limit) {
    throw new ApiError(429, "Too many attempts. Please wait a moment and try again.", "rate_limited");
  }
}
