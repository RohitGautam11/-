// Shared by the server and the browser. No Node or DOM imports here.

export const STAGES = [
  { id: "new", label: "New lead", color: "#6b7cff" },
  { id: "contacted", label: "Contacted", color: "#0b9cb0" },
  { id: "qualified", label: "Qualified", color: "#b7791f" },
  { id: "proposal", label: "Quote sent", color: "#c43c9b" },
  { id: "won", label: "Won", color: "#138a4b" },
  { id: "lost", label: "Lost", color: "#8a7f88" },
] as const;
export type Stage = (typeof STAGES)[number]["id"];
export const STAGE_IDS = STAGES.map((s) => s.id) as [Stage, ...Stage[]];

export const DISPOSITIONS = [
  "Interested", "Call back later", "Booked / converted", "Sent quote", "Not interested", "Wrong number", "No answer", "Voicemail",
] as const;

export const INDUSTRIES = [
  { id: "travel", label: "Travel agency" },
  { id: "real_estate", label: "Real estate" },
  { id: "education", label: "Coaching / education" },
  { id: "healthcare", label: "Clinic / healthcare" },
  { id: "retail", label: "Retail / e-commerce" },
  { id: "services", label: "Local services" },
  { id: "agency", label: "Marketing agency" },
  { id: "freelancer", label: "Freelancer / individual" },
  { id: "other", label: "Other" },
] as const;

export const PROVIDERS = [
  { id: "simulator", label: "Demo simulator", note: "No account needed — calls and texts are simulated so you can demo every screen." },
  { id: "twilio", label: "Twilio", note: "Voice, SMS and WhatsApp worldwide. Click-to-call bridge, inbound ring groups, recordings." },
  { id: "exotel", label: "Exotel (India)", note: "Indian virtual numbers (ExoPhones). Click-to-call bridge and SMS, DLT-compliant." },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]["id"];

/** Social platforms: where a handle lives and how to hand a post over for publishing. */
export const SOCIAL_PLATFORMS = [
  { id: "instagram", name: "Instagram", max: 2200, color: "#e1306c", profile: (h: string) => `https://instagram.com/${h}`, share: null },
  { id: "facebook", name: "Facebook", max: 63206, color: "#1877f2", profile: (h: string) => `https://facebook.com/${h}`, share: (t: string, l: string) => `https://www.facebook.com/sharer/sharer.php?u=${enc(l || "https://facebook.com")}&quote=${enc(t)}` },
  { id: "x", name: "X (Twitter)", max: 280, color: "#111111", profile: (h: string) => `https://x.com/${h}`, share: (t: string, l: string) => `https://x.com/intent/post?text=${enc(t)}${l ? `&url=${enc(l)}` : ""}` },
  { id: "linkedin", name: "LinkedIn", max: 3000, color: "#0a66c2", profile: (h: string) => `https://linkedin.com/in/${h}`, share: (t: string, l: string) => `https://www.linkedin.com/feed/?shareActive=true&text=${enc(l ? `${t}\n${l}` : t)}` },
  { id: "youtube", name: "YouTube", max: 5000, color: "#ff0000", profile: (h: string) => `https://youtube.com/@${h}`, share: null },
  { id: "threads", name: "Threads", max: 500, color: "#000000", profile: (h: string) => `https://threads.net/@${h}`, share: (t: string, l: string) => `https://www.threads.net/intent/post?text=${enc(l ? `${t} ${l}` : t)}` },
  { id: "whatsapp", name: "WhatsApp", max: 65536, color: "#25d366", profile: (h: string) => `https://wa.me/${h.replace(/\D/g, "")}`, share: (t: string, l: string) => `https://wa.me/?text=${enc(l ? `${t}\n${l}` : t)}` },
  { id: "telegram", name: "Telegram", max: 4096, color: "#229ed9", profile: (h: string) => `https://t.me/${h}`, share: (t: string, l: string) => `https://t.me/share/url?url=${enc(l || " ")}&text=${enc(t)}` },
  { id: "pinterest", name: "Pinterest", max: 500, color: "#e60023", profile: (h: string) => `https://pinterest.com/${h}`, share: null },
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]["id"];
export const SOCIAL_IDS = SOCIAL_PLATFORMS.map((p) => p.id) as [SocialPlatform, ...SocialPlatform[]];

function enc(s: string) {
  return encodeURIComponent(s);
}

/** Cleans a handle the way people paste it: "@name", "instagram.com/name/", full URLs. */
export function cleanHandle(input: string) {
  let h = input.trim();
  try {
    if (/^https?:\/\//i.test(h)) h = new URL(h).pathname;
  } catch {
    // keep as typed
  }
  h = h.replace(/^\/+|\/+$/g, "").replace(/^(in|company|@)\//, "").replace(/^@/, "").split(/[/?#]/)[0];
  return h.slice(0, 80);
}

/** Normalises a phone number to E.164. Bare 10-digit numbers are treated as Indian (+91). */
export function normalizePhone(input: string, defaultCountry = "91") {
  const raw = input.trim().replace(/^whatsapp:/i, "");
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith("+")) {
    digits = digits.replace(/^0+/, "");
    digits = digits.length === 10 ? `+${defaultCountry}${digits}` : `+${digits}`;
  }
  return /^\+\d{7,15}$/.test(digits) ? digits : null;
}

/** "+919876543210" → "+91 98••••••10". Agents see this; the real number never reaches their device. */
export function maskPhone(e164: string) {
  const d = e164.replace(/\D/g, "");
  if (d.length < 6) return "•".repeat(d.length);
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : "";
  const local = d.slice(cc.length);
  return `+${cc ? `${cc} ` : ""}${local.slice(0, 2)}${"•".repeat(local.length - 4)}${local.slice(-2)}`;
}

export function formatPhone(e164: string) {
  if (/^\+91\d{10}$/.test(e164)) return `+91 ${e164.slice(3, 8)} ${e164.slice(8)}`;
  if (/^\+1\d{10}$/.test(e164)) return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  return e164;
}
