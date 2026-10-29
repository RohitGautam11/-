import * as c from "../crypto";
import { api, HttpError } from "./api";
import type {
  BlobRef, Conversation, GroupMeta, Me, Member, Message, Payload, PublicUser, WireConversation, WireMessage,
} from "./types";

type SyncResponse = { cursor: number; more: boolean; messages: WireMessage[]; conversations: WireConversation[] };
type Listener = () => void;
export type IncomingEvent = { conversation: Conversation; message: Message };

const HIDDEN_TYPES = new Set(["reaction", "vote", "pin"]);
const uuid = () => globalThis.crypto.randomUUID();

/**
 * Client-side heart of the app: keeps conversations in sync, holds unwrapped keys in memory,
 * encrypts everything before it leaves the device and decrypts everything that arrives.
 */
export class Engine {
  conversations = new Map<string, Conversation>();
  cursor = 0;
  ready = false;
  online = true;
  version = 0;

  private listeners = new Set<Listener>();
  private incoming = new Set<(e: IncomingEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private failures = 0;
  private activeConversation: string | null = null;
  private rotating = new Set<string>();
  private blobCache = new Map<string, Promise<string>>();
  private pins: Record<string, string>;

  constructor(public me: Me, private identity: CryptoKey, private onSignedOut: () => void) {
    this.pins = readPins(me.id);
  }

  // ── subscription (useSyncExternalStore) ────────────────────────────────────
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;
  onIncoming(fn: (e: IncomingEvent) => void) {
    this.incoming.add(fn);
    return () => {
      this.incoming.delete(fn);
    };
  }
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start() {
    this.stopped = false;
    void this.sync();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") window.addEventListener("online", this.onVisibility);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") window.removeEventListener("online", this.onVisibility);
    for (const url of this.blobCache.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }

  setActiveConversation(id: string | null) {
    this.activeConversation = id;
    if (id) this.markRead(id);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") void this.sync();
  };

  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const base = hidden ? 20_000 : this.activeConversation ? 2000 : 4000;
    const delay = this.failures ? Math.min(30_000, base * 2 ** this.failures) : base;
    this.timer = setTimeout(() => void this.sync(), delay);
  }

