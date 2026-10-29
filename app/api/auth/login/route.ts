import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashAuthKey, verifyAuthKey, type SessionUser } from "@/lib/server/auth";
import { one } from "@/lib/server/db";
import { ApiError, body, clientIp, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { selfView } from "@/lib/server/users";
import { username } from "@/lib/server/validation";

const schema = z.object({ username, authKey: z.string().regex(/^[0-9a-f]{64}$/, "invalid auth key") });

// Burned on unknown usernames so response timing does not reveal whether an account exists.
let decoyHash: Promise<string> | undefined;

export const POST = route(async (req) => {
  const input = await body(req, schema);
  await rateLimit(`login:${clientIp(req)}`, 20, 300);
  await rateLimit(`login-user:${input.username}`, 10, 300);

  const user = await one<SessionUser & { auth_hash: string; encrypted_private_key: string }>(
    `SELECT id, username, display_name, bio, avatar_hue, public_key, created_at, auth_hash, encrypted_private_key
       FROM users WHERE username = $1`,
    [input.username],
  );
  decoyHash ??= hashAuthKey("0".repeat(64));
  const ok = await verifyAuthKey(input.authKey, user?.auth_hash ?? (await decoyHash));
  if (!user || !ok) throw new ApiError(401, "Username or password is incorrect.", "invalid_credentials");

  const res = NextResponse.json({ user: selfView(user), encryptedPrivateKey: user.encrypted_private_key });
  await createSession(res, user.id, req.headers.get("user-agent") ?? "");
  return res;
});
