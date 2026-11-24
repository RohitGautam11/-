import { z } from "zod";
import { requireUser, sessionHash } from "@/lib/server/auth";
import { query } from "@/lib/server/db";
import { badRequest, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

/**
 * Signed-in devices.
 *   GET    /api/me/sessions                     every device signed in to this account
 *   DELETE /api/me/sessions  { id } | { others } sign out one device, or every device except this one
 * A device id is a short prefix of the session's hash: enough to address it, useless as a credential.
 */
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const current = sessionHash(req);
  const rows = await query<{ token_hash: string; user_agent: string; created_at: Date; last_used_at: Date }>(
    "SELECT token_hash, user_agent, created_at, last_used_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_used_at DESC LIMIT 50",
    [user.id],
  );
  return json({
    sessions: rows.map((s) => ({
      id: s.token_hash.slice(0, 16), device: describe(s.user_agent), createdAt: s.created_at, lastUsedAt: s.last_used_at, current: s.token_hash === current,
    })),
  });
});

export const DELETE = route(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`sessions:${user.id}`, 30, 300);
  const input = await body(req, z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional(), others: z.boolean().optional() }));
  const current = sessionHash(req);
  if (input.others) {
    const gone = await query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING 1", [user.id, current]);
    return json({ signedOut: gone.length });
  }
  if (!input.id) throw badRequest("Pick a device.");
  if (current.startsWith(input.id)) throw badRequest("Use “Sign out” to leave this device.");
  const gone = await query("DELETE FROM sessions WHERE user_id = $1 AND left(token_hash, 16) = $2 AND token_hash <> $3 RETURNING 1", [user.id, input.id, current]);
  return json({ signedOut: gone.length });
});

function describe(ua: string) {
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iPhone / iPad" : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "";
  const app = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : /node|undici/i.test(ua) ? "API client" : "";
  return [app, os].filter(Boolean).join(" on ") || "Unknown device";
}
