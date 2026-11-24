import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { DISPOSITIONS, normalizePhone, SOCIAL_IDS, SOCIAL_PLATFORMS, STAGE_IDS, cleanHandle } from "@/lib/biz-shared";
import { requireUser, type SessionUser } from "@/lib/server/auth";
import {
  activity, contactView, dispatchDuePosts, isAdmin, publishViaWebhook, requireWorkspace, seedDemo, showPhone, touchContact,
  type Access, type ContactRow, type LineRow,
} from "@/lib/server/biz";
import { one, query, tx } from "@/lib/server/db";
import { audit, missedCallTicket, seedHelpdesk } from "@/lib/server/helpdesk";
import { auditLog, helpdesk, kb, tickets } from "@/lib/server/helpdesk-api";
import { PRIORITY_IDS } from "@/lib/helpdesk-shared";
import { ApiError, badRequest, body, forbidden, json, notFound, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { placeCall, providerStatus, sendMessage } from "@/lib/server/telephony";
import { uuid } from "@/lib/server/validation";

/**
 * Business Suite API — a calling CRM where one business number serves a whole team.
 *   /api/biz                              GET my workspaces · POST create
 *   /api/biz/:ws                          GET overview · PATCH settings
 *   /api/biz/:ws/members[/:userId]        POST add · PATCH · DELETE
 *   /api/biz/:ws/lines[/:id]              POST · PATCH · DELETE
 *   /api/biz/:ws/contacts[/:id[/notes]]   GET · POST (bulk import) · PATCH · DELETE
 *   /api/biz/:ws/calls[/:id]              GET log · POST click-to-call · PATCH outcome
 *   /api/biz/:ws/messages                 GET inbox / thread · POST send SMS/WhatsApp
 *   /api/biz/:ws/tasks[/:id]              GET · POST · PATCH
 *   /api/biz/:ws/templates[/:id]          GET · POST · DELETE
 *   /api/biz/:ws/social[/accounts|posts[/:id]]
 *   /api/biz/:ws/analytics?days=30        GET
 *   /api/biz/:ws/export                   GET contacts as CSV (admins)
 *   /api/biz/:ws/tickets · kb · helpdesk · audit   (see lib/server/helpdesk-api.ts)
 *   /api/biz/:ws/calls/simulate-inbound   POST demo: a missed inbound call on the demo line (admins)
 */

type Ctx = { params: Promise<{ path?: string[] }> };
type Handler = (req: NextRequest, user: SessionUser, a: Access, rest: string[]) => Promise<Response>;

const phone = z.string().trim().min(5).max(32).transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: "custom", message: "enter a valid phone number, e.g. +91 98765 43210" });
  return p ?? "";
});
const text = (max: number) => z.string().trim().max(max);

// ── workspaces ───────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: text(60).min(2),
  industry: text(40).default("other"),
  demo: z.boolean().default(true),
  lineNumber: z.string().optional(),
});

async function listWorkspaces(user: SessionUser) {
  const rows = await query<{ id: string; name: string; industry: string; role: string; members: number }>(
    `SELECT w.id, w.name, w.industry, m.role,
            (SELECT count(*)::int FROM workspace_members x WHERE x.workspace_id = w.id) AS members
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
      ORDER BY w.created_at`,
    [user.id],
  );
  return json({ workspaces: rows, providers: providerStatus() });
}

async function createWorkspace(req: NextRequest, user: SessionUser) {
  await rateLimit(`ws-create:${user.id}`, 10, 3600);
  const input = await body(req, createSchema);
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1 AND role = 'owner'", [user.id]);
  if ((count?.n ?? 0) >= 10) throw badRequest("You can own up to 10 workspaces.");
  const id = randomUUID();
  const lineId = randomUUID();
  // Demo lines get a fake number in the reserved +91 1800 range so they can never dial anyone real.
  const number = (input.lineNumber && normalizePhone(input.lineNumber)) || `+91180000${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  await tx(async (q) => {
    await q.query("INSERT INTO workspaces (id, name, industry, owner_id, settings) VALUES ($1, $2, $3, $4, $5)", [
      id, input.name, input.industry, user.id, JSON.stringify({ maskForAgents: true, defaultCountry: "91", currency: "INR" }),
    ]);
    await q.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [id, user.id]);
    await q.query(
      `INSERT INTO business_lines (id, workspace_id, label, phone_number, provider, channels, missed_call_reply)
       VALUES ($1, $2, 'Main line (demo)', $3, 'simulator', ARRAY['voice', 'sms', 'whatsapp'], $4)`,
      [lineId, id, number, "Sorry we missed your call! We'll call you back shortly — or reply here with your query."],
    );
    if (input.demo) {
      await seedDemo(q, id, user.id, lineId, input.industry);
      await seedHelpdesk(q, id, user.id, input.industry === "travel");
    }
  });
  await audit(id, user.id, "workspace.create", input.name);
  return json({ id });
}

async function overview(_req: NextRequest, user: SessionUser, a: Access) {
  const ws = a.workspace.id;
  const [members, lines, today, pipeline, tasks, recent, social, desk] = await Promise.all([
    query<{ user_id: string; role: string; phone: string | null; availability: string; display_name: string; username: string; avatar_hue: number; last_seen_at: Date }>(
      `SELECT m.user_id, m.role, m.phone, m.availability, u.display_name, u.username, u.avatar_hue, u.last_seen_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.joined_at`,
      [ws],
    ),
    query<LineRow>("SELECT * FROM business_lines WHERE workspace_id = $1 ORDER BY created_at", [ws]),
    one<{ total: number; answered: number; missed: number; talk: number; outbound: number; inbound: number; messages: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS answered,
              count(*) FILTER (WHERE status IN ('missed', 'no-answer', 'busy'))::int AS missed,
              coalesce(sum(duration_sec), 0)::int AS talk,
              count(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
              count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
              (SELECT count(*)::int FROM crm_messages WHERE workspace_id = $1 AND created_at >= date_trunc('day', now()) AND created_at <= now()) AS messages
         FROM crm_calls WHERE workspace_id = $1 AND started_at >= date_trunc('day', now())`,
      [ws],
    ),
    query<{ stage: string; n: number; value: number }>(
      "SELECT stage, count(*)::int AS n, coalesce(sum(value_paise), 0)::bigint AS value FROM crm_contacts WHERE workspace_id = $1 GROUP BY stage",
      [ws],
    ),
    query<TaskRow>(TASK_SQL + " WHERE t.workspace_id = $1 AND t.done_at IS NULL AND ($2::uuid IS NULL OR t.assignee_id = $2) ORDER BY t.due_at LIMIT 8", [ws, isAdmin(a) ? null : user.id]),
    query<CallRow>(CALL_SQL + " WHERE c.workspace_id = $1 ORDER BY c.started_at DESC LIMIT 8", [ws]),
    one<{ scheduled: number; due: number }>(
      "SELECT count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled, count(*) FILTER (WHERE status = 'scheduled' AND scheduled_at <= now())::int AS due FROM social_posts WHERE workspace_id = $1",
      [ws],
    ),
    one<{ open: number; breached: number; callbacks: number; mine: number }>(
      `SELECT count(*)::int AS open,
              count(*) FILTER (WHERE (first_response_at IS NULL AND first_response_due < now()) OR resolve_due < now())::int AS breached,
              count(*) FILTER (WHERE kind = 'callback')::int AS callbacks,
              count(*) FILTER (WHERE assignee_id = $2)::int AS mine
         FROM support_tickets WHERE workspace_id = $1 AND status IN ('open', 'pending')`,
      [ws, user.id],
    ),
  ]);
  if ((social?.due ?? 0) > 0) after(() => dispatchDuePosts(ws).catch(() => undefined));
  const me = members.find((m) => m.user_id === user.id);
  return json({
    workspace: { id: ws, name: a.workspace.name, industry: a.workspace.industry, settings: a.workspace.settings, createdAt: a.workspace.created_at },
    role: a.role,
    masked: a.masked,
    me: { phone: me?.phone ?? null, availability: me?.availability ?? "available" },
    providers: providerStatus(),
    socialWebhook: Boolean(process.env.SOCIAL_WEBHOOK_URL),
    members: members.map((m) => ({
      userId: m.user_id, role: m.role, displayName: m.display_name, username: m.username, avatarHue: m.avatar_hue,
      availability: m.availability, lastSeenAt: m.last_seen_at,
      phone: isAdmin(a) || m.user_id === user.id ? m.phone : m.phone ? "on file" : null,
    })),
    lines: lines.map(lineView),
    today: today ?? { total: 0, answered: 0, missed: 0, talk: 0, outbound: 0, inbound: 0, messages: 0 },
    pipeline,
    tasks: tasks.map((t) => taskView(t)),
    recentCalls: recent.map((c) => callView(a, c)),
    social: social ?? { scheduled: 0, due: 0 },
    helpdesk: desk ?? { open: 0, breached: 0, callbacks: 0, mine: 0 },
  });
}

