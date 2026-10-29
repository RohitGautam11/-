import { connection } from "next/server";
import { one } from "@/lib/server/db";

export async function GET() {
  await connection();
  try {
    await one("SELECT 1");
    return Response.json({ ok: true, database: "up", time: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[health]", error);
    return Response.json(
      { ok: false, database: "down", hint: "Check DATABASE_URL" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
