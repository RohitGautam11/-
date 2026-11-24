// Helpdesk rules shared by the server and the browser. No Node or DOM imports here.

export const PRIORITIES = [
  { id: "urgent", label: "Urgent", color: "#dc3b46" },
  { id: "high", label: "High", color: "#d9731f" },
  { id: "normal", label: "Normal", color: "#3567d6" },
  { id: "low", label: "Low", color: "#8a7f88" },
] as const;
export type Priority = (typeof PRIORITIES)[number]["id"];
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as [Priority, ...Priority[]];

export const TICKET_STATUSES = [
  { id: "open", label: "Open" },
  { id: "pending", label: "Waiting on customer" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number]["id"];
export const TICKET_STATUS_IDS = TICKET_STATUSES.map((s) => s.id) as [TicketStatus, ...TicketStatus[]];

export const CATEGORIES = [
  { id: "billing", label: "Billing & payments" },
  { id: "booking", label: "Booking & orders" },
  { id: "delivery", label: "Delivery & tracking" },
  { id: "technical", label: "Technical problem" },
  { id: "account", label: "Account & login" },
  { id: "feedback", label: "Feedback" },
  { id: "general", label: "General" },
] as const;
export type Category = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [Category, ...Category[]];

/** Minutes allowed for the first response and for resolution, per priority. Workspaces can override these. */
export type SlaPolicy = Record<Priority, { respond: number; resolve: number }>;
export const DEFAULT_SLA: SlaPolicy = {
  urgent: { respond: 60, resolve: 240 },
  high: { respond: 240, resolve: 1440 },
  normal: { respond: 480, resolve: 2880 },
  low: { respond: 1440, resolve: 4320 },
};

export function slaFor(policy: Partial<SlaPolicy> | undefined, priority: Priority) {
  const custom = policy?.[priority];
  const base = DEFAULT_SLA[priority];
  return {
    respond: clampMinutes(custom?.respond ?? base.respond),
    resolve: clampMinutes(custom?.resolve ?? base.resolve),
  };
}

function clampMinutes(n: number) {
  return Math.min(60 * 24 * 30, Math.max(5, Math.round(Number(n) || 60)));
}

// ── Smart triage ─────────────────────────────────────────────────────────────
// Rule-based and transparent: it reads the customer's words (English, Hindi and Hinglish)
// and suggests a priority, category and mood. Agents can always change what it picked.

const URGENT = ["urgent", "emergency", "asap", "immediately", "fraud", "scam", "stolen", "hacked", "outage", "not working at all", "stuck at airport", "turant", "jaldi", "तुरंत", "धोखा"];
const HIGH = ["refund", "charged twice", "double charge", "deducted", "complaint", "cancel", "broken", "failed", "error", "not received", "wrong", "missing", "damaged", "not working", "paisa wapas", "शिकायत"];
const NEGATIVE = ["angry", "worst", "terrible", "disappointed", "frustrated", "useless", "pathetic", "horrible", "unacceptable", "never again", "bakwas", "bekar", "ghatiya", "बेकार", "!!!"];
const POSITIVE = ["thank", "thanks", "great", "love", "awesome", "happy", "excellent", "amazing", "dhanyavaad", "shukriya", "धन्यवाद"];
const CATEGORY_WORDS: [Category, string[]][] = [
  ["billing", ["payment", "refund", "invoice", "charged", "charge", "price", "bill", "upi", "deducted", "emi", "gst", "paisa"]],
  ["booking", ["booking", "reservation", "reschedule", "seat", "hotel", "flight", "appointment", "slot", "date change", "cancel"]],
  ["delivery", ["delivery", "shipped", "courier", "order", "tracking", "parcel", "dispatch", "arrive"]],
  ["technical", ["app", "error", "bug", "crash", "otp", "not loading", "website", "not working", "glitch", "update"]],
  ["account", ["login", "password", "account", "sign in", "signup", "profile", "locked", "verify"]],
  ["feedback", ["suggestion", "feedback", "review", "idea", "improve"]],
];

const has = (text: string, words: string[]) => words.filter((w) => text.includes(w)).length;

export type Triage = { priority: Priority; category: Category; sentiment: "positive" | "neutral" | "negative"; reasons: string[] };

export function triage(subject: string, description = ""): Triage {
  const text = `${subject} ${description}`.toLowerCase();
  const reasons: string[] = [];
  const neg = has(text, NEGATIVE) + (/[A-Z]{6,}/.test(`${subject} ${description}`) ? 1 : 0);
  const pos = has(text, POSITIVE);
  const sentiment = neg > pos ? "negative" : pos > neg ? "positive" : "neutral";

  let priority: Priority = "normal";
  if (has(text, URGENT)) {
    priority = "urgent";
    reasons.push("urgent wording");
  } else if (has(text, HIGH)) {
    priority = "high";
    reasons.push("refund, failure or complaint");
  } else if (/\?$/.test(subject.trim()) && text.length < 140) {
    priority = "low";
    reasons.push("short question");
  }
  if (sentiment === "negative" && priority !== "urgent") {
    priority = priority === "low" ? "normal" : priority === "normal" ? "high" : "urgent";
    reasons.push("upset customer");
  }

  let category: Category = "general";
  let best = 0;
  for (const [id, words] of CATEGORY_WORDS) {
    const n = has(text, words);
    if (n > best) {
      best = n;
      category = id;
    }
  }
  return { priority, category, sentiment, reasons };
}

// ── Knowledge-base search ────────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "or", "my", "i", "me", "how", "do", "can", "what", "for", "in", "on", "it", "with", "not", "hai", "ka", "ki", "ke", "se", "mera", "meri"]);

export function keywords(text: string) {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 24);
}

/** Ranks articles by how many of the query's words appear in the title (x3) and body. */
export function rankArticles<T extends { title: string; body: string }>(articles: T[], query: string, limit = 5): T[] {
  const words = keywords(query);
  if (!words.length) return [];
  return articles
    .map((a) => {
      const title = a.title.toLowerCase();
      const body = a.body.toLowerCase();
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
      return { a, score };
    })
    .filter((x) => x.score >= 2)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.a);
}

/** Where a ticket stands against its SLA right now. */
export function slaState(t: { status: string; firstResponseDue: string | Date; resolveDue: string | Date; firstResponseAt: string | Date | null; resolvedAt?: string | Date | null }, now = Date.now()) {
  if (t.status === "resolved" || t.status === "closed") return { state: "met" as const, dueAt: null, label: "Done" };
  const responded = Boolean(t.firstResponseAt);
  const due = new Date(responded ? t.resolveDue : t.firstResponseDue).getTime();
  const left = due - now;
  const what = responded ? "resolve" : "reply";
  if (left < 0) return { state: "breached" as const, dueAt: due, label: `${what} overdue ${humanMinutes(-left)}` };
  if (left < 60 * 60_000) return { state: "soon" as const, dueAt: due, label: `${what} in ${humanMinutes(left)}` };
  return { state: "ok" as const, dueAt: due, label: `${what} in ${humanMinutes(left)}` };
}

export function humanMinutes(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