  /** Pulls every change since the last cursor. Concurrent calls coalesce into one extra round. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.again = false;
          let more = true;
          while (more) {
            const res = await api<SyncResponse>(`/api/sync?cursor=${this.cursor}`);
            await this.apply(res);
            this.cursor = res.cursor;
            more = res.more;
          }
        } while (this.again);
        this.failures = 0;
        if (!this.online || !this.ready) {
          this.online = true;
          this.ready = true;
          this.emit();
        }
        void this.completePendingRotations();
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          this.stop();
          this.onSignedOut();
          return;
        }
        this.failures++;
        if (this.online) {
          this.online = false;
          this.emit();
        }
      } finally {
        this.syncing = null;
        this.schedule();
      }
    })();
    return this.syncing;
  }

  private async apply(res: SyncResponse) {
    for (const wire of res.conversations) await this.applyConversation(wire);
    const fresh: IncomingEvent[] = [];
    for (const wire of res.messages) {
      const conv = this.conversations.get(wire.conversationId);
      if (!conv) continue;
      const known = conv.messages.get(wire.id);
      if (known && known.seq >= wire.seq && !known.status) continue;
      const message = await this.decrypt(conv, wire);
      conv.messages.set(wire.id, message);
      const visible = message.kind !== "e2e" || (message.payload && !HIDDEN_TYPES.has(message.payload.t));
      if (this.ready && !known && wire.senderId !== this.me.id && visible) fresh.push({ conversation: conv, message });
    }
    if (res.conversations.length || res.messages.length) {
      if (this.activeConversation && res.messages.some((m) => m.conversationId === this.activeConversation)) {
        this.markRead(this.activeConversation);
      }
      this.emit();
    }
    for (const event of fresh) for (const fn of this.incoming) fn(event);
  }

  private async applyConversation(wire: WireConversation) {
    const existing = this.conversations.get(wire.id);
    const conv: Conversation = existing ?? {
      id: wire.id, kind: wire.kind, createdBy: wire.createdBy, keyEpoch: wire.keyEpoch, needsRotation: wire.needsRotation,
      disappearingSeconds: wire.disappearingSeconds, role: wire.role, leftAt: wire.leftAt, createdAt: wire.createdAt,
      members: [], meta: null, encryptedMeta: null, keys: new Map(), wrapped: new Map(), messages: new Map(), keyWarning: null,
    };
    Object.assign(conv, {
      keyEpoch: wire.keyEpoch, needsRotation: wire.needsRotation, disappearingSeconds: wire.disappearingSeconds,
      role: wire.role, leftAt: wire.leftAt, members: wire.members,
    });
    for (const k of wire.keys) {
      if (conv.keys.has(k.epoch)) continue;
      conv.wrapped.set(k.epoch, k.wrappedKey);
      try {
        conv.keys.set(k.epoch, await c.unwrapConversationKey(k.wrappedKey, this.identity, conv.id, k.epoch, this.me.id));
      } catch {
        // A key we cannot open was not made for this identity; messages under it stay undecryptable.
      }
    }
    if (wire.encryptedMeta && wire.encryptedMeta !== conv.encryptedMeta) {
      conv.encryptedMeta = wire.encryptedMeta;
      conv.meta = await this.decryptMeta(conv, wire.encryptedMeta);
    }
    conv.keyWarning = this.checkPins(conv.members);
    this.conversations.set(conv.id, conv);
    // Retry anything that arrived before its key did.
    for (const [id, m] of conv.messages) {
      if (m.status === "undecryptable" && m.wire && conv.keys.has(m.epoch)) conv.messages.set(id, await this.decrypt(conv, m.wire));
    }
  }

  private async decryptMeta(conv: Conversation, encryptedMeta: string): Promise<GroupMeta | null> {
    try {
      const { epoch, iv, ciphertext } = JSON.parse(encryptedMeta) as { epoch: number; iv: string; ciphertext: string };
      const key = conv.keys.get(epoch);
      if (!key) return null;
      return await c.decryptJson<GroupMeta>(key, iv, ciphertext, c.metaAad(conv.id, epoch));
    } catch {
      return null;
    }
  }

  private async decrypt(conv: Conversation, wire: WireMessage): Promise<Message> {
    const { iv, ciphertext, ...rest } = wire;
    const base: Message = { ...rest, payload: null };
    if (wire.kind === "system" || wire.deletedAt) return base;
    if (!iv || !ciphertext) return { ...base, sealed: Boolean(wire.revealAt) };
    const key = conv.keys.get(wire.epoch);
    if (!key) return { ...base, status: "undecryptable", wire };
    try {
      const payload = await c.decryptJson<Payload>(key, iv, ciphertext, c.messageAad(conv.id, wire.epoch, wire.senderId, wire.id));
      return { ...base, payload };
    } catch {
      return { ...base, status: "undecryptable", wire };
    }
  }

  /** Trust-on-first-use: remember each contact's identity key and warn if it ever changes. */
  private checkPins(members: Member[]) {
    let warning: string | null = null;
    let changed = false;
    for (const m of members) {
      if (m.id === this.me.id) continue;
      const pinned = this.pins[m.id];
      if (!pinned) {
        this.pins[m.id] = m.publicKey;
        changed = true;
      } else if (pinned !== m.publicKey) {
        warning = `${m.displayName}'s security key is different from the one this device saw before. Verify the safety number before sharing anything sensitive.`;
      }
    }
    if (changed) writePins(this.me.id, this.pins);
    return warning;
  }

  // ── key management ─────────────────────────────────────────────────────────
  private async wrapFor(raw: Uint8Array<ArrayBuffer>, conversationId: string, epoch: number, members: { id: string; publicKey: string }[]) {
    return Promise.all(members.map(async (m) => ({
      userId: m.id,
      wrappedKey: await c.wrapConversationKey(raw, m.publicKey, conversationId, epoch, m.id),
    })));
  }

  private async sealMeta(key: CryptoKey, conversationId: string, epoch: number, meta: GroupMeta) {
    return JSON.stringify({ epoch, ...(await c.encryptJson(key, meta, c.metaAad(conversationId, epoch))) });
  }

