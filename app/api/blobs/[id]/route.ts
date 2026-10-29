import { currentUser } from "@/lib/server/auth";
import { one } from "@/lib/server/db";
import { notFound, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const id = uuid.safeParse((await ctx.params).id);
  if (!id.success) throw notFound();
  const user = await currentUser(req);
  const blob = await one<{ data: Buffer | Uint8Array; content_type: string; is_public: boolean }>(
    `SELECT b.data, b.content_type, b.is_public FROM blobs b
      WHERE b.id = $1 AND (b.is_public OR EXISTS (
        SELECT 1 FROM conversation_members cm
         WHERE cm.conversation_id = b.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL))`,
    [id.data, user?.id ?? "00000000-0000-0000-0000-000000000000"],
  );
  if (!blob) throw notFound();
  return new Response(new Uint8Array(blob.data), {
    headers: {
      "content-type": blob.content_type,
      "cache-control": blob.is_public ? "public, max-age=31536000, immutable" : "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
});
