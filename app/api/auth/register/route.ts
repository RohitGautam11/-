import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashAuthKey, type SessionUser } from "@/lib/server/auth";
import { tx } from "@/lib/server/db";
import { ApiError, body, clientIp, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { selfView } from "@/lib/server/users";
import { b64, displayName, username } from "@/lib/server/validation";
import { credit, SIGNUP_BONUS_PAISE } from "@/lib/server/wallet";

const schema = z.object({
  username,
  displayName,
  authKey: z.string().regex(/^[0-9a-f]{64}$/, "invalid auth key"),
  kdfSalt: b64(64),
  kdfIterations: z.number().int().min(100_000).max(5_000_000),
  publicKey: b64(400),
  encryptedPrivateKey: z.string().min(20).max(2000),
});

export const POST = route(async (req) => {
  const input = await body(req, schema);
  await rateLimit(`register:${clientIp(req)}`, 10, 3600);
  const authHash = await hashAuthKey(input.authKey);
  const id = randomUUID();
  const hue = Math.floor(Math.random() * 360);

  const user = await tx(async (q) => {
    const inserted = await q.query<SessionUser>(
      `INSERT INTO users (id, username, display_name, avatar_hue, auth_hash, kdf_salt, kdf_iterations, public_key, encrypted_private_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, display_name, bio, avatar_hue, public_key, created_at`,
      [id, input.username, input.displayName, hue, authHash, input.kdfSalt, input.kdfIterations, input.publicKey, input.encryptedPrivateKey],
    );
    if (!inserted.rows[0]) throw new ApiError(409, "That username is taken. Try another one.", "username_taken");
    if (SIGNUP_BONUS_PAISE > 0) await credit(q, id, SIGNUP_BONUS_PAISE, "bonus");
    return inserted.rows[0];
  });

  const res = NextResponse.json({ user: selfView(user), encryptedPrivateKey: input.encryptedPrivateKey }, { status: 201 });
  await createSession(res, user.id, req.headers.get("user-agent") ?? "");
  return res;
});
