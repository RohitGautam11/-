import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { normalizePhone } from "@/lib/biz-shared";
import { activity, agentsToRing, contactForNumber, lineByNumber, touchContact, type LineRow } from "@/lib/server/biz";
import { createHash, timingSafeEqual } from "node:crypto";
import { one, query } from "@/lib/server/db";
import { missedCallTicket } from "@/lib/server/helpdesk";
import { baseUrl, callbackSig, checkCallbackSig, sendMessage, twiml, validTwilioRequest, xmlEscape } from "@/lib/server/telephony";

/**
 * Carrier webhooks. Configure in the provider console (see README → Business telephony):
 *   Twilio number → Voice "A call comes in":   POST {base}/api/telephony/twilio/voice
 *                 → Messaging "A message comes in": POST {base}/api/telephony/twilio/sms
 *   Exotel flow  → Passthru applet:            GET  {base}/api/telephony/exotel/inbound?key=EXOTEL_WEBHOOK_KEY
 * Everything else (bridge, whisper, status) is wired automatically when calls are placed.
 */

type Ctx = { params: Promise<{ provider: string; event: string }> };

type CallRow = { id: string; workspace_id: string; line_id: string | null; contact_id: string | null; direction: string; status: string; remote_number: string };

async function form(req: NextRequest): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const type = req.headers.get("content-type") ?? "";
  if (req.method === "GET") {
    req.nextUrl.searchParams.forEach((v, k) => (out[k] = v));
    return out;
  }
  if (type.includes("application/json")) {
    const data = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
    return out;
  }
  const params = new URLSearchParams(await req.text());
  params.forEach((v, k) => (out[k] = v));
  return out;
}

const unauthorized = () => new Response("forbidden", { status: 403 });

/** Constant-time comparison, so the webhook key can't be guessed one character at a time. */
function sameSecret(given: string, expected: string) {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function loadCall(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("call") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id) || !checkCallbackSig(id, req.nextUrl.searchParams.get("sig"))) return null;
  return one<CallRow>("SELECT id, workspace_id, line_id, contact_id, direction, status, remote_number FROM crm_calls WHERE id = $1", [id]);
}

/** Every missed call gets an SMS reply (if set up) and a callback ticket with an SLA. */
async function missedCallReply(req: NextRequest, line: LineRow, contactId: string, to: string) {
  await missedCallTicket(line.workspace_id, contactId, to, line.label).catch((error) => console.error("[telephony] callback ticket", error));
  if (!line.missed_call_reply || !line.channels.includes("sms")) return;
  const id = randomUUID();
  await query(
    "INSERT INTO crm_messages (id, workspace_id, line_id, contact_id, channel, direction, body, status) VALUES ($1, $2, $3, $4, 'sms', 'outbound', $5, 'queued')",
    [id, line.workspace_id, line.id, contactId, line.missed_call_reply],
  );
  try {
    const res = await sendMessage(req, line, { messageId: id, to, body: line.missed_call_reply, channel: "sms" });
    await query("UPDATE crm_messages SET status = $2, provider_sid = $3 WHERE id = $1", [id, res.status, res.sid]);
    await activity(null, line.workspace_id, contactId, null, "message", "Missed-call auto-reply sent");
  } catch {
    await query("UPDATE crm_messages SET status = 'failed' WHERE id = $1", [id]);
  }
}

const TWILIO_FINAL: Record<string, string> = { completed: "completed", answered: "completed", "no-answer": "no-answer", busy: "busy", failed: "failed", canceled: "canceled" };

