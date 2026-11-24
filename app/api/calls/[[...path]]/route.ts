import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, type SessionUser } from "@/lib/server/auth";
import { systemMessage } from "@/lib/server/conversations";
import { one, query, tx } from "@/lib/server/db";
import { ApiError, body, forbidden, json, notFound, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { PUBLIC_USER_COLUMNS, publicView, type PublicUserRow } from "@/lib/server/users";
import { uuid } from "@/lib/server/validation";

/**
 * In-app audio/video calls. The server is only the signalling relay: it passes WebRTC
 * offers/answers/ICE candidates between the two devices. Audio and video travel peer-to-peer
 * (or through TURN), encrypted with DTLS-SRTP, and are never seen by this server.
 *
 *   GET  /api/calls                 call history
 *   GET  /api/calls/ice             STUN/TURN servers
 *   GET  /api/calls/poll?after=N    incoming rings, signals for me, state of my live calls
 *   POST /api/calls                 { calleeId, conversationId?, video } → start a call
 *   POST /api/calls/:id/answer | /decline | /end
 *   POST /api/calls/:id/signal      { type, payload }
 */

type Ctx = { params: Promise<{ path?: string[] }> };
const RING_SECONDS = 45;

type CallRow = {
  id: string; conversation_id: string | null; caller_id: string; callee_id: string; video: boolean;
  status: string; created_at: Date; answered_at: Date | null; ended_at: Date | null;
};

function callView(c: CallRow, meId: string) {
  return {
    id: c.id,
    conversationId: c.conversation_id,
    callerId: c.caller_id,
    calleeId: c.callee_id,
    peerId: c.caller_id === meId ? c.callee_id : c.caller_id,
    outgoing: c.caller_id === meId,
    video: c.video,
    status: c.status,
    createdAt: c.created_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at,
  };
}

/** Rings nobody picked up become "missed" and leave a notice in the chat. */
async function expireRinging(userId: string) {
  const stale = await query<CallRow>(
    `UPDATE call_sessions SET status = 'missed', ended_at = now()
      WHERE status = 'ringing' AND created_at < now() - make_interval(secs => $2)
        AND (caller_id = $1 OR callee_id = $1)
      RETURNING *`,
    [userId, RING_SECONDS],
  );
  for (const c of stale) await noteInChat(c, "missed");
}

async function noteInChat(c: CallRow, outcome: "missed" | "declined" | "ended") {
  if (!c.conversation_id) return;
  const kind = c.video ? "video call" : "voice call";
  const caller = await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [c.caller_id]);
  let text: string;
  if (outcome === "missed") text = `📞 Missed ${kind} from ${caller?.display_name ?? "someone"}`;
  else if (outcome === "declined") text = `📞 ${caller?.display_name ?? "Someone"}'s ${kind} was declined`;
  else {
    const secs = c.answered_at && c.ended_at ? Math.max(0, Math.round((new Date(c.ended_at).getTime() - new Date(c.answered_at).getTime()) / 1000)) : 0;
    text = `📞 ${kind[0].toUpperCase()}${kind.slice(1)} · ${Math.floor(secs / 60)}m ${secs % 60}s`;
  }
  await tx(async (q) => {
    await systemMessage(q, c.conversation_id!, c.caller_id, text);
    await q.query("UPDATE conversations SET change_seq = nextval('change_seq'), touched_at = clock_timestamp() WHERE id = $1", [c.conversation_id]);
  }).catch(() => undefined);
}

async function loadCall(id: string, user: SessionUser) {
  const call = await one<CallRow>("SELECT * FROM call_sessions WHERE id = $1", [id]);
  if (!call) throw notFound("This call no longer exists.");
  if (call.caller_id !== user.id && call.callee_id !== user.id) throw forbidden();
  return call;
}