const minutes = z.number().int().min(5).max(60 * 24 * 30);
const settingsSchema = z.object({
  name: text(60).min(2).optional(),
  industry: text(40).optional(),
  maskForAgents: z.boolean().optional(),
  businessHours: text(80).optional(),
  helpCenter: z.boolean().optional(),
  helpIntro: text(400).optional(),
  autoAssign: z.boolean().optional(),
  sla: z.partialRecord(z.enum(PRIORITY_IDS), z.object({ respond: minutes, resolve: minutes })).optional(),
});

async function updateWorkspace(req: NextRequest, user: SessionUser, a: Access) {
  if (!isAdmin(a)) throw forbidden("Only admins can change workspace settings.");
  const input = await body(req, settingsSchema);
  const settings = { ...a.workspace.settings };
  const changed: string[] = [];
  for (const key of ["maskForAgents", "businessHours", "helpCenter", "helpIntro", "autoAssign"] as const) {
    if (input[key] !== undefined && input[key] !== settings[key]) {
      (settings as Record<string, unknown>)[key] = input[key];
      changed.push(typeof input[key] === "boolean" ? `${key} ${input[key] ? "on" : "off"}` : key);
    }
  }
  if (input.sla) {
    settings.sla = { ...settings.sla, ...input.sla };
    changed.push("SLA targets");
  }
  await query("UPDATE workspaces SET name = coalesce($2, name), industry = coalesce($3, industry), settings = $4 WHERE id = $1", [
    a.workspace.id, input.name ?? null, input.industry ?? null, JSON.stringify(settings),
  ]);
  if (input.name && input.name !== a.workspace.name) changed.push(`renamed to "${input.name}"`);
  if (changed.length) await audit(a.workspace.id, user.id, "settings.update", changed.join(", "));
  return json({ ok: true });
}

// ── team ─────────────────────────────────────────────────────────────────────

const addMemberSchema = z.object({ username: text(32).min(3), role: z.enum(["admin", "agent"]).default("agent"), phone: z.string().max(32).optional() });
const patchMemberSchema = z.object({
  role: z.enum(["admin", "agent"]).optional(),
  phone: z.string().max(32).nullable().optional(),
  availability: z.enum(["available", "busy", "away"]).optional(),
});

