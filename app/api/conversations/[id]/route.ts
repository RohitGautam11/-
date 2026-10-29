import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { bump, describeDuration, membership, requireAdmin, systemMessage } from "@/lib/server/conversations";
import { tx } from "@/lib/server/db";
import { ApiError, body, json, route } from "@/lib/server/http";
import { encryptedMeta, uuid } from "@/lib/server/validation";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  disappearingSeconds: z.number().int().min(30).max(90 * 86400).nullable().optional(),
  // Group name / description / photo, encrypted under the current key epoch.
  encryptedMeta: z.object({ epoch: z.number().int(), value: encryptedMeta }).optional(),
});

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const input = await body(req, schema);
  return tx(async (q) => {
    const conversation = await membership(q, id, user.id, true);
    requireAdmin(conversation);
    if (input.disappearingSeconds !== undefined && input.disappearingSeconds !== conversation.disappearing_seconds) {
      await q.query("UPDATE conversations SET disappearing_seconds = $2 WHERE id = $1", [id, input.disappearingSeconds]);
      await systemMessage(
        q, id, user.id,
        input.disappearingSeconds
          ? `${user.display_name} turned on disappearing messages · ${describeDuration(input.disappearingSeconds)}`
          : `${user.display_name} turned off disappearing messages`,
      );
    }
    if (input.encryptedMeta) {
      if (conversation.kind !== "group") throw new ApiError(400, "Only groups have a name.");
      if (input.encryptedMeta.epoch !== conversation.key_epoch) throw new ApiError(409, "The group key changed.", "stale_epoch");
      await q.query("UPDATE conversations SET encrypted_meta = $2 WHERE id = $1", [id, input.encryptedMeta.value]);
      await systemMessage(q, id, user.id, `${user.display_name} updated the group info`);
    }
    await bump(q, id);
    return json({ ok: true });
  });
});
