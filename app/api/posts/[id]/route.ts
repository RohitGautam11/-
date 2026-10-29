import { requireUser } from "@/lib/server/auth";
import { query } from "@/lib/server/db";
import { json, notFound, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const rows = await query<{ image_blob_id: string | null }>(
    "DELETE FROM posts WHERE id = $1 AND author_id = $2 RETURNING image_blob_id",
    [id, user.id],
  );
  if (!rows.length) throw notFound("Post not found.");
  if (rows[0].image_blob_id) await query("DELETE FROM blobs WHERE id = $1", [rows[0].image_blob_id]);
  return json({ ok: true });
});