async function members(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  const [userId] = rest;
  if (req.method === "POST") {
    if (!isAdmin(a)) throw forbidden("Only admins can add teammates.");
    const input = await body(req, addMemberSchema);
    const target = await one<{ id: string }>("SELECT id FROM users WHERE username = $1", [input.username.toLowerCase().replace(/^@/, "")]);
    if (!target) throw notFound("No वार्तालाप user with that username. Ask them to sign up first, then add them.");
    const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1", [a.workspace.id]);
    if ((count?.n ?? 0) >= 200) throw badRequest("A workspace can have up to 200 members.");
    const p = input.phone ? normalizePhone(input.phone) : null;
    await query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, phone) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [a.workspace.id, target.id, input.role, p],
    );
    await audit(a.workspace.id, user.id, "member.add", `@${input.username.replace(/^@/, "")} as ${input.role}`);
    return json({ ok: true });
  }
  const id = uuid.parse(userId);
  const target = await one<{ role: string }>("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [a.workspace.id, id]);
  if (!target) throw notFound("Not a member.");
  const self = id === user.id;
  if (req.method === "DELETE") {
    if (target.role === "owner") throw badRequest("The owner can't be removed.");
    if (!self && !isAdmin(a)) throw forbidden();
    await query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [a.workspace.id, id]);
    // Their open tickets go back to the queue so nothing is stranded.
    await query("UPDATE support_tickets SET assignee_id = NULL WHERE workspace_id = $1 AND assignee_id = $2 AND status IN ('open', 'pending')", [a.workspace.id, id]);
    await audit(a.workspace.id, user.id, self ? "member.leave" : "member.remove", await nameOf(id));
    return json({ ok: true });
  }
  const input = await body(req, patchMemberSchema);
  if (!self && !isAdmin(a)) throw forbidden("You can only change your own status.");
  if (input.role && (!isAdmin(a) || target.role === "owner")) throw forbidden("That role can't be changed.");
  let p: string | null | undefined = undefined;
  if (input.phone !== undefined) {
    p = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !p) throw badRequest("Enter a valid phone number, e.g. +91 98765 43210");
  }
  await query(
    `UPDATE workspace_members SET role = coalesce($3, role), availability = coalesce($4, availability),
            phone = CASE WHEN $5 THEN $6 ELSE phone END
      WHERE workspace_id = $1 AND user_id = $2`,
    [a.workspace.id, id, input.role ?? null, input.availability ?? null, p !== undefined, p ?? null],
  );
  if (input.role && input.role !== target.role) await audit(a.workspace.id, user.id, "member.role", `${await nameOf(id)}: ${target.role} → ${input.role}`);
  if (p !== undefined && !self) await audit(a.workspace.id, user.id, "member.phone", await nameOf(id));
  return json({ ok: true });
}

async function nameOf(userId: string) {
  const u = await one<{ username: string }>("SELECT username FROM users WHERE id = $1", [userId]);
  return u ? `@${u.username}` : "a member";
}

// ── lines ────────────────────────────────────────────────────────────────────

const lineSchema = z.object({
  label: text(40).min(1),
  phoneNumber: phone,
  provider: z.enum(["simulator", "twilio", "exotel"]),
  channels: z.array(z.enum(["voice", "sms", "whatsapp"])).min(1),
  routing: z.enum(["ring_all", "round_robin", "owner_first"]).default("ring_all"),
  missedCallReply: text(320).nullable().optional(),
  recordCalls: z.boolean().default(false),
  active: z.boolean().default(true),
});

function lineView(l: LineRow) {
  return {
    id: l.id, label: l.label, phoneNumber: l.phone_number, provider: l.provider, channels: l.channels, routing: l.routing,
    missedCallReply: l.missed_call_reply, recordCalls: l.record_calls, active: l.active,
  };
}

