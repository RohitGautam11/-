import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, message, "bad_request");
export const forbidden = (message = "You do not have access to this.") => new ApiError(403, message, "forbidden");
export const notFound = (message = "Not found.") => new ApiError(404, message, "not_found");

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Wraps a route handler with origin checks and uniform JSON error responses. */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      return await fn(req, ctx);
    } catch (error) {
      if (error instanceof ApiError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        const message = issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input.";
        return NextResponse.json({ error: message, code: "validation" }, { status: 400 });
      }
      // Unique violation: a concurrent duplicate (double-tap, retry) lost the race.
      if ((error as { code?: string })?.code === "23505") {
        return NextResponse.json({ error: "This was already processed.", code: "conflict" }, { status: 409 });
      }
      console.error("[api]", req.method, req.nextUrl.pathname, error);
      return NextResponse.json({ error: "Something went wrong. Please try again.", code: "internal" }, { status: 500 });
    }
  };
}

// Cookies are SameSite=Lax; checking Origin as well closes the remaining cross-site POST paths.
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return; // Non-browser clients (CLI tests, native shells) don't send Origin.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  try {
    const originHost = new URL(origin).host;
    if (originHost === host || allowed.includes(origin)) return;
  } catch {
    // fall through
  }
  throw forbidden("Cross-origin request blocked.");
}

export async function body<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return schema.parse(data);
}

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function clientIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