  private async nextEpoch(conv: Conversation, members: { id: string; publicKey: string }[]) {
    const epoch = conv.keyEpoch + 1;
    const raw = c.newConversationKey();
    const keys = await this.wrapFor(raw, conv.id, epoch, members);
    const key = await c.importConversationKey(raw);
    const encryptedMeta = conv.kind === "group" && conv.meta ? await this.sealMeta(key, conv.id, epoch, conv.meta) : undefined;
    raw.fill(0);
    return { epoch, keys, encryptedMeta };
  }

  private activeMembers(conv: Conversation) {
    return conv.members.filter((m) => !m.leftAt);
  }

  /** After someone leaves, a remaining member must pick a fresh key the leaver never sees. */
  private async completePendingRotations() {
    for (const conv of this.conversations.values()) {
      if (!conv.needsRotation || conv.leftAt || this.rotating.has(conv.id)) continue;
      this.rotating.add(conv.id);
      try {
        await new Promise((r) => setTimeout(r, Math.random() * 1500));
        await api(`/api/conversations/${conv.id}/rotate`, { body: await this.nextEpoch(conv, this.activeMembers(conv)) });
      } catch {
        // Someone else rotated first (409) — the next sync brings their key.
      } finally {
        this.rotating.delete(conv.id);
      }
      void this.sync();
    }
  }

  private async ensureSendable(conv: Conversation) {
    if (conv.leftAt) throw new HttpError(403, "You are no longer part of this conversation.");
    if (conv.needsRotation) {
      await this.completePendingRotations();
      await this.sync();
    }
    const key = conv.keys.get(conv.keyEpoch);
    if (!key) {
      await this.sync();
      const retry = conv.keys.get(conv.keyEpoch);
      if (!retry) throw new HttpError(409, "Waiting for the latest encryption key. Try again in a moment.");
      return retry;
    }
    return key;
  }

  private async seal(conv: Conversation, payload: Payload, id = uuid()) {
    const key = await this.ensureSendable(conv);
    const epoch = conv.keyEpoch;
    const sealed = await c.encryptJson(key, payload, c.messageAad(conv.id, epoch, this.me.id, id));
    return { id, epoch, ...sealed };
  }

