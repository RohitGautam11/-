import { z } from "zod";
import { decoySalt } from "@/lib/server/auth";
import { one } from "@/lib/server/db";
import { body, clientIp, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { DEFAULT_KDF_ITERATIONS, username } from "@/lib/server/validation";



/** Returns the client-side key-derivation parameters for a username (decoys for unknown users). */
export const POST = route(async (req) => {
  const input = await body(req, z.object({ username }));
  await rateLimit(`params:${clientIp(req)}`, 60, 60);
  const row = await one<{ kdf_salt: string; kdf_iterations: number }>(
    "SELECT kdf_salt, kdf_iterations FROM users WHERE username = $1",
    [input.username],
  );
  return json({
    kdfSalt: row?.kdf_salt ?? decoySalt(input.username),
    kdfIterations: row?.kdf_iterations ?? DEFAULT_KDF_ITERATIONS,
  });
});
