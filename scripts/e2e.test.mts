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

// ── in-app calls (WebRTC signalling) ─────────────────────────────────────────

await step("calls: ring, relay signals peer-to-peer, answer, busy, hang up", async () => {
  const start = await expectOk(alice, "/api/calls", { body: { calleeId: bob.id, conversationId: direct.id, video: true } });
  const callId = start.data.call.id;
  assert.equal(start.data.call.status, "ringing");
  // Bob's device sees the ring.
  const ring = await expectOk(bob, "/api/calls/poll?after=0");
  assert.ok(ring.data.calls.some((x: any) => x.id === callId && x.status === "ringing" && !x.outgoing));
  // A third person can neither signal into the call nor call someone who's already ringing.
  assert.equal((await call(carol, `/api/calls/${callId}/signal`, { body: { type: "offer", payload: "{}" } })).status, 403);
  assert.equal((await call(carol, "/api/calls", { body: { calleeId: bob.id } })).status, 409);
  // Only people in the chat can be called through it.
  assert.equal((await call(carol, "/api/calls", { body: { calleeId: alice.id, conversationId: direct.id } })).status, 403);
  await expectOk(alice, `/api/calls/${callId}/signal`, { body: { type: "offer", payload: JSON.stringify({ type: "offer", sdp: "v=0" }) } });
  const sig = await expectOk(bob, `/api/calls/poll?after=${ring.data.cursor}`);
  assert.ok(sig.data.signals.some((s: any) => s.callId === callId && s.type === "offer"));
  assert.equal((await call(alice, `/api/calls/${callId}/answer`, { body: {} })).status, 403, "caller can't answer their own call");
  await expectOk(bob, `/api/calls/${callId}/answer`, { body: {} });
  await expectOk(bob, `/api/calls/${callId}/signal`, { body: { type: "answer", payload: JSON.stringify({ type: "answer", sdp: "v=0" }) } });
  const end = await expectOk(alice, `/api/calls/${callId}/end`, { body: {} });
  assert.equal(end.data.call.status, "ended");
  const history = await expectOk(bob, "/api/calls");
  assert.ok(history.data.calls.some((x: any) => x.id === callId && x.peer.id === alice.id));
  const ice = await expectOk(bob, "/api/calls/ice");
  assert.ok(ice.data.iceServers.length >= 1);
  const s = await sync(bob);
  assert.ok(s.messages.some((m: any) => m.kind === "system" && /Video call/.test(m.systemText ?? "")), "call summary appears in the chat");
});

// ── Business Suite ───────────────────────────────────────────────────────────

let ws = "";
await step("business: workspace with demo data, roles and number masking", async () => {
  const created = await expectOk(alice, "/api/biz", { body: { name: `Yatra ${run}`, industry: "travel", demo: true } });
  ws = created.data.id;
  const ov = await expectOk(alice, `/api/biz/${ws}`);
  assert.equal(ov.data.role, "owner");
  assert.equal(ov.data.lines[0].provider, "simulator");
  await expectOk(alice, `/api/biz/${ws}/members`, { body: { username: bob.username, role: "agent" } });
  const asOwner = await expectOk(alice, `/api/biz/${ws}/contacts`);
  const asAgent = await expectOk(bob, `/api/biz/${ws}/contacts`);
  assert.equal(asOwner.data.contacts.length, 8);
  assert.ok(asOwner.data.contacts.every((x: any) => /^\+91\d{10}$/.test(x.phone)), "owner sees full numbers");
  assert.ok(asAgent.data.contacts.every((x: any) => x.phone.includes("•")), "agent sees masked numbers");
  assert.equal((await call(carol, `/api/biz/${ws}`)).status, 404, "outsiders can't see the workspace");
  assert.equal((await call(bob, `/api/biz/${ws}/export`)).status, 403, "agents can't export");
  const csv = await fetch(`${BASE}/api/biz/${ws}/export`, { headers: { cookie: alice.cookie } });
  assert.match(await csv.text(), /^name,phone/);
});

