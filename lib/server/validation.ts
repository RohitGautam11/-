import { z } from "zod";

export const uuid = z.uuid();
export const b64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/_=-]+$/, "must be base64");
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9_.]+$/, "use letters, numbers, dot or underscore");
export const displayName = z.string().trim().min(1).max(48);

/** A message envelope as produced by the client: opaque ciphertext under a conversation key epoch. */
export const envelope = z.object({
  id: uuid,
  epoch: z.number().int().min(1),
  iv: b64(32),
  // ~64 KB of plaintext per message; attachments travel separately as blobs.
  ciphertext: b64(90_000),
});

export const wrappedKey = z.object({ userId: uuid, wrappedKey: z.string().min(10).max(2000) });
export const encryptedMeta = z.string().min(10).max(8000);

export const rotation = z.object({
  epoch: z.number().int().min(2),
  keys: z.array(wrappedKey).min(1).max(256),
  encryptedMeta: encryptedMeta.nullish(),
});

export const MAX_GROUP_MEMBERS = 256;
export const MAX_BLOB_BYTES = 4 * 1024 * 1024 - 64 * 1024; // stays under Vercel's 4.5 MB request cap
export const DEFAULT_KDF_ITERATIONS = 310_000;
