import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { ProviderId } from "@/lib/biz-shared";
import { appSecret } from "./auth";
import { ApiError } from "./http";

/**
 * Telephony providers. A business line belongs to one provider. Every provider supports the
 * same two operations, so the rest of the app never cares which carrier is behind a number:
 *
 *  • placeCall — "click-to-call bridge": the provider first rings the AGENT's own phone, then
 *    dials the customer with the BUSINESS number as caller ID. The customer only ever sees the
 *    business number and the agent never needs (or sees) the customer's number → number masking.
 *  • sendMessage — SMS (and WhatsApp on Twilio) from the business number.
 */

export type LineInfo = { id: string; phone_number: string; provider: ProviderId; record_calls: boolean };

export function providerStatus() {
  return {
    simulator: true,
    twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    exotel: Boolean(process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY && process.env.EXOTEL_API_TOKEN),
  };
}

export function assertProviderReady(provider: ProviderId) {
  if (!providerStatus()[provider]) {
    throw new ApiError(400, `${provider === "twilio" ? "Twilio" : "Exotel"} isn't configured on this server yet. Add its keys to the environment (see README → Business telephony), or use the demo simulator.`, "provider_missing");
  }
}

/** Public URL that providers call back. Set PUBLIC_BASE_URL in production (e.g. https://yourapp.vercel.app). */
export function baseUrl(req: NextRequest) {
  const env = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (env) return env;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

/** Callback URLs carry an HMAC of the call id, so nobody can forge status updates for a call. */
export function callbackSig(id: string) {
  return createHmac("sha256", appSecret()).update(`tel:${id}`).digest("base64url").slice(0, 32);
}
export function checkCallbackSig(id: string, sig: string | null) {
  if (!sig) return false;
  const a = Buffer.from(callbackSig(id));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PlaceCallResult = { sid: string; status: "queued" | "ringing" };

export async function placeCall(
  req: NextRequest,
  line: LineInfo,
  opts: { callId: string; agentPhone: string; customerPhone: string },
): Promise<PlaceCallResult> {
  const sig = callbackSig(opts.callId);
  const base = baseUrl(req);
  if (line.provider === "simulator") return { sid: `SIM-${opts.callId.slice(0, 8)}`, status: "ringing" };

  if (line.provider === "twilio") {
    assertProviderReady("twilio");
    const q = `call=${opts.callId}&sig=${sig}`;
    const res = await twilio("Calls.json", {
      To: opts.agentPhone,
      From: line.phone_number,
      Url: `${base}/api/telephony/twilio/bridge?${q}`,
      StatusCallback: `${base}/api/telephony/twilio/agent-status?${q}`,
      StatusCallbackEvent: "completed",
      Timeout: "25",
    });
    return { sid: String(res.sid), status: "queued" };
  }

  assertProviderReady("exotel");
  const res = await exotel("Calls/connect.json", {
    From: opts.agentPhone,
    To: opts.customerPhone,
    CallerId: line.phone_number,
    Record: line.record_calls ? "true" : "false",
    StatusCallback: `${base}/api/telephony/exotel/status?call=${opts.callId}&sig=${sig}`,
    "StatusCallbackEvents[0]": "terminal",
    StatusCallbackContentType: "application/json",
  });
  const call = (res.Call ?? {}) as { Sid?: string };
  return { sid: String(call.Sid ?? ""), status: "queued" };
}

export async function sendMessage(
  req: NextRequest,
  line: LineInfo,
  opts: { messageId: string; to: string; body: string; channel: "sms" | "whatsapp" },
): Promise<{ sid: string; status: string }> {
  if (line.provider === "simulator") return { sid: `SIM-${opts.messageId.slice(0, 8)}`, status: "delivered" };
  if (line.provider === "twilio") {
    assertProviderReady("twilio");
    const wa = opts.channel === "whatsapp";
    const res = await twilio("Messages.json", {
      To: wa ? `whatsapp:${opts.to}` : opts.to,
      From: wa ? `whatsapp:${line.phone_number}` : line.phone_number,
      Body: opts.body,
      StatusCallback: `${baseUrl(req)}/api/telephony/twilio/message-status?msg=${opts.messageId}&sig=${callbackSig(opts.messageId)}`,
    });
    return { sid: String(res.sid), status: String(res.status ?? "queued") };
  }
  if (opts.channel === "whatsapp") throw new ApiError(400, "WhatsApp on Exotel needs a separate WhatsApp Business setup. Use SMS, or a Twilio line for WhatsApp.");
  assertProviderReady("exotel");
  const res = await exotel("Sms/send.json", {
    From: process.env.EXOTEL_SMS_SENDER || line.phone_number,
    To: opts.to,
    Body: opts.body,
    ...(process.env.EXOTEL_DLT_ENTITY_ID ? { DltEntityId: process.env.EXOTEL_DLT_ENTITY_ID } : {}),
  });
  const sms = (res.SMSMessage ?? {}) as { Sid?: string; Status?: string };
  return { sid: String(sms.Sid ?? ""), status: String(sms.Status ?? "queued") };
}

// ── provider HTTP clients (no SDKs needed) ──────────────────────────────────

async function twilio(path: string, form: Record<string, string>) {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(502, `Twilio: ${String(data.message ?? res.statusText)}`, "provider_error");
  return data;
}

async function exotel(path: string, form: Record<string, string>) {
  const sid = process.env.EXOTEL_SID!;
  const host = process.env.EXOTEL_SUBDOMAIN || "api.exotel.com";
  const res = await fetch(`https://${host}/v1/Accounts/${sid}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.RestException ?? {}) as { Message?: string };
    throw new ApiError(502, `Exotel: ${err.Message ?? res.statusText}`, "provider_error");
  }
  return data;
}

/**
 * Validates X-Twilio-Signature: base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value)...)).
 * Behind a proxy the URL Twilio called must be reconstructed — set PUBLIC_BASE_URL.
 */
export function validTwilioRequest(req: NextRequest, params: Record<string, string>) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = `${baseUrl(req)}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function twiml(inner: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
}

export function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}
