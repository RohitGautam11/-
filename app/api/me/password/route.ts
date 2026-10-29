import { z } from "zod";
import { hashAuthKey, requireUser, sessionHash, verifyAuthKey } from "@/lib/server/auth";
import { one, query } from "@/lib/server/db";
import { ApiError, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { b64 } from "@/lib/server/validation";

const authKey = z.string().regex(/^[0-9a-f]{64}$/, "invalid auth key");

/** Password change: the client re-encrypts its identity key under the new password-derived key. */
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await body(req, z.object({
    currentAuthKey: authKey,
    newAuthKey: authKey,
    kdfSalt: b64(64),
    kdfIterations: z.number().int().min(100_000).max(5_000_000),
    encryptedPrivateKey: z.string().min(20).max(2000),
  }));
  await rateLimit(`password:${user.id}`, 5, 3600);
  const row = await one<{ auth_hash: string }>("SELECT auth_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !(await verifyAuthKey(input.currentAuthKey, row.auth_hash))) {
    throw new ApiError(401, "Your current password is incorrect.", "invalid_credentials");
  }
  await query(
    "UPDATE users SET auth_hash = $2, kdf_salt = $3, kdf_iterations = $4, encrypted_private_key = $5 WHERE id = $1",
    [user.id, await hashAuthKey(input.newAuthKey), input.kdfSalt, input.kdfIterations, input.encryptedPrivateKey],
  );
  // Sign out every other device.
  await query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, sessionHash(req)]);
  return json({ ok: true });
});
