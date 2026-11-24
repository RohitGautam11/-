import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizePhone } from "@/lib/biz-shared";
import { CATEGORY_IDS, PRIORITY_IDS, rankArticles, TICKET_STATUS_IDS } from "@/lib/helpdesk-shared";
import type { SessionUser } from "./auth";
import { activity, contactForNumber, isAdmin, type Access } from "./biz";
import { one, query } from "./db";
import { audit, createTicket, TICKET_SQL, ticketEvent, ticketView, type TicketRow } from "./helpdesk";
import { badRequest, body, forbidden, json, notFound } from "./http";
import { rateLimit } from "./rate-limit";
import { uuid } from "./validation";

/**
 * Helpdesk sections of the Business API (mounted by app/api/biz/[[...path]]/route.ts):
 *   /api/biz/:ws/tickets[/:id[/reply]]   GET list · POST open · GET detail · PATCH · POST reply/note · DELETE (admins)
 *   /api/biz/:ws/kb[/:id]                GET · POST · PATCH · DELETE (admins write)
 *   /api/biz/:ws/helpdesk                GET live wallboard numbers
 *   /api/biz/:ws/audit                   GET audit log (admins)
 */

type Handler = (req: NextRequest, user: SessionUser, a: Access, rest: string[]) => Promise<Response>;
const text = (max: number) => z.string().trim().max(max);

const newTicketSchema = z.object({
  subject: text(160).min(3),
  description: text(5000).default(""),
  kind: z.enum(["issue", "callback", "question"]).default("issue"),
  priority: z.enum(PRIORITY_IDS).optional(),
  category: z.enum(CATEGORY_IDS).optional(),
  channel: text(30).default("manual"),
  contactId: uuid.nullish(),
  assigneeId: uuid.nullish(),
  requesterName: text(80).optional(),
  requesterPhone: z.string().max(32).optional(),
});

const patchTicketSchema = z.object({
  status: z.enum(TICKET_STATUS_IDS).optional(),
  priority: z.enum(PRIORITY_IDS).optional(),
  category: z.enum(CATEGORY_IDS).optional(),
  assigneeId: uuid.nullable().optional(),
});

const replySchema = z.object({ body: text(5000).min(1), internal: z.boolean().default(false), status: z.enum(TICKET_STATUS_IDS).optional() });