await step("business: click-to-call with masking, outcome logged on the lead's timeline", async () => {
  const ov = await expectOk(bob, `/api/biz/${ws}`);
  const lineId = ov.data.lines[0].id;
  assert.equal((await call(bob, `/api/biz/${ws}/calls`, { body: { lineId, number: "+919999900000" } })).status, 403, "agents can't dial raw numbers");
  const lead = (await expectOk(bob, `/api/biz/${ws}/contacts?q=ananya`)).data.contacts[0];
  const placed = await expectOk(bob, `/api/biz/${ws}/calls`, { body: { lineId, contactId: lead.id } });
  assert.ok(placed.data.call.remoteNumber.includes("•"), "the agent's call log is masked too");
  const id = placed.data.call.id;
  await expectOk(bob, `/api/biz/${ws}/calls/${id}`, { method: "PATCH", body: { status: "in-progress" } });
  const done = await expectOk(bob, `/api/biz/${ws}/calls/${id}`, { method: "PATCH", body: { status: "completed", disposition: "Interested", notes: "Wants 5 nights" } });
  assert.equal(done.data.call.status, "completed");
  const detail = await expectOk(bob, `/api/biz/${ws}/contacts/${lead.id}`);
  assert.ok(detail.data.calls.some((x: any) => x.id === id && x.disposition === "Interested"));
  assert.ok(detail.data.activities.some((a: any) => /Interested/.test(a.body)));
});

await step("business: import, SMS/WhatsApp inbox with templates, follow-ups, analytics", async () => {
  const imp = await expectOk(alice, `/api/biz/${ws}/contacts`, {
    body: { contacts: [{ name: "Ravi Kumar", phone: "98765 11111", tags: ["Goa"] }, { name: "Ravi Kumar", phone: "+919876511111", company: "Kumar Tours" }, { name: "Bad", phone: "12" }] },
  });
  assert.deepEqual([imp.data.created, imp.data.updated, imp.data.errors.length], [1, 1, 1]);
  const ravi = (await expectOk(alice, `/api/biz/${ws}/contacts?q=goa`)).data.contacts.find((x: any) => x.phone === "+919876511111");
  assert.ok(ravi, "10-digit numbers become +91 and tags are searchable");
  const ov = await expectOk(alice, `/api/biz/${ws}`);
  await expectOk(alice, `/api/biz/${ws}/messages`, { body: { lineId: ov.data.lines[0].id, contactId: ravi.id, channel: "whatsapp", body: "Namaste {name}!" } });
  await new Promise((r) => setTimeout(r, 4500));
  const thread = await expectOk(alice, `/api/biz/${ws}/contacts/${ravi.id}`);
  assert.equal(thread.data.messages[0].body, "Namaste Ravi!", "{name} is filled in");
  assert.ok(thread.data.messages.some((m: any) => m.direction === "inbound"), "simulated customer reply arrives");
  await expectOk(alice, `/api/biz/${ws}/tasks`, { body: { title: "Send Goa options", dueAt: new Date(Date.now() + 3600_000).toISOString(), contactId: ravi.id } });
  const tasks = await expectOk(bob, `/api/biz/${ws}/tasks`);
  assert.ok(tasks.data.tasks.some((t: any) => t.title === "Send Goa options"));
  const stats = await expectOk(alice, `/api/biz/${ws}/analytics?days=7`);
  assert.equal(stats.data.daily.length, 7);
  assert.ok(stats.data.agents.find((a: any) => a.calls >= 1));
});