async function twilio(req: NextRequest, event: string) {
  const p = await form(req);
  if (!validTwilioRequest(req, p)) return unauthorized();
  const sigQ = (id: string) => `call=${id}&sig=${callbackSig(id)}`;
  const base = baseUrl(req);

  // Inbound call to a business number → ring the team.
  if (event === "voice") {
    const line = await lineByNumber(p.To ?? "");
    if (!line) return twiml("<Say>This number is not in service.</Say><Hangup/>");
    const from = normalizePhone(p.From ?? "") ?? p.From ?? "unknown";
    const contactId = await contactForNumber(line.workspace_id, from);
    const id = randomUUID();
    await query(
      `INSERT INTO crm_calls (id, workspace_id, line_id, contact_id, direction, status, remote_number, provider, provider_sid)
       VALUES ($1, $2, $3, $4, 'inbound', 'ringing', $5, 'twilio', $6)`,
      [id, line.workspace_id, line.id, contactId, from, p.CallSid ?? null],
    );
    await touchContact(contactId);
    const agents = await agentsToRing(line);
    if (!agents.length) {
      await query("UPDATE crm_calls SET status = 'missed', ended_at = now() WHERE id = $1", [id]);
      await missedCallReply(req, line, contactId, from);
      return twiml("<Say>Thank you for calling. All our team members are busy right now. We will call you back shortly.</Say><Hangup/>");
    }
    const record = line.record_calls ? ` record="record-from-answer-dual"` : "";
    // Agents' phones show the BUSINESS number, so customers' personal numbers stay private.
    const numbers = agents
      .map((a) => `<Number url="${xmlEscape(`${base}/api/telephony/twilio/whisper?${sigQ(id)}&agent=${a.user_id}`)}">${xmlEscape(a.phone)}</Number>`)
      .join("");
    return twiml(
      `<Dial callerId="${xmlEscape(line.phone_number)}" timeout="25"${record} action="${xmlEscape(`${base}/api/telephony/twilio/dial-status?${sigQ(id)}`)}">${numbers}</Dial>`,
    );
  }

  const call = await loadCall(req);

  // Plays to whichever agent picks up first, and records who took the call.
  if (event === "whisper") {
    if (!call) return unauthorized();
    const agent = req.nextUrl.searchParams.get("agent");
    if (agent && /^[0-9a-f-]{36}$/.test(agent)) {
      await query("UPDATE crm_calls SET agent_id = $2, status = 'in-progress', answered_at = now() WHERE id = $1 AND agent_id IS NULL", [call.id, agent]);
    }
    const contact = call.contact_id ? await one<{ name: string }>("SELECT name FROM crm_contacts WHERE id = $1", [call.contact_id]) : null;
    return twiml(`<Say>Business call from ${xmlEscape(contact?.name ?? "a new caller")}.</Say>`);
  }

  // Outbound: the agent picked up their phone; now dial the customer from the business number.
  if (event === "bridge") {
    if (!call) return twiml("<Say>Sorry, this call could not be connected.</Say><Hangup/>");
    const line = call.line_id ? await one<LineRow>("SELECT * FROM business_lines WHERE id = $1", [call.line_id]) : null;
    if (!line) return twiml("<Hangup/>");
    await query("UPDATE crm_calls SET status = 'ringing' WHERE id = $1", [call.id]);
    const record = line.record_calls ? ` record="record-from-answer-dual"` : "";
    return twiml(
      `<Say>Connecting your call.</Say><Dial callerId="${xmlEscape(line.phone_number)}" timeout="30"${record} action="${xmlEscape(`${base}/api/telephony/twilio/dial-status?${sigQ(call.id)}`)}"><Number>${xmlEscape(call.remote_number)}</Number></Dial>`,
    );
  }

  if (event === "dial-status") {
    if (!call) return unauthorized();
    const dial = p.DialCallStatus ?? "failed";
    let status = TWILIO_FINAL[dial] ?? "failed";
    if (call.direction === "inbound" && status !== "completed") status = "missed";
    const duration = Number(p.DialCallDuration ?? 0) || 0;
    await query(
      `UPDATE crm_calls SET status = $2, duration_sec = $3, ended_at = now(), recording_url = coalesce($4, recording_url),
              answered_at = CASE WHEN $3 > 0 THEN coalesce(answered_at, now() - make_interval(secs => $3)) ELSE answered_at END
        WHERE id = $1`,
      [call.id, status, duration, p.RecordingUrl || null],
    );
    if (status === "missed" && call.contact_id && call.line_id) {
      const line = await one<LineRow>("SELECT * FROM business_lines WHERE id = $1", [call.line_id]);
      if (line) await missedCallReply(req, line, call.contact_id, call.remote_number);
    }
    return twiml("<Hangup/>");
  }

  // Outbound: the agent's own phone never answered.
  if (event === "agent-status") {
    if (!call) return unauthorized();
    const s = p.CallStatus ?? "";
    if (["no-answer", "busy", "failed", "canceled"].includes(s)) {
      await query(
        "UPDATE crm_calls SET status = 'failed', ended_at = now(), notes = CASE WHEN notes = '' THEN $2 ELSE notes END WHERE id = $1 AND status IN ('queued', 'ringing')",
        [call.id, `Your phone didn't answer (${s}).`],
      );
    }
    return new Response(null, { status: 204 });
  }

  // Inbound SMS / WhatsApp to a business number → unified inbox.
  if (event === "sms") {
    const whatsapp = (p.From ?? "").startsWith("whatsapp:");
    const line = await lineByNumber((p.To ?? "").replace(/^whatsapp:/, ""));
    if (line) {
      const from = normalizePhone(p.From ?? "") ?? p.From ?? "";
      const contactId = await contactForNumber(line.workspace_id, from, whatsapp ? "whatsapp" : "sms");
      await query(
        `INSERT INTO crm_messages (id, workspace_id, line_id, contact_id, channel, direction, body, status, provider_sid)
         VALUES ($1, $2, $3, $4, $5, 'inbound', $6, 'received', $7)`,
        [randomUUID(), line.workspace_id, line.id, contactId, whatsapp ? "whatsapp" : "sms", (p.Body ?? "").slice(0, 4000), p.MessageSid ?? null],
      );
      await query("UPDATE crm_contacts SET updated_at = now() WHERE id = $1", [contactId]);
    }
    return twiml("");
  }

  if (event === "message-status") {
    const id = req.nextUrl.searchParams.get("msg") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id) || !checkCallbackSig(id, req.nextUrl.searchParams.get("sig"))) return unauthorized();
    if (p.MessageStatus) await query("UPDATE crm_messages SET status = $2 WHERE id = $1", [id, p.MessageStatus.slice(0, 20)]);
    return new Response(null, { status: 204 });
  }

  return new Response("not found", { status: 404 });
}