export const tickets: Handler = async (req, user, a, rest) => {
  const ws = a.workspace.id;
  const [id, sub] = rest;

  if (!id && req.method === "GET") {
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") ?? "open";
    const q = (sp.get("q") ?? "").trim().toLowerCase().slice(0, 60);
    const num = Number(q.replace(/^#/, ""));
    const rows = await query<TicketRow>(
      `${TICKET_SQL} WHERE t.workspace_id = $1
         AND CASE $2
               WHEN 'open' THEN t.status IN ('open', 'pending')
               WHEN 'mine' THEN t.status IN ('open', 'pending') AND t.assignee_id = $3
               WHEN 'unassigned' THEN t.status IN ('open', 'pending') AND t.assignee_id IS NULL
               WHEN 'breached' THEN t.status IN ('open', 'pending') AND ((t.first_response_at IS NULL AND t.first_response_due < now()) OR t.resolve_due < now())
               WHEN 'callbacks' THEN t.status IN ('open', 'pending') AND t.kind = 'callback'
               WHEN 'done' THEN t.status IN ('resolved', 'closed')
               ELSE true END
         AND ($4 = '' OR lower(t.subject) LIKE '%' || $4 || '%' OR lower(t.requester_name) LIKE '%' || $4 || '%' OR t.number = $5)
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                CASE WHEN t.first_response_at IS NULL THEN t.first_response_due ELSE t.resolve_due END
       LIMIT 300`,
      [ws, view, user.id, q.replace(/[\\%_]/g, ""), Number.isFinite(num) && num > 0 ? num : -1],
    );
    return json({ tickets: rows.map((t) => ticketView(a, t)) });
  }

  if (!id && req.method === "POST") {
    await rateLimit(`ticket:${user.id}`, 60, 60);
    const input = await body(req, newTicketSchema);
    let contactId = input.contactId ?? null;
    let phone: string | null = null;
    if (contactId) {
      const c = await one<{ phone: string; name: string }>("SELECT phone, name FROM crm_contacts WHERE id = $1 AND workspace_id = $2", [contactId, ws]);
      if (!c) throw notFound("Contact not found.");
      phone = c.phone;
      input.requesterName ||= c.name;
    } else if (input.requesterPhone) {
      phone = normalizePhone(input.requesterPhone);
      if (!phone) throw badRequest("Enter a valid phone number, e.g. +91 98765 43210");
      contactId = await contactForNumber(ws, phone, "helpdesk");
    }
    if (input.assigneeId) {
      const ok = await one("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, input.assigneeId]);
      if (!ok) throw badRequest("That person isn't in this workspace.");
    }
    const created = await createTicket({
      workspaceId: ws, settings: a.workspace.settings, subject: input.subject, description: input.description, kind: input.kind,
      priority: input.priority, category: input.category, channel: input.channel, contactId, requesterName: input.requesterName,
      requesterPhone: phone, createdBy: user.id, ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    });
    if (contactId) await activity(null, ws, contactId, user.id, "ticket", `Ticket #${created.number} opened: ${input.subject}`);
    return json(created);
  }

  const ticketId = uuid.parse(id);
  const ticket = await one<TicketRow>(`${TICKET_SQL} WHERE t.id = $1 AND t.workspace_id = $2`, [ticketId, ws]);
  if (!ticket) throw notFound("Ticket not found.");

  if (req.method === "GET") {
    const [events, articles, history] = await Promise.all([
      query<{ id: string; kind: string; body: string; created_at: Date; actor_name: string | null }>(
        `SELECT e.id, e.kind, e.body, e.created_at, u.display_name AS actor_name
           FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.ticket_id = $1 ORDER BY e.created_at LIMIT 500`,
        [ticketId],
      ),
      query<{ id: string; title: string; body: string }>("SELECT id, title, body FROM kb_articles WHERE workspace_id = $1 AND published LIMIT 300", [ws]),
      ticket.contact_id
        ? query<{ id: string; number: number; subject: string; status: string; created_at: Date }>(
          "SELECT id, number, subject, status, created_at FROM support_tickets WHERE contact_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 10",
          [ticket.contact_id, ticketId],
        )
        : Promise.resolve([]),
    ]);
    return json({
      ticket: ticketView(a, ticket),
      events: events.map((e) => ({ id: e.id, kind: e.kind, body: e.body, createdAt: e.created_at, actorName: e.actor_name })),
      suggestions: rankArticles(articles, `${ticket.subject} ${ticket.description}`, 3),
      history: history.map((h) => ({ id: h.id, number: h.number, subject: h.subject, status: h.status, createdAt: h.created_at })),
    });
  }

  if (req.method === "DELETE") {
    if (!isAdmin(a)) throw forbidden("Only admins can delete tickets.");
    await query("DELETE FROM support_tickets WHERE id = $1", [ticketId]);
    await audit(ws, user.id, "ticket.delete", `#${ticket.number} ${ticket.subject}`);
    return json({ ok: true });
  }

  if (sub === "reply" && req.method === "POST") {
    await rateLimit(`ticket-reply:${user.id}`, 120, 60);
    const input = await body(req, replySchema);
    await ticketEvent(null, ticketId, user.id, input.internal ? "note" : "reply", input.body);
    const next = input.status ?? (input.internal ? null : ticket.status === "open" ? "pending" : null);
    await query(
      `UPDATE support_tickets SET updated_at = now(),
              first_response_at = CASE WHEN $2 AND first_response_at IS NULL THEN now() ELSE first_response_at END,
              assignee_id = coalesce(assignee_id, $3),
              status = coalesce($4, status),
              resolved_at = CASE WHEN $4 IN ('resolved', 'closed') THEN now() WHEN $4 IN ('open', 'pending') THEN NULL ELSE resolved_at END
        WHERE id = $1`,
      [ticketId, !input.internal, user.id, next],
    );
    if (next && next !== ticket.status) await ticketEvent(null, ticketId, user.id, "event", `Status: ${ticket.status} → ${next}`);
    return json({ ok: true });
  }

  // PATCH: status, priority, category, assignment.
  const input = await body(req, patchTicketSchema);
  const owner = ticket.assignee_id === user.id;
  if (input.assigneeId !== undefined && input.assigneeId !== user.id && !isAdmin(a)) throw forbidden("Only admins can assign tickets to others.");
  if ((input.status || input.priority || input.category) && !owner && !isAdmin(a) && ticket.assignee_id) {
    throw forbidden("Only the assigned agent or an admin can change this ticket.");
  }
  if (input.assigneeId) {
    const ok = await one("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, input.assigneeId]);
    if (!ok) throw badRequest("That person isn't in this workspace.");
  }
  await query(
    `UPDATE support_tickets SET status = coalesce($2, status), priority = coalesce($3, priority), category = coalesce($4, category),
            assignee_id = CASE WHEN $5 THEN $6 ELSE assignee_id END, updated_at = now(),
            resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN coalesce(resolved_at, now()) WHEN $2 IN ('open', 'pending') THEN NULL ELSE resolved_at END
      WHERE id = $1`,
    [ticketId, input.status ?? null, input.priority ?? null, input.category ?? null, input.assigneeId !== undefined, input.assigneeId ?? null],
  );
  const changes: string[] = [];
  if (input.status && input.status !== ticket.status) changes.push(`Status: ${ticket.status} → ${input.status}`);
  if (input.priority && input.priority !== ticket.priority) changes.push(`Priority: ${ticket.priority} → ${input.priority}`);
  if (input.category && input.category !== ticket.category) changes.push(`Category: ${input.category}`);
  if (input.assigneeId !== undefined && input.assigneeId !== ticket.assignee_id) {
    const who = input.assigneeId ? await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [input.assigneeId]) : null;
    changes.push(who ? `Assigned to ${who.display_name}` : "Unassigned");
  }
  if (changes.length) await ticketEvent(null, ticketId, user.id, "event", changes.join(" · "));
  return json({ ok: true });
};

// ── knowledge base ───────────────────────────────────────────────────────────

const articleSchema = z.object({
  title: text(160).min(3),
  body: text(20_000).min(10),
  category: text(40).default("General"),
  published: z.boolean().default(true),
});

export const kb: Handler = async (req, user, a, rest) => {
  const ws = a.workspace.id;
  const [id] = rest;
  if (req.method === "GET") {
    const rows = await query<{ id: string; title: string; body: string; category: string; published: boolean; views: number; helpful: number; not_helpful: number; updated_at: Date }>(
      "SELECT id, title, body, category, published, views, helpful, not_helpful, updated_at FROM kb_articles WHERE workspace_id = $1 ORDER BY category, title LIMIT 500",
      [ws],
    );
    return json({
      articles: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, published: r.published, views: r.views, helpful: r.helpful, notHelpful: r.not_helpful, updatedAt: r.updated_at })),
    });
  }
  if (!isAdmin(a)) throw forbidden("Only admins can edit the knowledge base.");
  if (req.method === "POST" && !id) {
    const input = await body(req, articleSchema);
    const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM kb_articles WHERE workspace_id = $1", [ws]);
    if ((count?.n ?? 0) >= 500) throw badRequest("A workspace can have up to 500 articles.");
    const articleId = randomUUID();
    await query("INSERT INTO kb_articles (id, workspace_id, title, body, category, published, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      articleId, ws, input.title, input.body, input.category || "General", input.published, user.id,
    ]);
    await audit(ws, user.id, "kb.create", input.title);
    return json({ id: articleId });
  }
  const articleId = uuid.parse(id);
  if (req.method === "DELETE") {
    const gone = await one<{ title: string }>("DELETE FROM kb_articles WHERE id = $1 AND workspace_id = $2 RETURNING title", [articleId, ws]);
    if (gone) await audit(ws, user.id, "kb.delete", gone.title);
    return json({ ok: true });
  }
  const input = await body(req, articleSchema.partial());
  await query(
    `UPDATE kb_articles SET title = coalesce($3, title), body = coalesce($4, body), category = coalesce($5, category),
            published = coalesce($6, published), updated_at = now() WHERE id = $1 AND workspace_id = $2`,
    [articleId, ws, input.title ?? null, input.body ?? null, input.category ?? null, input.published ?? null],
  );
  return json({ ok: true });
};