await step("business: social handles and multi-platform posts; carrier webhooks need a signature", async () => {
  await expectOk(alice, `/api/biz/${ws}/social/accounts`, { body: { platform: "instagram", handle: "https://instagram.com/yatra.sathi/" } });
  assert.equal((await call(bob, `/api/biz/${ws}/social/accounts`, { body: { platform: "x", handle: "x" } })).status, 403);
  const tooLong = await call(alice, `/api/biz/${ws}/social/posts`, { body: { body: "x".repeat(300), platforms: ["x"] } });
  assert.equal(tooLong.status, 400, "per-platform length limits are enforced");
  const post = await expectOk(alice, `/api/biz/${ws}/social/posts`, { body: { body: "Monsoon offer!", platforms: ["instagram", "x"], publishNow: true } });
  assert.ok(post.data.delivered === "manual" || post.data.delivered === "webhook");
  const social = await expectOk(alice, `/api/biz/${ws}/social`);
  assert.ok(social.data.accounts.some((a: any) => a.handle === "yatra.sathi"));
  const forged = await fetch(`${BASE}/api/telephony/twilio/sms`, { method: "POST", body: "From=%2B911&To=%2B912&Body=hi", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(forged.status, 403);
});

// ── Helpdesk, help centre, security ─────────────────────────────────────────

await step("helpdesk: smart triage, SLA, auto-assign, masked requester, replies set first response", async () => {
  const seeded = await expectOk(alice, `/api/biz/${ws}/tickets?view=open`);
  assert.ok(seeded.data.tickets.length >= 3, "demo workspace comes with sample tickets");
  const created = await expectOk(alice, `/api/biz/${ws}/tickets`, {
    body: { subject: "Refund not received, charged twice!!!", description: "Worst experience, very frustrated", requesterPhone: "+919812300077", requesterName: "Meera" },
  });
  assert.equal(created.data.priority, "urgent", "upset customer + refund → urgent");
  assert.equal(created.data.category, "billing");
  const id = created.data.id;
  const asAgent = await expectOk(bob, `/api/biz/${ws}/tickets/${id}`);
  assert.ok(asAgent.data.ticket.requesterPhone.includes("•"), "agents see masked requester numbers");
  assert.ok(new Date(asAgent.data.ticket.firstResponseDue).getTime() - Date.now() <= 61 * 60_000, "urgent SLA is 1 hour");
  assert.ok(asAgent.data.suggestions.some((s: any) => /refund/i.test(s.title)), "knowledge base suggests the refund article");
  assert.equal((await call(bob, `/api/biz/${ws}/tickets/${id}`, { method: "PATCH", body: { assigneeId: alice.id } })).status, 403, "agents can't assign to others");
  await expectOk(bob, `/api/biz/${ws}/tickets/${id}/reply`, { body: { body: "Checking this now", internal: true } });
  let d = await expectOk(alice, `/api/biz/${ws}/tickets/${id}`);
  assert.equal(d.data.ticket.firstResponseAt, null, "an internal note is not a first response");
  await expectOk(alice, `/api/biz/${ws}/tickets/${id}/reply`, { body: { body: "Refund started, ref R123" } });
  d = await expectOk(alice, `/api/biz/${ws}/tickets/${id}`);
  assert.ok(d.data.ticket.firstResponseAt, "a reply stops the first-response clock");
  assert.equal(d.data.ticket.status, "pending");
  const board = await expectOk(bob, `/api/biz/${ws}/helpdesk`);
  assert.ok(board.data.counts.open + board.data.counts.pending >= 1);
  assert.equal((await call(bob, `/api/biz/${ws}/tickets/${id}`, { method: "DELETE" })).status, 403);
});

await step("helpdesk: a missed call opens a callback ticket automatically", async () => {
  const sim = await expectOk(alice, `/api/biz/${ws}/calls/simulate-inbound`, { body: {} });
  const callbacks = await expectOk(alice, `/api/biz/${ws}/tickets?view=callbacks`);
  assert.ok(callbacks.data.tickets.some((t: any) => t.kind === "callback" && t.contactName === sim.data.contactName));
  assert.equal((await call(bob, `/api/biz/${ws}/calls/simulate-inbound`, { body: {} })).status, 403);
});

await step("help centre: off by default; customers search, raise, track, reply and rate without an account", async () => {
  assert.equal((await call(null, `/api/public/help/${ws}`)).status, 404, "closed until an admin turns it on");
  assert.equal((await call(bob, `/api/biz/${ws}`, { method: "PATCH", body: { helpCenter: true } })).status, 403);
  await expectOk(alice, `/api/biz/${ws}`, { method: "PATCH", body: { helpCenter: true, helpIntro: "We reply within an hour" } });
  const home = await expectOk(null, `/api/public/help/${ws}`);
  assert.equal(home.data.workspace.intro, "We reply within an hour");
  const found = await expectOk(null, `/api/public/help/${ws}?q=${encodeURIComponent("when will I get my refund")}`);
  assert.match(found.data.articles[0].title, /refund/i, "search ranks the right article first");
  const bot = await expectOk(null, `/api/public/help/${ws}/tickets`, { body: { name: "Bot", phone: "+919800000001", subject: "spam spam", website: "http://spam" } });
  assert.equal(bot.data.token, "", "honeypot: bots get nothing");
  assert.equal((await call(null, `/api/public/help/${ws}/tickets`, { body: { name: "No contact", subject: "Help me" } })).status, 400, "phone or email required");
  const raised = await expectOk(null, `/api/public/help/${ws}/tickets`, {
    body: { name: "Sunita", phone: "98123 00088", subject: "Booking date change", description: "Please move my trip to next week" },
  });
  const token = raised.data.token as string;
  assert.ok(token.length >= 30);
  assert.equal((await call(null, `/api/public/help/${ws}/tickets/${"x".repeat(32)}`)).status, 404, "unknown tokens reveal nothing");
  const list = await expectOk(alice, `/api/biz/${ws}/tickets?q=${encodeURIComponent("booking date change")}`);
  const internal = list.data.tickets[0];
  assert.equal(internal.channel, "help centre");
  await expectOk(alice, `/api/biz/${ws}/tickets/${internal.id}/reply`, { body: { body: "Team-only context", internal: true } });
  await expectOk(alice, `/api/biz/${ws}/tickets/${internal.id}/reply`, { body: { body: "Done, moved to the 19th!", status: "resolved" } });
  const tracked = await expectOk(null, `/api/public/help/${ws}/tickets/${token}`);
  assert.equal(tracked.data.ticket.status, "resolved");
  assert.ok(tracked.data.messages.some((m: any) => m.body === "Done, moved to the 19th!"));
  assert.ok(!tracked.data.messages.some((m: any) => m.body === "Team-only context"), "internal notes never reach the customer");
  await expectOk(null, `/api/public/help/${ws}/tickets/${token}/rate`, { body: { score: 5, comment: "Super quick" } });
  assert.equal((await call(null, `/api/public/help/${ws}/tickets/${token}/rate`, { body: { score: 1 } })).status, 400, "one rating per ticket");
  await expectOk(null, `/api/public/help/${ws}/tickets/${token}/reply`, { body: { body: "One more thing" } });
  assert.equal((await expectOk(null, `/api/public/help/${ws}/tickets/${token}`)).data.ticket.status, "open", "a customer reply reopens it");
  const board = await expectOk(alice, `/api/biz/${ws}/helpdesk`);
  assert.ok(board.data.csat.count >= 1);
});

await step("security: audit log, own follow-ups only, device list and remote sign-out, tour remembered", async () => {
  const log = await expectOk(alice, `/api/biz/${ws}/audit`);
  for (const action of ["workspace.create", "member.add", "contacts.export", "settings.update"]) {
    assert.ok(log.data.entries.some((e: any) => e.action === action), `audit log records ${action}`);
  }
  assert.equal((await call(bob, `/api/biz/${ws}/audit`)).status, 403);
  const task = (await expectOk(alice, `/api/biz/${ws}/tasks`)).data.tasks.find((t: any) => t.assigneeId === alice.id && !t.doneAt);
  assert.equal((await call(bob, `/api/biz/${ws}/tasks/${task.id}`, { method: "PATCH", body: { done: true } })).status, 403, "agents can't close a teammate's follow-up");

  const second = await login(carol.username, carol.password);
  assert.equal(second.status, 200);
  const devices = await expectOk(carol, "/api/me/sessions");
  assert.equal(devices.data.sessions.length, 2);
  assert.ok(devices.data.sessions.some((s: any) => s.current));
  const other = { ...carol, cookie: second.cookie! };
  await expectOk(carol, "/api/me/sessions", { method: "DELETE", body: { others: true } });
  assert.equal((await call(other, "/api/me")).data.user, null, "the other device is signed out at once");
  assert.equal((await expectOk(carol, "/api/me/sessions")).data.sessions.length, 1);

  assert.equal((await expectOk(carol, "/api/me")).data.user.tourDone, false, "new accounts see the tour");
  await expectOk(carol, "/api/me", { method: "PATCH", body: { tourDone: true } });
  const again = await login(carol.username, carol.password);
  assert.equal(again.user.tourDone, true, "skipping once hides it on every device");
});

console.log(`\n${passed} checks passed`);

