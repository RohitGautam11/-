import type { Conversation, Member, Message } from "./types";

const HIDDEN = new Set(["reaction", "vote", "pin"]);

export function peerOf(conv: Conversation, meId: string): Member | undefined {
  return conv.members.find((m) => m.id !== meId);
}

export function titleOf(conv: Conversation, meId: string) {
  if (conv.kind === "group") return conv.meta?.name || "Group";
  return peerOf(conv, meId)?.displayName ?? "Chat";
}

export function isVisible(m: Message, now = Date.now()) {
  if (m.expiresAt && new Date(m.expiresAt).getTime() < now) return false;
  if (m.kind !== "e2e") return true;
  if (m.deletedAt || m.sealed || m.status === "undecryptable") return true;
  return Boolean(m.payload && !HIDDEN.has(m.payload.t));
}

const byTime = (a: Message, b: Message) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq;

export type Timeline = {
  items: Message[];
  reactions: Map<string, Map<string, string[]>>;
  votes: Map<string, Map<string, number[]>>;
  pinned: Message | null;
};

/** Folds hidden event messages (reactions, votes, pins) onto the messages they target. */
export function timeline(conv: Conversation): Timeline {
  const all = [...conv.messages.values()].sort(byTime);
  const perUserReaction = new Map<string, string | null>();
  const votes = new Map<string, Map<string, number[]>>();
  let pinnedId: string | null = null;
  const items: Message[] = [];
  const now = Date.now();

  for (const m of all) {
    const p = m.payload;
    if (p?.t === "reaction") perUserReaction.set(`${p.target}|${m.senderId}`, p.emoji);
    else if (p?.t === "vote") {
      if (!votes.has(p.poll)) votes.set(p.poll, new Map());
      votes.get(p.poll)!.set(m.senderId, p.choices);
    } else if (p?.t === "pin") pinnedId = p.on ? p.target : pinnedId === p.target ? null : pinnedId;
    else if (isVisible(m, now)) items.push(m);
  }

  const reactions = new Map<string, Map<string, string[]>>();
  for (const [key, emoji] of perUserReaction) {
    if (!emoji) continue;
    const [target, user] = key.split("|");
    if (!reactions.has(target)) reactions.set(target, new Map());
    const byEmoji = reactions.get(target)!;
    byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), user]);
  }
  const pinned = pinnedId ? items.find((m) => m.id === pinnedId && !m.deletedAt) ?? null : null;
  return { items, reactions, votes, pinned };
}

export function lastMessage(conv: Conversation) {
  let last: Message | null = null;
  const now = Date.now();
  for (const m of conv.messages.values()) {
    if (!isVisible(m, now)) continue;
    if (!last || byTime(last, m) < 0) last = m;
  }
  return last;
}

export function unreadCount(conv: Conversation, meId: string) {
  const mine = conv.members.find((m) => m.id === meId);
  const read = mine?.lastReadSeq ?? 0;
  let n = 0;
  const now = Date.now();
  for (const m of conv.messages.values()) {
    if (m.senderId !== meId && m.kind !== "system" && !m.status && m.seq > read && isVisible(m, now)) n++;
  }
  return n;
}

/** How far the other members have read: "sent" → "delivered"-ish → "read" by everyone. */
export function receipt(conv: Conversation, m: Message, meId: string): "sending" | "failed" | "sent" | "read" {
  if (m.status === "sending") return "sending";
  if (m.status === "failed") return "failed";
  const others = conv.members.filter((x) => x.id !== meId && !x.leftAt);
  if (others.length && others.every((x) => x.lastReadSeq >= m.seq)) return "read";
  return "sent";
}

export function previewText(m: Message | null, conv: Conversation, meId: string): string {
  if (!m) return conv.kind === "group" ? "Group created" : "Say namaste 👋";
  if (m.kind === "system") return m.systemText ?? "";
  const who = conv.kind === "group" && m.senderId !== meId
    ? `${conv.members.find((x) => x.id === m.senderId)?.displayName.split(" ")[0] ?? "Someone"}: `
    : m.senderId === meId ? "You: " : "";
  if (m.deletedAt) return `${who}🚫 Message deleted`;
  if (m.sealed) return `${who}⏳ Time capsule`;
  if (m.status === "undecryptable") return `${who}🔒 Encrypted message`;
  const p = m.payload;
  if (!p) return "";
  switch (p.t) {
    case "text": return who + p.body;
    case "media": return who + (p.kind === "image" ? "📷 Photo" : p.kind === "voice" ? "🎙️ Voice note" : `📎 ${p.blob.name}`);
    case "poll": return `${who}📊 ${p.question}`;
    case "payment": return `${who}💸 Payment${m.ref && "amount" in m.ref ? ` · ${rupees(m.ref.amount)}` : ""}`;
    case "request": return `${who}🧾 Payment request`;
    default: return "";
  }
}

export function rupees(paise: number, opts: { sign?: boolean } = {}) {
  const value = (Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const sign = opts.sign ? (paise < 0 ? "−" : "+") : paise < 0 ? "−" : "";
  return `${sign}₹${value}`;
}

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function relativeDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: sameYear ? "short" : undefined, day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

export function listTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(iso);
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function lastSeen(iso?: string) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 150) return "online";
  return `last seen ${s < 86400 ? `today at ${clock(iso)}` : relativeDay(iso).toLowerCase()}`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
