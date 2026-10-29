import * as c from "../crypto";
import { api } from "./api";
import { clearIdentities, loadIdentity, saveIdentity } from "./keystore";
import type { Me } from "./types";

type AuthResponse = { user: Me; encryptedPrivateKey: string };

export async function register(username: string, displayName: string, password: string) {
  const kdfSalt = c.newKdfSalt();
  const { authKey, masterKey } = await c.deriveFromPassword(password, kdfSalt, c.KDF_ITERATIONS);
  const identity = await c.generateIdentity();
  const encryptedPrivateKey = await c.encryptPrivateKey(identity.privateKey, masterKey);
  const res = await api<AuthResponse>("/api/auth/register", {
    body: {
      username, displayName, authKey, kdfSalt, kdfIterations: c.KDF_ITERATIONS,
      publicKey: identity.publicKeyB64, encryptedPrivateKey,
    },
  });
  // Store a non-extractable copy; the extractable original goes out of scope here.
  const stored = await c.decryptPrivateKey(encryptedPrivateKey, masterKey);
  await saveIdentity(res.user.id, stored);
  return { user: res.user, identity: stored };
}

export async function login(username: string, password: string) {
  const params = await api<{ kdfSalt: string; kdfIterations: number }>("/api/auth/params", { body: { username } });
  const { authKey, masterKey } = await c.deriveFromPassword(password, params.kdfSalt, params.kdfIterations);
  const res = await api<AuthResponse>("/api/auth/login", { body: { username, authKey } });
  const identity = await c.decryptPrivateKey(res.encryptedPrivateKey, masterKey);
  await saveIdentity(res.user.id, identity);
  return { user: res.user, identity };
}

/** Restores a session from the cookie plus the identity key stored on this device. */
export async function restore(): Promise<{ user: Me; identity: CryptoKey | null } | null> {
  const res = await api<{ user: Me | null }>("/api/me");
  if (!res.user) return null;
  return { user: res.user, identity: await loadIdentity(res.user.id) };
}

export async function logout() {
  await api("/api/auth/logout", { body: {} }).catch(() => undefined);
  await clearIdentities();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith("vt:")) sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export async function changePassword(me: Me, current: string, next: string) {
  const params = await api<{ kdfSalt: string; kdfIterations: number }>("/api/auth/params", { body: { username: me.username } });
  const old = await c.deriveFromPassword(current, params.kdfSalt, params.kdfIterations);
  // Re-derive the identity from the server copy so we can re-encrypt it under the new password.
  const login = await api<AuthResponse>("/api/auth/login", { body: { username: me.username, authKey: old.authKey } });
  const extractable = await c.decryptPrivateKey(login.encryptedPrivateKey, old.masterKey, true);
  const kdfSalt = c.newKdfSalt();
  const fresh = await c.deriveFromPassword(next, kdfSalt, c.KDF_ITERATIONS);
  await api("/api/me/password", {
    body: {
      currentAuthKey: old.authKey, newAuthKey: fresh.authKey, kdfSalt, kdfIterations: c.KDF_ITERATIONS,
      encryptedPrivateKey: await c.encryptPrivateKey(extractable, fresh.masterKey),
    },
  });
}

export function passwordStrength(pw: string) {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.split(" ").length >= 3) score++;
  return Math.min(4, score);
}