// ── wallboard ────────────────────────────────────────────────────────────────

export const helpdesk: Handler = async (_req, _user, a) => {
  const ws = a.workspace.id;
  const [counts, agents, csat, firstReply, byCategory] = await Promise.all([
    one<{ open: number; pending: number; unassigned: number; breached: number; soon: number; callbacks: number; resolved_today: number; created_today: number }>(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status IN ('open', 'pending') AND assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE status IN ('open', 'pending') AND ((first_response_at IS NULL AND first_response_due < now()) OR resolve_due < now()))::int AS breached,
              count(*) FILTER (WHERE status IN ('open', 'pending') AND first_response_at IS NULL AND first_response_due BETWEEN now() AND now() + interval '1 hour')::int AS soon,
              count(*) FILTER (WHERE status IN ('open', 'pending') AND kind = 'callback')::int AS callbacks,
              count(*) FILTER (WHERE resolved_at >= date_trunc('day', now()))::int AS resolved_today,
              count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS created_today
         FROM support_tickets WHERE workspace_id = $1`,
      [ws],
    ),
    query<{ user_id: string; name: string; availability: string; open: number; resolved: number }>(
      `SELECT m.user_id, u.display_name AS name, m.availability,
              (SELECT count(*)::int FROM support_tickets t WHERE t.workspace_id = $1 AND t.assignee_id = m.user_id AND t.status IN ('open', 'pending')) AS open,
              (SELECT count(*)::int FROM support_tickets t WHERE t.workspace_id = $1 AND t.assignee_id = m.user_id AND t.resolved_at > now() - interval '7 days') AS resolved
         FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.display_name`,
      [ws],
    ),
    one<{ avg: number | null; n: number }>(
      "SELECT avg(csat)::float AS avg, count(csat)::int AS n FROM support_tickets WHERE workspace_id = $1 AND csat IS NOT NULL AND created_at > now() - interval '30 days'",
      [ws],
    ),
    one<{ mins: number | null; met: number; total: number }>(
      `SELECT avg(extract(epoch FROM first_response_at - created_at) / 60)::float AS mins,
              count(*) FILTER (WHERE first_response_at <= first_response_due)::int AS met, count(*)::int AS total
         FROM support_tickets WHERE workspace_id = $1 AND first_response_at IS NOT NULL AND created_at > now() - interval '30 days'`,
      [ws],
    ),
    query<{ label: string; n: number }>(
      "SELECT category AS label, count(*)::int AS n FROM support_tickets WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC",
      [ws],
    ),
  ]);
  const kbStats = await one<{ articles: number; views: number; helpful: number }>(
    "SELECT count(*)::int AS articles, coalesce(sum(views), 0)::int AS views, coalesce(sum(helpful), 0)::int AS helpful FROM kb_articles WHERE workspace_id = $1 AND published",
    [ws],
  );
  return json({
    counts, agents: agents.map((x) => ({ userId: x.user_id, name: x.name, availability: x.availability, open: x.open, resolved: x.resolved })),
    csat: { avg: csat?.avg ?? null, count: csat?.n ?? 0 },
    firstReply: { avgMinutes: firstReply?.mins ?? null, slaMet: firstReply?.total ? Math.round((firstReply.met / firstReply.total) * 100) : null },
    byCategory, kb: kbStats,
    helpCenter: { enabled: a.workspace.settings.helpCenter === true, path: `/help/${ws}` },
  });
};

// ── audit log ────────────────────────────────────────────────────────────────

export const auditLog: Handler = async (_req, _user, a) => {
  if (!isAdmin(a)) throw forbidden("Only admins can see the audit log.");
  const rows = await query<{ id: number; action: string; detail: string; created_at: Date; actor_name: string | null }>(
    `SELECT l.id, l.action, l.detail, l.created_at, u.display_name AS actor_name
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.workspace_id = $1 ORDER BY l.id DESC LIMIT 200`,
    [a.workspace.id],
  );
  return json({ entries: rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at, actorName: r.actor_name })) });
};
