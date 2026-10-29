import { NextResponse } from "next/server";
import { destroySession } from "@/lib/server/auth";
import { route } from "@/lib/server/http";

export const POST = route(async (req) => {
  const res = NextResponse.json({ ok: true });
  await destroySession(req, res);
  return res;
});
