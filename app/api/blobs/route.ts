import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/server/auth";
import { membership } from "@/lib/server/conversations";
import { query, tx } from "@/lib/server/db";
import { ApiError, badRequest, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { MAX_BLOB_BYTES, uuid } from "@/lib/server/validation";

const PUBLIC_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Upload raw bytes. Chat attachments (`?conversationId=`) are encrypted on the device first, so
 * the server only ever holds ciphertext. Public post images (`?public=1`) are plain images.
 */
export const POST = route(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`blob:${user.id}`, 60, 3600);
  const params = req.nextUrl.searchParams;
  const isPublic = params.get("public") === "1";
  const conversationId = params.get("conversationId");
  if (!isPublic && !conversationId) throw badRequest("conversationId is required for private uploads.");

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BLOB_BYTES) throw new ApiError(413, "That file is too large (max ~4 MB).");
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length) throw badRequest("The file is empty.");
  if (data.length > MAX_BLOB_BYTES) throw new ApiError(413, "That file is too large (max ~4 MB).");

  const contentType = isPublic ? (req.headers.get("content-type") ?? "") : "application/octet-stream";
  if (isPublic && !PUBLIC_IMAGE_TYPES.has(contentType)) throw badRequest("Post images must be JPEG, PNG, WebP or GIF.");

  const id = randomUUID();
  if (conversationId) {
    await tx(async (q) => {
      await membership(q, uuid.parse(conversationId), user.id);
      await q.query(
        "INSERT INTO blobs (id, owner_id, conversation_id, is_public, content_type, size, data) VALUES ($1, $2, $3, false, $4, $5, $6)",
        [id, user.id, conversationId, contentType, data.length, data],
      );
    });
  } else {
    await query(
      "INSERT INTO blobs (id, owner_id, is_public, content_type, size, data) VALUES ($1, $2, true, $3, $4, $5)",
      [id, user.id, contentType, data.length, data],
    );
  }
  return json({ id, size: data.length }, { status: 201 });
});
