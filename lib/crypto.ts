/**
 * वार्तालाप end-to-end encryption (WebCrypto only, runs in browsers and Node 20+).
 *
 *  password ──PBKDF2-SHA256──► 512 bits ─┬─► auth key (sent to server, which scrypt-hashes it)
 *                                        └─► master key (never leaves the device)
 *  identity: ECDH P-256 key pair; private half stored on the server encrypted by the master key
 *  conversation key: random AES-256-GCM per key epoch, wrapped for each member with
 *                    ephemeral ECDH → HKDF-SHA256 → AES-GCM
 *  messages / attachments: AES-256-GCM with authenticated context (conversation, epoch, sender, id)
 */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITERATIONS = 310_000;

// ── encoding helpers ──────────────────────────────────────────────────────────

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ── password-derived keys ─────────────────────────────────────────────────────

export function newKdfSalt() {
  return toB64(randomBytes(16));
}

export async function deriveFromPassword(password: string, saltB64: string, iterations = KDF_ITERATIONS) {
  const base = await subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, base, 512),
  );
  const authKey = toHex(bits.subarray(0, 32));
  const masterKey = await subtle.importKey("raw", bits.subarray(32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  bits.fill(0);
  return { authKey, masterKey };
}

// ── identity keys ─────────────────────────────────────────────────────────────

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function generateIdentity() {
  const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  return {
    privateKey: pair.privateKey,
    publicKeyB64: toB64(await subtle.exportKey("spki", pair.publicKey)),
  };
}

export async function encryptPrivateKey(privateKey: CryptoKey, masterKey: CryptoKey) {
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", privateKey));
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("vartalap/identity/v1") }, masterKey, pkcs8);
  pkcs8.fill(0);
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(ct) });
}

/**
 * Re-imports the identity as NON-extractable by default, so even page scripts cannot export it
 * afterwards. Only a password change asks for an extractable copy, to re-encrypt it.
 */
export async function decryptPrivateKey(blob: string, masterKey: CryptoKey, extractable = false) {
  const { iv, ct } = JSON.parse(blob) as { iv: string; ct: string };
  const pkcs8 = new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode("vartalap/identity/v1") }, masterKey, fromB64(ct)),
  );
  const key = await subtle.importKey("pkcs8", pkcs8, ECDH, extractable, ["deriveBits"]);
  pkcs8.fill(0);
  return key;
}

const publicKeyCache = new Map<string, Promise<CryptoKey>>();
export function importPublicKey(spkiB64: string) {
  let key = publicKeyCache.get(spkiB64);
  if (!key) {
    key = subtle.importKey("spki", fromB64(spkiB64), ECDH, true, []);
    publicKeyCache.set(spkiB64, key);
  }
  return key;
}

// ── conversation keys ─────────────────────────────────────────────────────────

const AES = { name: "AES-GCM", length: 256 } as const;
const keyAad = (conversationId: string, epoch: number, userId: string) => enc.encode(`vartalap/key/v1|${conversationId}|${epoch}|${userId}`);

export function newConversationKey() {
  return randomBytes(32);
}

export function importConversationKey(raw: Uint8Array<ArrayBuffer>) {
  return subtle.importKey("raw", raw, AES, false, ["encrypt", "decrypt"]);
}

async function wrappingKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array<ArrayBuffer>) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("vartalap/wrap/v1") },
    hkdf, AES, false, ["encrypt", "decrypt"],
  );
}

/** Seals a raw conversation key so only the holder of `recipientPublicKeyB64` can open it. */
export async function wrapConversationKey(
  raw: Uint8Array<ArrayBuffer>, recipientPublicKeyB64: string, conversationId: string, epoch: number, userId: string,
) {
  const ephemeral = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const salt = randomBytes(16);
  const key = await wrappingKey(ephemeral.privateKey, await importPublicKey(recipientPublicKeyB64), salt);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: keyAad(conversationId, epoch, userId) }, key, raw);
  return JSON.stringify({
    v: 1,
    e: toB64(await subtle.exportKey("spki", ephemeral.publicKey)),
    s: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  });
}

export async function unwrapConversationKey(
  wrapped: string, identity: CryptoKey, conversationId: string, epoch: number, userId: string,
) {
  const { e, s, iv, ct } = JSON.parse(wrapped) as { e: string; s: string; iv: string; ct: string };
  const key = await wrappingKey(identity, await importPublicKey(e), fromB64(s));
  const raw = new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: keyAad(conversationId, epoch, userId) }, key, fromB64(ct)),
  );
  const imported = await importConversationKey(raw);
  raw.fill(0);
  return imported;
}

// ── messages ──────────────────────────────────────────────────────────────────

export const messageAad = (conversationId: string, epoch: number, senderId: string, messageId: string) =>
  `vartalap/msg/v1|${conversationId}|${epoch}|${senderId}|${messageId}`;
export const metaAad = (conversationId: string, epoch: number) => `vartalap/meta/v1|${conversationId}|${epoch}`;

export async function encryptJson(key: CryptoKey, value: unknown, aad: string) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ciphertext: toB64(ct) };
}

export async function decryptJson<T>(key: CryptoKey, iv: string, ciphertext: string, aad: string): Promise<T> {
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(aad) }, key, fromB64(ciphertext));
  return JSON.parse(dec.decode(pt)) as T;
}

// ── attachments: every file gets its own random key, carried inside the message ──

export async function encryptFile(data: ArrayBuffer) {
  const raw = randomBytes(32);
  const key = await subtle.importKey("raw", raw, AES, false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { key: toB64(raw), iv: toB64(iv), data: new Uint8Array(ct) };
}

export async function decryptFile(data: ArrayBuffer, keyB64: string, ivB64: string) {
  const key = await subtle.importKey("raw", fromB64(keyB64), AES, false, ["decrypt"]);
  return subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, data);
}

// ── verification ──────────────────────────────────────────────────────────────

/** A 60-digit safety number both people can compare in person. Order-independent. */
export async function safetyNumber(publicKeyA: string, publicKeyB: string) {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const material = new Uint8Array([...fromB64(first), ...fromB64(second)]);
  let digest = new Uint8Array(await subtle.digest("SHA-256", material));
  // Iterate to make brute-forcing a colliding key pair expensive.
  for (let i = 0; i < 1024; i++) digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array([...digest, ...material])));
  const digits: string[] = [];
  for (let i = 0; i < 12; i++) {
    const chunk = ((digest[i * 2] << 16) | (digest[i * 2 + 1] << 8) | digest[(i + 12) % 32]) % 100000;
    digits.push(chunk.toString().padStart(5, "0"));
  }
  return digits;
}

export async function keyFingerprint(publicKeyB64: string) {
  return toHex(new Uint8Array(await subtle.digest("SHA-256", fromB64(publicKeyB64)))).slice(0, 32);
}
