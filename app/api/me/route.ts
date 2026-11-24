import { z } from "zod";
import { currentUser, requireUser, type SessionUser } from "@/lib/server/auth";
import { one } from "@/lib/server/db";
import { body, json, route } from "@/lib/server/http";
import { selfView } from "@/lib/server/users";
import { displayName } from "@/lib/server/validation";

export const GET = route(async (req) => {
  const user = await currentUser(req);
  return json({ user: user ? selfView(user) : null });
});

export const PATCH = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, z.object({
    displayName: displayName.optional(),
    bio: z.string().trim().max(160).optional(),
    avatarHue: z.number().int().min(0).max(359).optional(),
    tourDone: z.boolean().optional(),
  }));
  const updated = await one<SessionUser>(
    `UPDATE users SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), avatar_hue = COALESCE($4, avatar_hue),
            tour_done_at = CASE WHEN $5::boolean IS NULL THEN tour_done_at WHEN $5 THEN coalesce(tour_done_at, now()) ELSE NULL END
      WHERE id = $1 RETURNING id, username, display_name, bio, avatar_hue, public_key, created_at, tour_done_at`,
    [user.id, input.displayName ?? null, input.bio ?? null, input.avatarHue ?? null, input.tourDone ?? null],
  );
  return json({ user: selfView(updated!) });
});