export const GET = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const [first] = (await ctx.params).path ?? [];

  if (first === "ice") {
    const servers: RTCIceServerLike[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    if (process.env.TURN_URL) {
      servers.push({
        urls: process.env.TURN_URL.split(",").map((s) => s.trim()),
        username: process.env.TURN_USERNAME ?? "",
        credential: process.env.TURN_CREDENTIAL ?? "",
      });
    }
    return json({ iceServers: servers });
  }

  if (first === "poll") {
    const after = Math.max(0, Number(req.nextUrl.searchParams.get("after") ?? 0) || 0);
    await expireRinging(user.id);
    const [live, signals] = await Promise.all([
      query<CallRow>(
        `SELECT * FROM call_sessions
          WHERE (caller_id = $1 OR callee_id = $1)
            AND (status IN ('ringing', 'active') OR ended_at > now() - interval '20 seconds')
          ORDER BY created_at DESC LIMIT 10`,
        [user.id],
      ),
      query<{ id: number; call_id: string; type: string; payload: string }>(
        "SELECT id, call_id, type, payload FROM call_signals WHERE to_user = $1 AND id > $2 ORDER BY id LIMIT 200",
        [user.id, after],
      ),
    ]);
    const peerIds = [...new Set(live.map((c) => (c.caller_id === user.id ? c.callee_id : c.caller_id)))];
    const peers = peerIds.length
      ? await query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE u.id = ANY($1::uuid[])`, [peerIds])
      : [];
    return json({
      calls: live.map((c) => callView(c, user.id)),
      peers: peers.map(publicView),
      signals: signals.map((s) => ({ id: s.id, callId: s.call_id, type: s.type, payload: s.payload })),
      cursor: signals.length ? signals[signals.length - 1].id : after,
    });
  }

  if (!first) {
    await expireRinging(user.id);
    const rows = await query<CallRow & PublicUserRow & { call_id: string }>(
      `SELECT c.id AS call_id, c.conversation_id, c.caller_id, c.callee_id, c.video, c.status, c.created_at, c.answered_at, c.ended_at,
              ${PUBLIC_USER_COLUMNS}
         FROM call_sessions c
         JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
        WHERE c.caller_id = $1 OR c.callee_id = $1
        ORDER BY c.created_at DESC LIMIT 100`,
      [user.id],
    );
    return json({
      calls: rows.map((r) => ({ ...callView({ ...r, id: r.call_id }, user.id), peer: publicView(r) })),
    });
  }
  throw notFound();
});

type RTCIceServerLike = { urls: string[]; username?: string; credential?: string };

const startSchema = z.object({ calleeId: uuid, conversationId: uuid.nullish(), video: z.boolean().default(false) });
const signalSchema = z.object({ type: z.enum(["offer", "answer", "ice", "renegotiate"]), payload: z.string().min(1).max(20_000) });

export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const [first, action] = (await ctx.params).path ?? [];

  if (!first) {
    await rateLimit(`call:${user.id}`, 20, 60);
    const input = await body(req, startSchema);
    if (input.calleeId === user.id) throw new ApiError(400, "You can't call yourself.");
    if (input.conversationId) {
      const both = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversation_members
          WHERE conversation_id = $1 AND user_id = ANY($2::uuid[]) AND left_at IS NULL`,
        [input.conversationId, [user.id, input.calleeId]],
      );
      if ((both?.n ?? 0) < 2) throw forbidden("You can only call people in this chat.");
    }
    await expireRinging(input.calleeId);
    const busy = await one<{ id: string }>(
      "SELECT id FROM call_sessions WHERE status IN ('ringing', 'active') AND (caller_id = $1 OR callee_id = $1) LIMIT 1",
      [input.calleeId],
    );
    const id = randomUUID();
    const row = await one<CallRow>(
      `INSERT INTO call_sessions (id, conversation_id, caller_id, callee_id, video, status, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'busy' THEN now() END) RETURNING *`,
      [id, input.conversationId ?? null, user.id, input.calleeId, input.video, busy ? "busy" : "ringing"],
    );
    if (busy) throw new ApiError(409, "They're on another call right now. Try again in a bit.", "busy");
    return json({ call: callView(row!, user.id) });
  }

  const id = uuid.parse(first);
  const call = await loadCall(id, user);
  const peerId = call.caller_id === user.id ? call.callee_id : call.caller_id;

  if (action === "signal") {
    await rateLimit(`signal:${user.id}`, 600, 60);
    const input = await body(req, signalSchema);
    if (!["ringing", "active"].includes(call.status)) throw new ApiError(409, "The call has ended.", "ended");
    await query("INSERT INTO call_signals (call_id, to_user, type, payload) VALUES ($1, $2, $3, $4)", [id, peerId, input.type, input.payload]);
    return json({ ok: true });
  }

  if (action === "answer") {
    if (call.callee_id !== user.id) throw forbidden();
    const row = await one<CallRow>(
      "UPDATE call_sessions SET status = 'active', answered_at = now() WHERE id = $1 AND status = 'ringing' RETURNING *",
      [id],
    );
    if (!row) throw new ApiError(409, "This call is no longer ringing.", "ended");
    return json({ call: callView(row, user.id) });
  }

  if (action === "decline" || action === "end") {
    const status = call.status === "active" ? "ended" : call.callee_id === user.id && action === "decline" ? "declined" : call.status === "ringing" ? "missed" : call.status;
    const row = await one<CallRow>(
      "UPDATE call_sessions SET status = $2, ended_at = now() WHERE id = $1 AND status IN ('ringing', 'active') RETURNING *",
      [id, status],
    );
    if (row) {
      await query("DELETE FROM call_signals WHERE call_id = $1", [id]);
      await noteInChat(row, status === "ended" ? "ended" : status === "declined" ? "declined" : "missed");
    }
    return json({ call: callView(row ?? call, user.id) });
  }

  throw notFound();
});
