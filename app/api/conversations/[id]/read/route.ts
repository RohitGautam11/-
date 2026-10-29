import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { bump, membership } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { body, json, route } from "@/lib/server/http";
import { uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Read receipts: members see each other's last-read position. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const { seq } = await body(req, z.object({ seq: z.number().int().min(0) }));
  return tx(async (q) => {
    await membership(q, id, user.id);
    const { rows } = await q.query(
      `UPDATE conversation_members SET last_read_seq = $3
        WHERE conversation_id = $1 AND user_id = $2 AND last_read_seq < $3 RETURNING 1`,
      [id, user.id, seq],
    );
    if (rows.length) await bump(q, id);
    return json({ ok: true });
  });
});
