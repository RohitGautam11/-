/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed API responses in a test script */
/**
 * End-to-end API test: drives real clients (WebCrypto in Node) against a running server.
 *   BASE_URL=http://localhost:3000 node scripts/e2e.test.mts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as c from "../lib/crypto.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const run = Date.now().toString(36);

type Client = { id: string; username: string; publicKey: string; identity: CryptoKey; cookie: string; password: string };

async function call<T = any>(client: Client | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(BASE + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(client ? { cookie: client.cookie } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data: data as T, setCookie: res.headers.get("set-cookie"), raw: text };
}

async function expectOk<T = any>(client: Client | null, path: string, init: Parameters<typeof call>[2] = {}) {
  const res = await call<T>(client, path, init);
  assert.ok(res.status < 300, `${init.method ?? "GET"} ${path} -> ${res.status} ${res.raw}`);
  return res;
}

async function register(name: string): Promise<Client> {
  const username = `${name}_${run}`;
  const password = `correct horse ${name} battery`;
  const salt = c.newKdfSalt();
  const { authKey, masterKey } = await c.deriveFromPassword(password, salt, 100_000);
  const identity = await c.generateIdentity();
  const res = await expectOk(null, "/api/auth/register", {
    body: {
      username, displayName: name[0].toUpperCase() + name.slice(1), authKey, kdfSalt: salt, kdfIterations: 100_000,
      publicKey: identity.publicKeyB64, encryptedPrivateKey: await c.encryptPrivateKey(identity.privateKey, masterKey),
    },
  });
  return {
    id: res.data.user.id, username, publicKey: identity.publicKeyB64, identity: identity.privateKey,
    cookie: res.setCookie!.split(";")[0], password,
  };
}

async function login(username: string, password: string) {
  const params = await expectOk(null, "/api/auth/params", { body: { username } });
  const { authKey, masterKey } = await c.deriveFromPassword(password, params.data.kdfSalt, params.data.kdfIterations);
  const res = await call(null, "/api/auth/login", { body: { username, authKey } });
  if (res.status !== 200) return { status: res.status };
  const identity = await c.decryptPrivateKey(res.data.encryptedPrivateKey, masterKey);
  return { status: 200, identity, cookie: res.setCookie!.split(";")[0], user: res.data.user };
}

async function wrapAll(raw: Uint8Array<ArrayBuffer>, conversationId: string, epoch: number, members: Client[]) {
  return Promise.all(members.map(async (m) => ({
    userId: m.id, wrappedKey: await c.wrapConversationKey(raw, m.publicKey, conversationId, epoch, m.id),
  })));
}

async function sync(client: Client, cursor = 0) {
  const all: any = { messages: [], conversations: [] };
  let more = true;
  while (more) {
    const res = await expectOk(client, `/api/sync?cursor=${cursor}`);
    all.messages.push(...res.data.messages);
    all.conversations.push(...res.data.conversations);
    cursor = res.data.cursor;
    more = res.data.more;
  }
  all.cursor = cursor;
  return all;
}

async function keyFor(client: Client, conv: any, epoch: number) {
  const entry = conv.keys.find((k: any) => k.epoch === epoch);
  assert.ok(entry, `missing key epoch ${epoch}`);
  return c.unwrapConversationKey(entry.wrappedKey, client.identity, conv.id, epoch, client.id);
}

async function envelope(key: CryptoKey, conversationId: string, epoch: number, sender: Client, payload: unknown) {
  const id = randomUUID();
  const sealed = await c.encryptJson(key, payload, c.messageAad(conversationId, epoch, sender.id, id));
  return { id, epoch, ...sealed };
}

async function open(client: Client, conv: any, m: any) {
  const key = await keyFor(client, conv, m.epoch);
  return c.decryptJson<any>(key, m.iv, m.ciphertext, c.messageAad(m.conversationId, m.epoch, m.senderId, m.id));
}

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log(`वार्तालाप e2e against ${BASE}`);
const health = await call(null, "/api/health");
assert.equal(health.status, 200, `health: ${health.raw}`);

const alice = await register("alice");
const bob = await register("bob");
const carol = await register("carol");
let direct: any;
let group: any;
const secret = `meet at the old fort at 7 — ${run}`;

await step("re-login decrypts the identity key; wrong password is rejected", async () => {
  const good = await login(bob.username, bob.password);
  assert.equal(good.status, 200);
  const bad = await login(bob.username, "not the password");
  assert.equal(bad.status, 401);
  const ghost = await call(null, "/api/auth/params", { body: { username: `ghost_${run}` } });
  assert.equal(ghost.status, 200, "unknown users still get (decoy) params");
  const dup = await call(null, "/api/auth/register", {
    body: { username: alice.username, displayName: "x", authKey: "a".repeat(64), kdfSalt: "AAAA", kdfIterations: 100000, publicKey: "AAAA", encryptedPrivateKey: "x".repeat(30) },
  });
  assert.equal(dup.status, 409);
});

await step("unauthenticated and cross-origin requests are refused", async () => {
  assert.equal((await call(null, "/api/sync")).status, 401);
  const xo = await call(alice, "/api/posts", { body: { body: "hi" }, headers: { origin: "https://evil.example" } });
  assert.equal(xo.status, 403);
});

await step("user search finds people by username", async () => {
  const res = await expectOk(alice, `/api/users/search?q=bob_${run}`);
  assert.equal(res.data.users[0].id, bob.id);
  assert.equal(res.data.users[0].publicKey, bob.publicKey);
});

await step("direct chat: only members can decrypt; server holds ciphertext only", async () => {
  const id = randomUUID();
  const raw = c.newConversationKey();
  const created = await expectOk(alice, "/api/conversations", {
    body: { kind: "direct", id, peerId: bob.id, keys: await wrapAll(raw, id, 1, [alice, bob]) },
  });
  assert.equal(created.data.id, id);
  const again = await expectOk(bob, "/api/conversations", {
    body: { kind: "direct", id: randomUUID(), peerId: alice.id, keys: await wrapAll(c.newConversationKey(), "x", 1, [bob, alice]) },
  });
  assert.equal(again.data.id, id, "a second direct chat between the same people resolves to the first");

  const key = await c.importConversationKey(raw);
  const env = await envelope(key, id, 1, alice, { t: "text", body: secret });
  await expectOk(alice, `/api/conversations/${id}/messages`, { body: env });

  const bobSync = await sync(bob);
  direct = bobSync.conversations.find((x: any) => x.id === id);
  assert.ok(direct, "bob sees the conversation");
  const msg = bobSync.messages.find((m: any) => m.id === env.id);
  assert.ok(msg, "bob receives the message");
  assert.ok(!JSON.stringify(bobSync).includes(secret), "plaintext never appears in API responses");
  assert.equal((await open(bob, direct, msg)).body, secret);

  // Someone outside the conversation can neither read nor post.
  const carolSync = await sync(carol);
  assert.ok(!carolSync.messages.some((m: any) => m.id === env.id));
  const intrude = await call(carol, `/api/conversations/${id}/messages`, { body: await envelope(key, id, 1, carol, { t: "text", body: "x" }) });
  assert.equal(intrude.status, 404);

  // Tampering with the authenticated context (claiming another sender) breaks decryption.
  await assert.rejects(c.decryptJson(await keyFor(bob, direct, 1), msg.iv, msg.ciphertext, c.messageAad(id, 1, bob.id, msg.id)));
});

await step("edit and delete-for-everyone", async () => {
  const key = await keyFor(bob, direct, 1);
  const env = await envelope(key, direct.id, 1, alice, { t: "text", body: "typo" });
  await expectOk(alice, `/api/conversations/${direct.id}/messages`, { body: env });
  const fixed = await c.encryptJson(key, { t: "text", body: "fixed" }, c.messageAad(direct.id, 1, alice.id, env.id));
  await expectOk(alice, `/api/messages/${env.id}`, { method: "PATCH", body: { epoch: 1, ...fixed } });
  assert.equal((await call(bob, `/api/messages/${env.id}`, { method: "PATCH", body: { epoch: 1, ...fixed } })).status, 403);
  let m = (await sync(bob)).messages.find((x: any) => x.id === env.id);
  assert.equal((await open(bob, direct, m)).body, "fixed");
  assert.ok(m.editedAt);
  await expectOk(alice, `/api/messages/${env.id}`, { method: "DELETE" });
  m = (await sync(bob)).messages.find((x: any) => x.id === env.id);
  assert.ok(m.deletedAt);
  assert.equal(m.ciphertext, null, "ciphertext is erased");
});

await step("group: leaving forces key rotation; leaver cannot read new messages", async () => {
  const id = randomUUID();
  const raw = c.newConversationKey();
  const key = await c.importConversationKey(raw);
  const meta = { epoch: 1, ...(await c.encryptJson(key, { name: "Weekend trip" }, c.metaAad(id, 1))) };
  await expectOk(alice, "/api/conversations", {
    body: { kind: "group", id, memberIds: [bob.id, carol.id], keys: await wrapAll(raw, id, 1, [alice, bob, carol]), encryptedMeta: JSON.stringify(meta) },
  });
  const carolView = (await sync(carol)).conversations.find((x: any) => x.id === id);
  const m = JSON.parse(carolView.encryptedMeta);
  assert.equal((await c.decryptJson<any>(await keyFor(carol, carolView, 1), m.iv, m.ciphertext, c.metaAad(id, 1))).name, "Weekend trip");

  await expectOk(carol, `/api/conversations/${id}/leave`, { body: {} });
  group = (await sync(bob)).conversations.find((x: any) => x.id === id);
  assert.equal(group.needsRotation, true);
  const stale = await call(bob, `/api/conversations/${id}/messages`, { body: await envelope(key, id, 1, bob, { t: "text", body: "x" }) });
  assert.equal(stale.status, 409, "sending is blocked until the key is rotated");

  const raw2 = c.newConversationKey();
  await expectOk(bob, `/api/conversations/${id}/rotate`, { body: { epoch: 2, keys: await wrapAll(raw2, id, 2, [alice, bob]) } });
  const replay = await call(alice, `/api/conversations/${id}/rotate`, { body: { epoch: 2, keys: await wrapAll(raw2, id, 2, [alice, bob]) } });
  assert.equal(replay.status, 409, "concurrent rotations cannot both win");

  const key2 = await c.importConversationKey(raw2);
  const env = await envelope(key2, id, 2, alice, { t: "text", body: "carol cannot see this" });
  await expectOk(alice, `/api/conversations/${id}/messages`, { body: env });
  assert.ok((await sync(bob)).messages.some((x: any) => x.id === env.id));
  const carolAfter = await sync(carol);
  assert.ok(!carolAfter.messages.some((x: any) => x.id === env.id), "leaver receives nothing new");
  assert.ok(!carolAfter.conversations.find((x: any) => x.id === id).keys.some((k: any) => k.epoch === 2), "leaver has no new key");
  group = (await sync(alice)).conversations.find((x: any) => x.id === id);
});

await step("group admin adds a member with rotation; newcomer cannot read history", async () => {
  const raw3 = c.newConversationKey();
  const body = { userIds: [carol.id], epoch: 3, keys: await wrapAll(raw3, group.id, 3, [alice, bob, carol]) };
  assert.equal((await call(bob, `/api/conversations/${group.id}/members`, { body })).status, 403, "plain members cannot add people");
  await expectOk(alice, `/api/conversations/${group.id}/members`, { body });
  const view = (await sync(carol)).conversations.find((x: any) => x.id === group.id);
  assert.deepEqual(view.keys.map((k: any) => k.epoch).sort(), [1, 3], "carol keeps epoch 1 from before, gets 3, never 2");
});

await step("wallet: pay inside chat with encrypted note; balances move atomically", async () => {
  const before = (await expectOk(bob, "/api/wallet")).data.balance;
  const key = await keyFor(bob, direct, 1);
  const note = await envelope(key, direct.id, 1, alice, { t: "payment", note: "chai money ☕" });
  const pay = { toUserId: bob.id, amount: 15000, idempotencyKey: randomUUID(), conversationId: direct.id, message: note };
  await expectOk(alice, "/api/wallet/transfer", { body: pay });
  const replay = await expectOk(alice, "/api/wallet/transfer", { body: pay });
  assert.equal(replay.data.replayed, true, "idempotent replay does not pay twice");
  assert.equal((await expectOk(bob, "/api/wallet")).data.balance, before + 15000);
  const card = (await sync(bob)).messages.find((m: any) => m.id === note.id);
  assert.equal(card.kind, "payment");
  assert.equal(card.ref.amount, 15000);
  assert.equal((await open(bob, direct, card)).note, "chai money ☕");
  const broke = await call(alice, "/api/wallet/transfer", { body: { ...pay, idempotencyKey: randomUUID(), amount: 9_999_999 } });
  assert.equal(broke.status, 400);
});

await step("split a bill in a group and pay a share", async () => {
  const g = (await sync(alice)).conversations.find((x: any) => x.id === group.id);
  const key = await keyFor(alice, g, 3);
  const msg = await envelope(key, group.id, 3, alice, { t: "request", note: "Dinner at Sharma ji" });
  await expectOk(alice, "/api/wallet/requests", {
    body: { conversationId: group.id, shares: [{ payerId: bob.id, amount: 30000 }, { payerId: carol.id, amount: 30000 }], message: msg },
  });
  let card = (await sync(bob)).messages.find((x: any) => x.id === msg.id);
  const mine = card.ref.items.find((i: any) => i.payerId === bob.id);
  assert.equal(mine.status, "pending");
  assert.equal((await call(carol, `/api/wallet/requests/${mine.id}`, { body: { action: "pay", idempotencyKey: randomUUID() } })).status, 403);
  await expectOk(bob, `/api/wallet/requests/${mine.id}`, { body: { action: "pay", idempotencyKey: randomUUID() } });
  card = (await sync(carol)).messages.find((x: any) => x.id === msg.id);
  assert.equal(card.ref.items.find((i: any) => i.payerId === bob.id).status, "paid");
});

await step("time capsule stays sealed for recipients until it opens", async () => {
  const key = await keyFor(bob, direct, 1);
  const env = await envelope(key, direct.id, 1, alice, { t: "text", body: "open me on your birthday" });
  await expectOk(alice, `/api/conversations/${direct.id}/messages`, { body: { ...env, revealAt: new Date(Date.now() + 3600_000).toISOString() } });
  const forBob = (await sync(bob)).messages.find((m: any) => m.id === env.id);
  assert.ok(forBob.revealAt);
  assert.equal(forBob.ciphertext, null, "recipient only sees the sealed envelope");
  const forAlice = (await sync(alice)).messages.find((m: any) => m.id === env.id);
  assert.ok(forAlice.ciphertext, "sender keeps their own copy");
});

await step("disappearing messages get an expiry", async () => {
  await expectOk(bob, `/api/conversations/${direct.id}`, { method: "PATCH", body: { disappearingSeconds: 3600 } });
  const env = await envelope(await keyFor(bob, direct, 1), direct.id, 1, bob, { t: "text", body: "poof" });
  const sent = await expectOk(bob, `/api/conversations/${direct.id}/messages`, { body: env });
  assert.ok(sent.data.expiresAt);
  await expectOk(bob, `/api/conversations/${direct.id}`, { method: "PATCH", body: { disappearingSeconds: null } });
});

await step("encrypted attachment upload is member-only", async () => {
  const file = await c.encryptFile(new TextEncoder().encode("hello file").buffer as ArrayBuffer);
  const up = await fetch(`${BASE}/api/blobs?conversationId=${direct.id}`, {
    method: "POST", headers: { cookie: alice.cookie, "content-type": "application/octet-stream" }, body: file.data,
  });
  assert.equal(up.status, 201);
  const { id } = await up.json();
  const asBob = await fetch(`${BASE}/api/blobs/${id}`, { headers: { cookie: bob.cookie } });
  assert.equal(asBob.status, 200);
  const plain = await c.decryptFile(await asBob.arrayBuffer(), file.key, file.iv);
  assert.equal(new TextDecoder().decode(plain), "hello file");
  assert.equal((await fetch(`${BASE}/api/blobs/${id}`, { headers: { cookie: carol.cookie } })).status, 404);
});

await step("posts, likes, comments, follows and feed", async () => {
  const post = await expectOk(alice, "/api/posts", { body: { body: `Namaste duniya ${run}`, mood: "gratitude" } });
  await expectOk(bob, "/api/follow", { body: { userId: alice.id, follow: true } });
  const feed = await expectOk(bob, "/api/posts?scope=feed");
  assert.ok(feed.data.posts.some((p: any) => p.id === post.data.post.id));
  const like = await expectOk(bob, `/api/posts/${post.data.post.id}/like`, { body: {} });
  assert.equal(like.data.likeCount, 1);
  await expectOk(bob, `/api/posts/${post.data.post.id}/comments`, { body: { body: "Sundar!" } });
  const comments = await expectOk(alice, `/api/posts/${post.data.post.id}/comments`);
  assert.equal(comments.data.comments[0].body, "Sundar!");
  const profile = await expectOk(bob, `/api/users/${alice.username}`);
  assert.equal(profile.data.stats.followers, 1);
  assert.equal(profile.data.followed, true);
});

console.log(`\n${passed} checks passed`);

