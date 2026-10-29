import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { tx } from "@/lib/server/db";
import { forbidden, body, json, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { credit, testMoneyEnabled } from "@/lib/server/wallet";

/** Test mode only: adds play money. Real top-ups need a payment gateway (see README). */
export const POST = route(async (req) => {
  const user = await requireUser(req);
  if (!testMoneyEnabled()) throw forbidden("Adding test money is turned off on this server.");
  const { amount } = await body(req, z.object({ amount: z.number().int().min(100).max(1_000_000) }));
  await rateLimit(`topup:${user.id}`, 10, 3600);
  await tx((q) => credit(q, user.id, amount, "topup"));
  return json({ ok: true });
});