const EXOTEL_FINAL: Record<string, string> = { completed: "completed", busy: "busy", failed: "failed", "no-answer": "no-answer", canceled: "canceled" };

async function exotel(req: NextRequest, event: string) {
  const p = await form(req);

  if (event === "status") {
    const call = await loadCall(req);
    if (!call) return unauthorized();
    const status = EXOTEL_FINAL[(p.Status ?? "").toLowerCase()] ?? "failed";
    let duration = Number(p.ConversationDuration ?? 0) || 0;
    if (!duration && p.Legs) {
      try {
        const legs = JSON.parse(p.Legs) as { OnCallDuration?: number }[];
        duration = Math.min(...legs.map((l) => Number(l.OnCallDuration ?? 0)));
      } catch {
        // ignore
      }
    }
    await query(
      `UPDATE crm_calls SET status = $2, duration_sec = $3, ended_at = now(), recording_url = coalesce($4, recording_url),
              answered_at = CASE WHEN $3 > 0 THEN now() - make_interval(secs => $3) ELSE answered_at END WHERE id = $1`,
      [call.id, status, duration, p.RecordingUrl || null],
    );
    return new Response(null, { status: 204 });
  }

  // Exotel "Passthru" applet: called when a customer rings an ExoPhone (and again with DialCallStatus).
  if (event === "inbound") {
    const key = process.env.EXOTEL_WEBHOOK_KEY;
    if (!key || !sameSecret(req.nextUrl.searchParams.get("key") ?? "", key)) return unauthorized();
    const line = await lineByNumber(p.CallTo ?? p.To ?? "");
    if (!line) return new Response("ok");
    const sid = p.CallSid ?? "";
    const from = normalizePhone(p.CallFrom ?? p.From ?? "") ?? "unknown";
    const existing = sid ? await one<{ id: string; contact_id: string | null }>("SELECT id, contact_id FROM crm_calls WHERE provider_sid = $1", [sid]) : null;
    if (!existing) {
      const contactId = await contactForNumber(line.workspace_id, from);
      await query(
        `INSERT INTO crm_calls (id, workspace_id, line_id, contact_id, direction, status, remote_number, provider, provider_sid)
         VALUES ($1, $2, $3, $4, 'inbound', 'ringing', $5, 'exotel', $6)`,
        [randomUUID(), line.workspace_id, line.id, contactId, from, sid || null],
      );
      await touchContact(contactId);
    } else if (p.DialCallStatus) {
      const answered = p.DialCallStatus === "completed";
      const duration = Number(p.DialCallDuration ?? 0) || 0;
      await query("UPDATE crm_calls SET status = $2, duration_sec = $3, ended_at = now(), recording_url = coalesce($4, recording_url) WHERE id = $1", [
        existing.id, answered ? "completed" : "missed", duration, p.RecordingUrl || null,
      ]);
      if (!answered && existing.contact_id) await missedCallReply(req, line, existing.contact_id, from);
    }
    return new Response("ok");
  }

  return new Response("not found", { status: 404 });
}

async function handle(req: NextRequest, ctx: Ctx) {
  const { provider, event } = await ctx.params;
  try {
    if (provider === "twilio") return await twilio(req, event);
    if (provider === "exotel") return await exotel(req, event);
  } catch (error) {
    console.error("[telephony]", provider, event, error);
    if (provider === "twilio") return twiml("<Say>Sorry, something went wrong.</Say><Hangup/>");
    return new Response("error", { status: 500 });
  }
  return new Response("not found", { status: 404 });
}

export const GET = handle;
export const POST = handle;