async function lines(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  if (!isAdmin(a)) throw forbidden("Only admins can manage numbers.");
  if (req.method === "POST") {
    const input = await body(req, lineSchema);
    const id = randomUUID();
    await query(
      `INSERT INTO business_lines (id, workspace_id, label, phone_number, provider, channels, routing, missed_call_reply, record_calls, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, a.workspace.id, input.label, input.phoneNumber, input.provider, input.channels, input.routing, input.missedCallReply ?? null, input.recordCalls, input.active],
    );
    await audit(a.workspace.id, user.id, "line.add", `${input.label} ${input.phoneNumber} (${input.provider})`);
    return json({ id });
  }
  const id = uuid.parse(rest[0]);
  if (req.method === "DELETE") {
    const gone = await one<{ label: string; phone_number: string }>("DELETE FROM business_lines WHERE id = $1 AND workspace_id = $2 RETURNING label, phone_number", [id, a.workspace.id]);
    if (gone) await audit(a.workspace.id, user.id, "line.delete", `${gone.label} ${gone.phone_number}`);
    return json({ ok: true });
  }
  const input = await body(req, lineSchema.partial());
  await query(
    `UPDATE business_lines SET label = coalesce($3, label), phone_number = coalesce($4, phone_number), provider = coalesce($5, provider),
            channels = coalesce($6, channels), routing = coalesce($7, routing),
            missed_call_reply = CASE WHEN $8 THEN $9 ELSE missed_call_reply END,
            record_calls = coalesce($10, record_calls), active = coalesce($11, active)
      WHERE id = $1 AND workspace_id = $2`,
    [id, a.workspace.id, input.label ?? null, input.phoneNumber ?? null, input.provider ?? null, input.channels ?? null, input.routing ?? null,
      input.missedCallReply !== undefined, input.missedCallReply ?? null, input.recordCalls ?? null, input.active ?? null],
  );
  const what = Object.keys(input).join(", ");
  if (what) await audit(a.workspace.id, user.id, "line.update", what);
  return json({ ok: true });
}

// ── contacts ─────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  name: text(80).min(1),
  phone,
  email: text(120).default(""),
  company: text(80).default(""),
  tags: z.array(text(24)).max(12).default([]),
  stage: z.enum(STAGE_IDS).default("new"),
  source: text(30).default("manual"),
  value: z.number().int().min(0).max(1e13).default(0),
});
const importSchema = z.object({ contacts: z.array(z.unknown()).min(1).max(2000) });
const patchContactSchema = z.object({
  name: text(80).min(1).optional(),
  phone: phone.optional(),
  email: text(120).optional(),
  company: text(80).optional(),
  tags: z.array(text(24)).max(12).optional(),
  stage: z.enum(STAGE_IDS).optional(),
  value: z.number().int().min(0).max(1e13).optional(),
  ownerId: uuid.nullable().optional(),
});

const CONTACT_SQL = `SELECT c.*, u.display_name AS owner_name FROM crm_contacts c LEFT JOIN users u ON u.id = c.owner_id`;

async function contacts(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  const ws = a.workspace.id;
  const [id, sub] = rest;

  if (!id && req.method === "GET") {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 60);
    const stage = req.nextUrl.searchParams.get("stage");
    const digits = q.replace(/\D/g, "");
    const rows = await query<ContactRow>(
      `${CONTACT_SQL} WHERE c.workspace_id = $1
         AND ($2 = '' OR lower(c.name) LIKE '%' || $2 || '%' OR lower(c.company) LIKE '%' || $2 || '%'
              OR ($3 <> '' AND c.phone LIKE '%' || $3 || '%') OR $2 = ANY(SELECT lower(t) FROM unnest(c.tags) t))
         AND ($4::text IS NULL OR c.stage = $4)
       ORDER BY c.updated_at DESC LIMIT 500`,
      [ws, q, digits.length >= 3 ? digits : "", stage && STAGE_IDS.includes(stage as never) ? stage : null],
    );
    return json({ contacts: rows.map((c) => contactView(a, c)) });
  }

  if (!id && req.method === "POST") {
    await rateLimit(`contacts:${user.id}`, 60, 60);
    const input = await body(req, importSchema);
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    await tx(async (q) => {
      for (const [i, raw] of input.contacts.entries()) {
        const parsed = contactSchema.safeParse(raw);
        if (!parsed.success) {
          if (errors.length < 10) errors.push(`Row ${i + 1}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
          continue;
        }
        const c = parsed.data;
        const row = await q.query<{ id: string; inserted: boolean }>(
          `INSERT INTO crm_contacts (id, workspace_id, name, phone, email, company, tags, stage, source, value_paise, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (workspace_id, phone) DO UPDATE SET name = EXCLUDED.name,
             email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE crm_contacts.email END,
             company = CASE WHEN EXCLUDED.company <> '' THEN EXCLUDED.company ELSE crm_contacts.company END,
             updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
          [randomUUID(), ws, c.name, c.phone, c.email, c.company, c.tags, c.stage, c.source, c.value, user.id],
        );
        const r = row.rows[0];
        if (r.inserted) {
          created++;
          await activity(q, ws, r.id, user.id, "created", input.contacts.length > 1 ? "Imported from CSV" : "Lead added");
        } else updated++;
      }
    });
    return json({ created, updated, errors });
  }

  const contactId = uuid.parse(id);
  const contact = await one<ContactRow>(`${CONTACT_SQL} WHERE c.id = $1 AND c.workspace_id = $2`, [contactId, ws]);
  if (!contact) throw notFound("Contact not found.");

  if (sub === "notes" && req.method === "POST") {
    const input = await body(req, z.object({ body: text(2000).min(1) }));
    await activity(null, ws, contactId, user.id, "note", input.body);
    await query("UPDATE crm_contacts SET updated_at = now() WHERE id = $1", [contactId]);
    return json({ ok: true });
  }

  if (req.method === "GET") {
    const [acts, callRows, msgs, taskRows] = await Promise.all([
      query<{ id: string; kind: string; body: string; created_at: Date; actor_name: string | null }>(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS actor_name
           FROM crm_activities a LEFT JOIN users u ON u.id = a.actor_id WHERE a.contact_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
        [contactId],
      ),
      query<CallRow>(CALL_SQL + " WHERE c.contact_id = $1 ORDER BY c.started_at DESC LIMIT 100", [contactId]),
      query<MessageRow>(MSG_SQL + " WHERE m.contact_id = $1 AND m.created_at <= now() ORDER BY m.created_at LIMIT 300", [contactId]),
      query<TaskRow>(TASK_SQL + " WHERE t.contact_id = $1 ORDER BY t.done_at NULLS FIRST, t.due_at LIMIT 50", [contactId]),
    ]);
    return json({
      contact: contactView(a, contact),
      activities: acts.map((x) => ({ id: x.id, kind: x.kind, body: x.body, createdAt: x.created_at, actorName: x.actor_name })),
      calls: callRows.map((c) => callView(a, c)),
      messages: msgs.map(messageView),
      tasks: taskRows.map((t) => taskView(t)),
    });
  }

  if (req.method === "DELETE") {
    if (!isAdmin(a)) throw forbidden("Only admins can delete contacts.");
    await query("DELETE FROM crm_contacts WHERE id = $1", [contactId]);
    await audit(ws, user.id, "contact.delete", contact.name);
    return json({ ok: true });
  }

  const input = await body(req, patchContactSchema);
  if (input.phone && a.masked) throw forbidden("Agents can't change a customer's number.");
  await tx(async (q) => {
    await q.query(
      `UPDATE crm_contacts SET name = coalesce($2, name), phone = coalesce($3, phone), email = coalesce($4, email), company = coalesce($5, company),
              tags = coalesce($6, tags), stage = coalesce($7, stage), value_paise = coalesce($8, value_paise),
              owner_id = CASE WHEN $9 THEN $10 ELSE owner_id END, updated_at = now()
        WHERE id = $1`,
      [contactId, input.name ?? null, input.phone ?? null, input.email ?? null, input.company ?? null, input.tags ?? null, input.stage ?? null,
        input.value ?? null, input.ownerId !== undefined, input.ownerId ?? null],
    );
    if (input.stage && input.stage !== contact.stage) await activity(q, ws, contactId, user.id, "stage", `Stage: ${contact.stage} → ${input.stage}`);
    if (input.ownerId !== undefined && input.ownerId !== contact.owner_id) await activity(q, ws, contactId, user.id, "owner", "Lead reassigned");
  });
  return json({ ok: true });
}

// ── calls (click-to-call bridge) ─────────────────────────────────────────────

type CallRow = {
  id: string; line_id: string | null; contact_id: string | null; agent_id: string | null; direction: string; status: string;
  remote_number: string; provider: string; disposition: string | null; notes: string; recording_url: string | null; duration_sec: number;
  started_at: Date; answered_at: Date | null; ended_at: Date | null; contact_name: string | null; agent_name: string | null; line_label: string | null;
};
const CALL_SQL = `SELECT c.*, ct.name AS contact_name, u.display_name AS agent_name, l.label AS line_label
  FROM crm_calls c LEFT JOIN crm_contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN business_lines l ON l.id = c.line_id`;

function callView(a: Access, c: CallRow) {
  return {
    id: c.id, lineId: c.line_id, lineLabel: c.line_label, contactId: c.contact_id, contactName: c.contact_name, agentId: c.agent_id, agentName: c.agent_name,
    direction: c.direction, status: c.status, remoteNumber: showPhone(a, c.remote_number), provider: c.provider, disposition: c.disposition, notes: c.notes,
    recordingUrl: c.recording_url, durationSec: c.duration_sec, startedAt: c.started_at, answeredAt: c.answered_at, endedAt: c.ended_at,
  };
}

const placeSchema = z.object({ lineId: uuid, contactId: uuid.optional(), number: z.string().max(32).optional() });
const patchCallSchema = z.object({
  status: z.enum(["in-progress", "completed", "no-answer", "busy", "canceled"]).optional(),
  disposition: z.enum(DISPOSITIONS).nullable().optional(),
  notes: text(4000).optional(),
});

async function calls(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  const ws = a.workspace.id;
  if (req.method === "GET" && !rest[0]) {
    const mine = req.nextUrl.searchParams.get("mine") === "1";
    const rows = await query<CallRow>(
      CALL_SQL + " WHERE c.workspace_id = $1 AND ($2::uuid IS NULL OR c.agent_id = $2) ORDER BY c.started_at DESC LIMIT 300",
      [ws, mine ? user.id : null],
    );
    return json({ calls: rows.map((c) => callView(a, c)) });
  }

  if (req.method === "POST" && rest[0] === "simulate-inbound") {
    if (!isAdmin(a)) throw forbidden("Only admins can run the demo.");
    await rateLimit(`sim-inbound:${user.id}`, 10, 60);
    const line = await one<LineRow>("SELECT * FROM business_lines WHERE workspace_id = $1 AND provider = 'simulator' AND active ORDER BY created_at LIMIT 1", [ws]);
    if (!line) throw badRequest("Inbound simulation needs an active demo line.");
    const contact = await one<{ id: string; phone: string; name: string }>("SELECT id, phone, name FROM crm_contacts WHERE workspace_id = $1 ORDER BY random() LIMIT 1", [ws]);
    if (!contact) throw badRequest("Add a lead first.");
    const id = randomUUID();
    await query(
      `INSERT INTO crm_calls (id, workspace_id, line_id, contact_id, direction, status, remote_number, provider, ended_at)
       VALUES ($1, $2, $3, $4, 'inbound', 'missed', $5, 'simulator', now())`,
      [id, ws, line.id, contact.id, contact.phone],
    );
    await touchContact(contact.id);
    await activity(null, ws, contact.id, null, "call", `Missed inbound call on ${line.label} (demo)`);
    const ticket = await missedCallTicket(ws, contact.id, contact.phone, line.label);
    return json({ callId: id, contactName: contact.name, ticket });
  }

  if (req.method === "POST" && !rest[0]) {
    await rateLimit(`dial:${user.id}`, 30, 60);
    const input = await body(req, placeSchema);
    const line = await one<LineRow>("SELECT * FROM business_lines WHERE id = $1 AND workspace_id = $2", [input.lineId, ws]);
    if (!line || !line.active) throw badRequest("Pick an active business line.");
    if (!line.channels.includes("voice")) throw badRequest("This line isn't set up for voice calls.");
    let contactId = input.contactId ?? null;
    let customer: string | null = null;
    if (contactId) {
      const c = await one<{ phone: string }>("SELECT phone FROM crm_contacts WHERE id = $1 AND workspace_id = $2", [contactId, ws]);
      if (!c) throw notFound("Contact not found.");
      customer = c.phone;
    } else {
      if (a.masked) throw forbidden("Agents dial from the contact list so customer numbers stay masked.");
      customer = input.number ? normalizePhone(input.number) : null;
      if (!customer) throw badRequest("Enter a valid number, e.g. +91 98765 43210");
      const existing = await one<{ id: string }>("SELECT id FROM crm_contacts WHERE workspace_id = $1 AND phone = $2", [ws, customer]);
      contactId = existing?.id ?? null;
    }
    const agent = await one<{ phone: string | null }>("SELECT phone FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, user.id]);
    if (line.provider !== "simulator" && !agent?.phone) {
      throw badRequest("Add your own mobile number under Team → You first. The line rings your phone, then connects the customer.");
    }
    const id = randomUUID();
    await query(
      `INSERT INTO crm_calls (id, workspace_id, line_id, contact_id, agent_id, direction, status, remote_number, provider)
       VALUES ($1, $2, $3, $4, $5, 'outbound', 'queued', $6, $7)`,
      [id, ws, line.id, contactId, user.id, customer, line.provider],
    );
    try {
      const res = await placeCall(req, line, { callId: id, agentPhone: agent?.phone ?? "", customerPhone: customer });
      await query("UPDATE crm_calls SET provider_sid = $2, status = $3 WHERE id = $1", [id, res.sid, res.status]);
    } catch (error) {
      await query("UPDATE crm_calls SET status = 'failed', ended_at = now(), notes = $2 WHERE id = $1", [id, (error as Error).message.slice(0, 300)]);
      throw error;
    }
    await touchContact(contactId);
    if (contactId) await activity(null, ws, contactId, user.id, "call", `Outbound call via ${line.label}`);
    const row = await one<CallRow>(CALL_SQL + " WHERE c.id = $1", [id]);
    return json({ call: callView(a, row!) });
  }

  const id = uuid.parse(rest[0]);
  const call = await one<CallRow>(CALL_SQL + " WHERE c.id = $1 AND c.workspace_id = $2", [id, ws]);
  if (!call) throw notFound("Call not found.");
  if (req.method === "GET") return json({ call: callView(a, call) });
  if (call.agent_id !== user.id && !isAdmin(a)) throw forbidden("Only the agent on this call can update it.");
  const input = await body(req, patchCallSchema);
  // Real carriers report status via webhooks; only simulated calls take status from the client.
  if (input.status && call.provider !== "simulator") throw badRequest("Status comes from the carrier for real calls.");
  const final = input.status && input.status !== "in-progress";
  await query(
    `UPDATE crm_calls SET
        status = coalesce($2, status),
        answered_at = CASE WHEN $2 = 'in-progress' AND answered_at IS NULL THEN now() ELSE answered_at END,
        ended_at = CASE WHEN $3 THEN now() ELSE ended_at END,
        duration_sec = CASE WHEN $3 AND answered_at IS NOT NULL THEN greatest(0, extract(epoch FROM now() - answered_at))::int ELSE duration_sec END,
        disposition = CASE WHEN $4 THEN $5 ELSE disposition END,
        notes = coalesce($6, notes)
      WHERE id = $1`,
    [id, input.status ?? null, Boolean(final), input.disposition !== undefined, input.disposition ?? null, input.notes ?? null],
  );
  if (call.contact_id && (input.disposition || input.notes)) {
    await activity(null, ws, call.contact_id, user.id, "call", [input.disposition && `Call outcome: ${input.disposition}`, input.notes].filter(Boolean).join(" — "));
  }
  const row = await one<CallRow>(CALL_SQL + " WHERE c.id = $1", [id]);
  return json({ call: callView(a, row!) });
}

// ── messages (SMS / WhatsApp from the business number) ──────────────────────

type MessageRow = {
  id: string; contact_id: string | null; line_id: string | null; channel: string; direction: string; body: string; status: string;
  created_at: Date; agent_name: string | null;
};
const MSG_SQL = "SELECT m.*, u.display_name AS agent_name FROM crm_messages m LEFT JOIN users u ON u.id = m.agent_id";
function messageView(m: MessageRow) {
  return {
    id: m.id, contactId: m.contact_id, lineId: m.line_id, channel: m.channel, direction: m.direction, body: m.body, status: m.status,
    createdAt: m.created_at, agentName: m.agent_name,
  };
}

const sendSchema = z.object({ lineId: uuid, contactId: uuid, channel: z.enum(["sms", "whatsapp"]), body: text(1600).min(1) });

async function messages(req: NextRequest, user: SessionUser, a: Access) {
  const ws = a.workspace.id;
  if (req.method === "GET") {
    // Inbox: the latest message per contact, newest conversation first.
    const rows = await query<MessageRow & { contact_name: string; contact_phone: string; unanswered: boolean }>(
      `SELECT DISTINCT ON (m.contact_id) m.*, NULL AS agent_name, c.name AS contact_name, c.phone AS contact_phone,
              (m.direction = 'inbound') AS unanswered
         FROM crm_messages m JOIN crm_contacts c ON c.id = m.contact_id
        WHERE m.workspace_id = $1 AND m.created_at <= now()
        ORDER BY m.contact_id, m.created_at DESC`,
      [ws],
    );
    rows.sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
    return json({
      threads: rows.slice(0, 200).map((r) => ({
        contactId: r.contact_id, contactName: r.contact_name, contactPhone: showPhone(a, r.contact_phone), last: messageView(r), unanswered: r.unanswered,
      })),
    });
  }
  await rateLimit(`sms:${user.id}`, 60, 60);
  const input = await body(req, sendSchema);
  const [line, contact] = await Promise.all([
    one<LineRow>("SELECT * FROM business_lines WHERE id = $1 AND workspace_id = $2", [input.lineId, ws]),
    one<{ id: string; phone: string; name: string }>("SELECT id, phone, name FROM crm_contacts WHERE id = $1 AND workspace_id = $2", [input.contactId, ws]),
  ]);
  if (!line || !line.active) throw badRequest("Pick an active business line.");
  if (!line.channels.includes(input.channel)) throw badRequest(`This line isn't set up for ${input.channel === "sms" ? "SMS" : "WhatsApp"}.`);
  if (!contact) throw notFound("Contact not found.");
  const bodyText = input.body.replaceAll("{name}", contact.name.split(" ")[0]);
  const id = randomUUID();
  await query(
    "INSERT INTO crm_messages (id, workspace_id, line_id, contact_id, agent_id, channel, direction, body, status) VALUES ($1, $2, $3, $4, $5, $6, 'outbound', $7, 'queued')",
    [id, ws, line.id, contact.id, user.id, input.channel, bodyText],
  );
  try {
    const res = await sendMessage(req, line, { messageId: id, to: contact.phone, body: bodyText, channel: input.channel });
    await query("UPDATE crm_messages SET status = $2, provider_sid = $3 WHERE id = $1", [id, res.status, res.sid]);
  } catch (error) {
    await query("UPDATE crm_messages SET status = 'failed' WHERE id = $1", [id]);
    throw error;
  }
  await touchContact(contact.id);
  if (line.provider === "simulator") {
    // The demo customer "replies" a few seconds later so the two-way inbox can be shown end to end.
    const replies = ["Thanks! 👍", "Okay, noted. Will confirm by evening.", "Can you share more details?", "Sounds good, please go ahead.", "What's the final price?"];
    await query(
      `INSERT INTO crm_messages (id, workspace_id, line_id, contact_id, channel, direction, body, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'inbound', $6, 'received', now() + interval '4 seconds')`,
      [randomUUID(), ws, line.id, contact.id, input.channel, `${replies[Math.floor(Math.random() * replies.length)]} (simulated reply)`],
    );
  }
  return json({ ok: true, id });
}

// ── tasks / follow-ups ───────────────────────────────────────────────────────

type TaskRow = {
  id: string; contact_id: string | null; assignee_id: string | null; title: string; due_at: Date; done_at: Date | null;
  contact_name: string | null; assignee_name: string | null;
};
const TASK_SQL = `SELECT t.*, c.name AS contact_name, u.display_name AS assignee_name
  FROM crm_tasks t LEFT JOIN crm_contacts c ON c.id = t.contact_id LEFT JOIN users u ON u.id = t.assignee_id`;
function taskView(t: TaskRow) {
  return {
    id: t.id, contactId: t.contact_id, contactName: t.contact_name, assigneeId: t.assignee_id, assigneeName: t.assignee_name,
    title: t.title, dueAt: t.due_at, doneAt: t.done_at,
  };
}
const taskSchema = z.object({ title: text(200).min(1), dueAt: z.iso.datetime({ offset: true }), contactId: uuid.nullish(), assigneeId: uuid.nullish() });

async function tasks(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  const ws = a.workspace.id;
  if (req.method === "GET") {
    const rows = await query<TaskRow>(TASK_SQL + " WHERE t.workspace_id = $1 ORDER BY t.done_at NULLS FIRST, t.due_at LIMIT 300", [ws]);
    return json({ tasks: rows.map(taskView) });
  }
  if (req.method === "POST" && !rest[0]) {
    const input = await body(req, taskSchema);
    if (input.contactId) {
      const ok = await one("SELECT 1 FROM crm_contacts WHERE id = $1 AND workspace_id = $2", [input.contactId, ws]);
      if (!ok) throw notFound("Contact not found.");
    }
    if (input.assigneeId) {
      const ok = await one("SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2", [input.assigneeId, ws]);
      if (!ok) throw badRequest("Assignee isn't in this workspace.");
    }
    await query(
      "INSERT INTO crm_tasks (id, workspace_id, contact_id, assignee_id, title, due_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [randomUUID(), ws, input.contactId ?? null, input.assigneeId ?? user.id, input.title, input.dueAt, user.id],
    );
    if (input.contactId) await activity(null, ws, input.contactId, user.id, "task", `Follow-up: ${input.title}`);
    return json({ ok: true });
  }
  const id = uuid.parse(rest[0]);
  const task = await one<{ assignee_id: string | null; created_by: string | null }>("SELECT assignee_id, created_by FROM crm_tasks WHERE id = $1 AND workspace_id = $2", [id, ws]);
  if (!task) throw notFound("Follow-up not found.");
  // Agents can only tick off or delete their own follow-ups (or ones they created).
  if (!isAdmin(a) && task.assignee_id !== user.id && task.created_by !== user.id) throw forbidden("This follow-up belongs to a teammate.");
  if (req.method === "DELETE") {
    await query("DELETE FROM crm_tasks WHERE id = $1 AND workspace_id = $2", [id, ws]);
    return json({ ok: true });
  }
  const input = await body(req, z.object({ done: z.boolean() }));
  await query("UPDATE crm_tasks SET done_at = CASE WHEN $3 THEN now() END WHERE id = $1 AND workspace_id = $2", [id, ws, input.done]);
  return json({ ok: true });
}

// ── templates ────────────────────────────────────────────────────────────────

async function templates(req: NextRequest, _user: SessionUser, a: Access, rest: string[]) {
  const ws = a.workspace.id;
  if (req.method === "GET") {
    const rows = await query<{ id: string; name: string; body: string }>("SELECT id, name, body FROM crm_templates WHERE workspace_id = $1 ORDER BY name", [ws]);
    return json({ templates: rows });
  }
  if (!isAdmin(a)) throw forbidden("Only admins can edit templates.");
  if (req.method === "POST") {
    const input = await body(req, z.object({ name: text(40).min(1), body: text(1600).min(1) }));
    await query("INSERT INTO crm_templates (id, workspace_id, name, body) VALUES ($1, $2, $3, $4)", [randomUUID(), ws, input.name, input.body]);
    return json({ ok: true });
  }
  await query("DELETE FROM crm_templates WHERE id = $1 AND workspace_id = $2", [uuid.parse(rest[0]), ws]);
  return json({ ok: true });
}

// ── social hub ───────────────────────────────────────────────────────────────

const accountSchema = z.object({ platform: z.enum(SOCIAL_IDS), handle: text(200).min(1) });
const postSchema = z.object({
  body: text(5000).min(1),
  platforms: z.array(z.enum(SOCIAL_IDS)).min(1),
  link: z.union([z.literal(""), z.url().max(500)]).default(""),
  scheduledAt: z.iso.datetime({ offset: true }).nullish(),
  publishNow: z.boolean().default(false),
});

async function social(req: NextRequest, user: SessionUser, a: Access, rest: string[]) {
  const ws = a.workspace.id;
  const [kind, id] = rest;
  if (req.method === "GET") {
    await dispatchDuePosts(ws).catch(() => undefined);
    const [accounts, posts] = await Promise.all([
      query<{ id: string; platform: string; handle: string; profile_url: string }>("SELECT id, platform, handle, profile_url FROM social_accounts WHERE workspace_id = $1 ORDER BY platform, handle", [ws]),
      query<{ id: string; body: string; platforms: string[]; link: string; status: string; scheduled_at: Date | null; published_at: Date | null; error: string | null; created_at: Date; author: string | null }>(
        `SELECT p.id, p.body, p.platforms, p.link, p.status, p.scheduled_at, p.published_at, p.error, p.created_at, u.display_name AS author
           FROM social_posts p LEFT JOIN users u ON u.id = p.created_by WHERE p.workspace_id = $1 ORDER BY coalesce(p.scheduled_at, p.created_at) DESC LIMIT 200`,
        [ws],
      ),
    ]);
    return json({
      webhook: Boolean(process.env.SOCIAL_WEBHOOK_URL),
      accounts: accounts.map((x) => ({ id: x.id, platform: x.platform, handle: x.handle, profileUrl: x.profile_url })),
      posts: posts.map((p) => ({
        id: p.id, body: p.body, platforms: p.platforms, link: p.link, status: p.status, scheduledAt: p.scheduled_at, publishedAt: p.published_at,
        error: p.error, createdAt: p.created_at, author: p.author,
      })),
    });
  }
  if (kind === "accounts") {
    if (!isAdmin(a)) throw forbidden("Only admins can connect accounts.");
    if (req.method === "DELETE") {
      await query("DELETE FROM social_accounts WHERE id = $1 AND workspace_id = $2", [uuid.parse(id), ws]);
      return json({ ok: true });
    }
    const input = await body(req, accountSchema);
    const handle = cleanHandle(input.handle);
    if (!handle) throw badRequest("Enter a handle like @yourbrand or paste your profile link.");
    const platform = SOCIAL_PLATFORMS.find((p) => p.id === input.platform)!;
    await query(
      "INSERT INTO social_accounts (id, workspace_id, platform, handle, profile_url) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [randomUUID(), ws, input.platform, handle, platform.profile(handle)],
    );
    return json({ ok: true });
  }
  if (kind === "posts") {
    if (req.method === "POST" && !id) {
      await rateLimit(`social:${user.id}`, 30, 60);
      const input = await body(req, postSchema);
      for (const pid of input.platforms) {
        const p = SOCIAL_PLATFORMS.find((x) => x.id === pid)!;
        if (input.body.length > p.max) throw badRequest(`${p.name} allows ${p.max} characters — this post has ${input.body.length}.`);
      }
      const status = input.publishNow ? "sending" : input.scheduledAt ? "scheduled" : "draft";
      const postId = randomUUID();
      await query(
        "INSERT INTO social_posts (id, workspace_id, body, platforms, link, status, scheduled_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [postId, ws, input.body, input.platforms, input.link, status, input.scheduledAt ?? null, user.id],
      );
      let delivered: "webhook" | "manual" | null = null;
      if (input.publishNow) {
        if (process.env.SOCIAL_WEBHOOK_URL) {
          const ok = await publishViaWebhook({ id: postId, workspace_id: ws, body: input.body, platforms: input.platforms, link: input.link });
          if (!ok) throw new ApiError(502, "The publishing webhook failed. The post is saved — retry from the list.");
          delivered = "webhook";
        } else {
          await query("UPDATE social_posts SET status = 'published', published_at = now() WHERE id = $1", [postId]);
          delivered = "manual";
        }
      }
      return json({ id: postId, delivered });
    }
    const postId = uuid.parse(id);
    if (req.method === "DELETE") {
      await query("DELETE FROM social_posts WHERE id = $1 AND workspace_id = $2", [postId, ws]);
      return json({ ok: true });
    }
    const input = await body(req, z.object({ action: z.enum(["published", "retry", "draft"]) }));
    if (input.action === "retry") {
      const post = await one<{ id: string; workspace_id: string; body: string; platforms: string[]; link: string }>(
        "SELECT id, workspace_id, body, platforms, link FROM social_posts WHERE id = $1 AND workspace_id = $2", [postId, ws],
      );
      if (!post) throw notFound();
      if (!(await publishViaWebhook(post))) throw new ApiError(502, "The publishing webhook failed again.");
    } else {
      await query(
        "UPDATE social_posts SET status = $3, published_at = CASE WHEN $3 = 'published' THEN now() END WHERE id = $1 AND workspace_id = $2",
        [postId, ws, input.action],
      );
    }
    return json({ ok: true });
  }
  throw notFound();
}

// ── analytics & export ───────────────────────────────────────────────────────

async function analytics(req: NextRequest, _user: SessionUser, a: Access) {
  const ws = a.workspace.id;
  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
  const [daily, agents, dispositions, channels, sources, hours] = await Promise.all([
    query<{ day: string; calls: number; answered: number; talk: number; messages: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM crm_calls WHERE workspace_id = $1 AND started_at::date = d::date) AS calls,
              (SELECT count(*)::int FROM crm_calls WHERE workspace_id = $1 AND started_at::date = d::date AND status = 'completed') AS answered,
              (SELECT coalesce(sum(duration_sec), 0)::int FROM crm_calls WHERE workspace_id = $1 AND started_at::date = d::date) AS talk,
              (SELECT count(*)::int FROM crm_messages WHERE workspace_id = $1 AND created_at::date = d::date AND created_at <= now()) AS messages
         FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d ORDER BY d`,
      [ws, days],
    ),
    query<{ name: string; calls: number; answered: number; talk: number; messages: number; won: number }>(
      `SELECT u.display_name AS name,
              (SELECT count(*)::int FROM crm_calls c WHERE c.workspace_id = $1 AND c.agent_id = m.user_id AND c.started_at > now() - make_interval(days => $2)) AS calls,
              (SELECT count(*)::int FROM crm_calls c WHERE c.workspace_id = $1 AND c.agent_id = m.user_id AND c.status = 'completed' AND c.started_at > now() - make_interval(days => $2)) AS answered,
              (SELECT coalesce(sum(duration_sec), 0)::int FROM crm_calls c WHERE c.workspace_id = $1 AND c.agent_id = m.user_id AND c.started_at > now() - make_interval(days => $2)) AS talk,
              (SELECT count(*)::int FROM crm_messages x WHERE x.workspace_id = $1 AND x.agent_id = m.user_id AND x.created_at > now() - make_interval(days => $2)) AS messages,
              (SELECT count(*)::int FROM crm_contacts x WHERE x.workspace_id = $1 AND x.owner_id = m.user_id AND x.stage = 'won') AS won
         FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.display_name`,
      [ws, days],
    ),
    query<{ label: string; n: number }>(
      `SELECT coalesce(disposition, 'Not logged') AS label, count(*)::int AS n FROM crm_calls
        WHERE workspace_id = $1 AND status = 'completed' AND started_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 2 DESC`,
      [ws, days],
    ),
    query<{ label: string; n: number }>(
      `SELECT channel AS label, count(*)::int AS n FROM crm_messages WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2) AND created_at <= now() GROUP BY 1`,
      [ws, days],
    ),
    query<{ label: string; n: number; won: number }>(
      "SELECT source AS label, count(*)::int AS n, count(*) FILTER (WHERE stage = 'won')::int AS won FROM crm_contacts WHERE workspace_id = $1 GROUP BY 1 ORDER BY 2 DESC",
      [ws],
    ),
    query<{ hour: number; n: number }>(
      `SELECT extract(hour FROM started_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS n FROM crm_calls
        WHERE workspace_id = $1 AND direction = 'inbound' AND started_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`,
      [ws, days],
    ),
  ]);
  return json({ days, daily, agents, dispositions, channels, sources, hours });
}

async function exportCsv(_req: NextRequest, user: SessionUser, a: Access) {
  if (!isAdmin(a)) throw forbidden("Only admins can export contacts.");
  await rateLimit(`export:${user.id}`, 10, 3600);
  const rows = await query<ContactRow>(`${CONTACT_SQL} WHERE c.workspace_id = $1 ORDER BY c.created_at`, [a.workspace.id]);
  await audit(a.workspace.id, user.id, "contacts.export", `${rows.length} contacts`);
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    // Leading = + - @ would be run as a formula by spreadsheet apps.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [["name", "phone", "email", "company", "stage", "value_inr", "tags", "source", "owner", "created_at"].join(",")];
  for (const c of rows) {
    lines.push([c.name, c.phone, c.email, c.company, c.stage, c.value_paise / 100, c.tags.join("; "), c.source, c.owner_name ?? "", new Date(c.created_at).toISOString()].map(cell).join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}

// ── router ───────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, Handler> = {
  members, lines, contacts, calls, messages, tasks, templates, social, tickets, kb, helpdesk,
  audit: auditLog,
  analytics: (req, user, a) => analytics(req, user, a),
  export: (req, user, a) => exportCsv(req, user, a),
};

const dispatch = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const path = (await ctx.params).path ?? [];
  if (path.length === 0) {
    if (req.method === "GET") return listWorkspaces(user);
    if (req.method === "POST") return createWorkspace(req, user);
    throw notFound();
  }
  const [wsId, section, ...rest] = path;
  const a = await requireWorkspace(uuid.parse(wsId), user.id);
  if (!section) {
    if (req.method === "GET") return overview(req, user, a);
    if (req.method === "PATCH") return updateWorkspace(req, user, a);
    if (req.method === "DELETE") {
      if (a.role !== "owner") throw forbidden("Only the owner can delete the workspace.");
      await query("DELETE FROM workspaces WHERE id = $1", [a.workspace.id]);
      return json({ ok: true });
    }
    throw notFound();
  }
  const handler = SECTIONS[section];
  if (!handler) throw notFound();
  return handler(req, user, a, rest);
});

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