  /** Retries once when the server reports a stale key epoch (someone rotated meanwhile). */
  private async withFreshKey<T>(conv: Conversation, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError && error.code === "stale_epoch") {
        await this.sync();
        return fn();
      }
      throw error;
    }
  }

  // ── conversations ──────────────────────────────────────────────────────────
  findDirect(userId: string) {
    for (const conv of this.conversations.values()) {
      if (conv.kind === "direct" && conv.members.some((m) => m.id === userId)) return conv;
    }
    return null;
  }

  async openDirect(peer: PublicUser) {
    const existing = this.findDirect(peer.id);
    if (existing) return existing.id;
    const id = uuid();
    const raw = c.newConversationKey();
    const keys = await this.wrapFor(raw, id, 1, [this.me, peer]);
    raw.fill(0);
    const res = await api<{ id: string }>("/api/conversations", { body: { kind: "direct", id, peerId: peer.id, keys } });
    await this.sync();
    return res.id;
  }

  async createGroup(meta: GroupMeta, people: PublicUser[]) {
    const id = uuid();
    const raw = c.newConversationKey();
    const keys = await this.wrapFor(raw, id, 1, [this.me, ...people]);
    const key = await c.importConversationKey(raw);
    raw.fill(0);
    await api("/api/conversations", {
      body: { kind: "group", id, memberIds: people.map((p) => p.id), keys, encryptedMeta: await this.sealMeta(key, id, 1, meta) },
    });
    await this.sync();
    return id;
  }

  async updateGroupMeta(conversationId: string, meta: GroupMeta) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      const key = await this.ensureSendable(conv);
      const value = await this.sealMeta(key, conv.id, conv.keyEpoch, meta);
      await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { encryptedMeta: { epoch: conv.keyEpoch, value } } });
    });
    await this.sync();
  }

  async addMembers(conversationId: string, people: PublicUser[]) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      const rotation = await this.nextEpoch(conv, [...this.activeMembers(conv), ...people]);
      await api(`/api/conversations/${conv.id}/members`, { body: { ...rotation, userIds: people.map((p) => p.id) } });
    });
    await this.sync();
  }

  async removeMember(conversationId: string, userId: string) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      const rotation = await this.nextEpoch(conv, this.activeMembers(conv).filter((m) => m.id !== userId));
      await api(`/api/conversations/${conv.id}/remove`, { body: { ...rotation, userId } });
    });
    await this.sync();
  }

  /** Admin-initiated rotation to a fresh key for the same members (e.g. after a lost phone). */
  async refreshKey(conversationId: string) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      await api(`/api/conversations/${conv.id}/rotate`, { body: await this.nextEpoch(conv, this.activeMembers(conv)) });
    });
    await this.sync();
  }

  async setRole(conversationId: string, userId: string, role: "admin" | "member") {
    await api(`/api/conversations/${conversationId}/role`, { body: { userId, role } });
    await this.sync();
  }

  async leave(conversationId: string) {
    await api(`/api/conversations/${conversationId}/leave`, { body: {} });
    await this.sync();
  }

  async setDisappearing(conversationId: string, seconds: number | null) {
    await api(`/api/conversations/${conversationId}`, { method: "PATCH", body: { disappearingSeconds: seconds } });
    await this.sync();
  }

  markRead(conversationId: string) {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.leftAt) return;
    let max = 0;
    for (const m of conv.messages.values()) if (!m.status && m.seq > max) max = m.seq;
    const mine = conv.members.find((m) => m.id === this.me.id);
    if (!mine || max <= mine.lastReadSeq) return;
    mine.lastReadSeq = max;
    this.emit();
    void api(`/api/conversations/${conversationId}/read`, { body: { seq: max } }).catch(() => undefined);
  }

  // ── messages ───────────────────────────────────────────────────────────────
  async send(conversationId: string, payload: Payload, options: { revealAt?: Date } = {}) {
    const conv = this.require(conversationId);
    const id = uuid();
    const optimistic: Message = {
      id, conversationId, senderId: this.me.id, kind: "e2e", epoch: conv.keyEpoch, systemText: null, ref: null,
      revealAt: options.revealAt?.toISOString() ?? null, expiresAt: null, editedAt: null, deletedAt: null,
      seq: Number.MAX_SAFE_INTEGER, createdAt: new Date().toISOString(), payload, status: "sending",
    };
    if (!HIDDEN_TYPES.has(payload.t)) {
      conv.messages.set(id, optimistic);
      this.emit();
    }
    try {
      await this.withFreshKey(conv, async () => {
        const env = await this.seal(conv, payload, id);
        await api(`/api/conversations/${conv.id}/messages`, { body: { ...env, revealAt: options.revealAt?.toISOString() } });
      });
      void this.sync();
    } catch (error) {
      if (!HIDDEN_TYPES.has(payload.t)) {
        conv.messages.set(id, { ...optimistic, status: "failed" });
        this.emit();
      }
      throw error;
    }
  }

  async retry(conversationId: string, messageId: string) {
    const conv = this.require(conversationId);
    const m = conv.messages.get(messageId);
    if (!m?.payload || m.status !== "failed") return;
    conv.messages.delete(messageId);
    await this.send(conversationId, m.payload, { revealAt: m.revealAt ? new Date(m.revealAt) : undefined });
  }

  discard(conversationId: string, messageId: string) {
    this.conversations.get(conversationId)?.messages.delete(messageId);
    this.emit();
  }

  async edit(conversationId: string, messageId: string, payload: Payload) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      const { id: _ignored, ...env } = await this.seal(conv, payload, messageId);
      void _ignored;
      await api(`/api/messages/${messageId}`, { method: "PATCH", body: env });
    });
    await this.sync();
  }

  async remove(conversationId: string, message: Message) {
    const blob = message.payload?.t === "media" ? `?blobs=${message.payload.blob.id}` : "";
    await api(`/api/messages/${message.id}${blob}`, { method: "DELETE" });
    await this.sync();
    void conversationId;
  }

  react(conversationId: string, target: string, emoji: string | null) {
    return this.send(conversationId, { t: "reaction", target, emoji });
  }

  vote(conversationId: string, poll: string, choices: number[]) {
    return this.send(conversationId, { t: "vote", poll, choices });
  }

  pin(conversationId: string, target: string, on: boolean) {
    return this.send(conversationId, { t: "pin", target, on });
  }

  // ── attachments ────────────────────────────────────────────────────────────
  async upload(conversationId: string, file: Blob, info: Omit<BlobRef, "id" | "key" | "iv" | "size">): Promise<BlobRef> {
    const sealed = await c.encryptFile(await file.arrayBuffer());
    const res = await api<{ id: string }>(`/api/blobs?conversationId=${conversationId}`, {
      raw: sealed.data,
      headers: { "content-type": "application/octet-stream" },
    });
    return { ...info, id: res.id, key: sealed.key, iv: sealed.iv, size: file.size };
  }

  /** Downloads, decrypts and caches an attachment as an object URL. */
  attachmentUrl(ref: BlobRef) {
    let url = this.blobCache.get(ref.id);
    if (!url) {
      url = (async () => {
        const res = await fetch(`/api/blobs/${ref.id}`, { credentials: "same-origin" });
        if (!res.ok) throw new Error("Attachment unavailable");
        const plain = await c.decryptFile(await res.arrayBuffer(), ref.key, ref.iv);
        return URL.createObjectURL(new Blob([plain], { type: safeMime(ref.mime) }));
      })();
      url.catch(() => this.blobCache.delete(ref.id));
      this.blobCache.set(ref.id, url);
    }
    return url;
  }

  // ── payments ───────────────────────────────────────────────────────────────
  async pay(conversationId: string, toUserId: string, amountPaise: number, note: string) {
    const conv = this.require(conversationId);
    const idempotencyKey = uuid();
    await this.withFreshKey(conv, async () => {
      const message = await this.seal(conv, { t: "payment", note: note || undefined });
      await api("/api/wallet/transfer", { body: { toUserId, amount: amountPaise, idempotencyKey, conversationId, message } });
    });
    await this.sync();
  }

  async requestMoney(conversationId: string, shares: { payerId: string; amount: number }[], note: string) {
    const conv = this.require(conversationId);
    await this.withFreshKey(conv, async () => {
      const message = await this.seal(conv, { t: "request", note: note || undefined });
      await api("/api/wallet/requests", { body: { conversationId, shares, message } });
    });
    await this.sync();
  }

  async resolveRequest(requestId: string, action: "pay" | "decline" | "cancel") {
    await api(`/api/wallet/requests/${requestId}`, {
      body: action === "pay" ? { action, idempotencyKey: uuid() } : { action },
    });
    await this.sync();
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  require(conversationId: string) {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new HttpError(404, "Conversation not found.");
    return conv;
  }

  safetyNumber(peer: { publicKey: string }) {
    return c.safetyNumber(this.me.publicKey, peer.publicKey);
  }

  /** Marks a contact's current key as verified/accepted on this device. */
  acceptKey(member: Member) {
    this.pins[member.id] = member.publicKey;
    writePins(this.me.id, this.pins);
    for (const conv of this.conversations.values()) conv.keyWarning = this.checkPins(conv.members);
    this.emit();
  }
}

/**
 * The MIME type comes from the (untrusted) sender. Anything that a browser could render as an
 * active document in our origin — HTML, SVG, XML, JS — is downgraded to a plain download.
 */
function safeMime(mime: string) {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (/^(image\/(jpeg|png|webp|gif|avif|heic)|audio\/[\w.+-]+|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(m)) return m;
  return "application/octet-stream";
}

function readPins(userId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(`vt:pins:${userId}`) ?? "{}");
  } catch {
    return {};
  }
}

function writePins(userId: string, pins: Record<string, string>) {
  try {
    localStorage.setItem(`vt:pins:${userId}`, JSON.stringify(pins));
  } catch {
    // storage unavailable (private mode); warnings simply won't persist
  }
}
