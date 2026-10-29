import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextRequest, NextResponse } from "next/server";
import { one, query } from "./db";
import { ApiError } from "./http";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const SESSION_COOKIE = "vt_session";
const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_hue: number;
  public_key: string;
  created_at: string;
};

export function appSecret() {
  const secret = process.env.APP_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.VERCEL_ENV === "production") {
    throw new ApiError(500, "APP_SECRET must be set (32+ characters) in production.", "config");
  }
  return "vartalap-local-development-secret-do-not-use-in-prod";
}

/**
 * The browser never sends the password. It derives an "auth key" with PBKDF2 and sends that;
 * we hash it again with scrypt so a database leak does not even reveal the auth key.
 */
export async function hashAuthKey(authKey: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(authKey, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyAuthKey(authKey: string, stored: string) {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(authKey, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

/** Deterministic decoy salt so the login endpoint does not reveal which usernames exist. */
export function decoySalt(username: string) {
  return createHmac("sha256", appSecret()).update(`kdf-salt:${username}`).digest().subarray(0, 16).toString("base64");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

export function sessionHash(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return token ? sha256(token) : "";
}

export async function createSession(res: NextResponse, userId: string, userAgent: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query(
    "INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)",
    [sha256(token), userId, userAgent.slice(0, 200), expires],
  );
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function destroySession(req: NextRequest, res: NextResponse) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function currentUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await one<SessionUser & { last_seen_at: Date }>(
    `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_hue, u.public_key, u.created_at, u.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    void query("UPDATE users SET last_seen_at = now() WHERE id = $1", [row.id]).catch(() => undefined);
  }
  return row;
}

export async function requireUser(req: NextRequest): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw new ApiError(401, "Please sign in again.", "unauthorized");
  return user;
}
