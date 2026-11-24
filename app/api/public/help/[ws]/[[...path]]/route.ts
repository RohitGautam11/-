import { z } from "zod";
import { normalizePhone } from "@/lib/biz-shared";
import { rankArticles } from "@/lib/helpdesk-shared";
import { activity, contactForNumber, type WorkspaceSettings } from "@/lib/server/biz";
import { one, query } from "@/lib/server/db";
import { createTicket, hashPublicToken, ticketEvent } from "@/lib/server/helpdesk";
import { badRequest, body, clientIp, json, notFound, route } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { uuid } from "@/lib/server/validation";

/**
 * Public help centre — no account needed. Only works once an admin turns it on.
 *   GET  /api/public/help/:ws?q=               workspace name, intro, articles (ranked when q is given)
 *   GET  /api/public/help/:ws/articles/:id     one article (counts a view)
 *   POST /api/public/help/:ws/articles/:id/vote { helpful }
 *   POST /api/public/help/:ws/tickets          raise an issue or request a callback → private tracking token
 *   GET  /api/public/help/:ws/tickets/:token   status + public replies
 *   POST /api/public/help/:ws/tickets/:token/reply | /rate
 */

type Ctx = { params: Promise<{ ws: string; path?: string[] }> };
const text = (max: number) => z.string().trim().max(max);

async function workspace(id: string) {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) throw notFound();
  const ws = await one<{ id: string; name: string; industry: string; settings: WorkspaceSettings }>(
    "SELECT id, name, industry, settings FROM workspaces WHERE id = $1", [parsed.data],
  );
  if (!ws || ws.settings?.helpCenter !== true) throw notFound("This help centre isn't available.");
  return ws;
}

const ticketSchema = z.object({
  kind: z.enum(["issue", "callback"]).default("issue"),
  name: text(80).min(2),
  phone: z.string().max(32).default(""),
  email: z.union([z.literal(""), z.email().max(120)]).default(""),
  subject: text(160).min(3),
  description: text(5000).default(""),
  preferredTime: text(80).default(""),
  website: z.string().max(200).default(""), // honeypot: people never see this field, bots fill it
});

type PublicTicket = {
  id: string; workspace_id: string; number: number; kind: string; subject: string; description: string; status: string; priority: string;
  requester_name: string; created_at: Date; updated_at: Date; resolved_at: Date | null; csat: number | null; contact_id: string | null; assignee_name: string | null;
};

async function ticketByToken(wsId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound("Ticket not found.");
  const t = await one<PublicTicket>(
    `SELECT t.id, t.workspace_id, t.number, t.kind, t.subject, t.description, t.status, t.priority, t.requester_name, t.created_at, t.updated_at,
            t.resolved_at, t.csat, t.contact_id, split_part(u.display_name, ' ', 1) AS assignee_name
       FROM support_tickets t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.public_token_hash = $1 AND t.workspace_id = $2`,
    [hashPublicToken(token), wsId],
  );
  if (!t) throw notFound("Ticket not found.");
  return t;
}

export const GET = route<Ctx>(async (req, ctx) => {
  const { ws: wsId, path = [] } = await ctx.params;
  await rateLimit(`help-read:${clientIp(req)}`, 240, 60);
  const ws = await workspace(wsId);
  const [section, id] = path;

  if (!section) {
    const rows = await query<{ id: string; title: string; body: string; category: string; helpful: number }>(
      "SELECT id, title, body, category, helpful FROM kb_articles WHERE workspace_id = $1 AND published ORDER BY helpful DESC, title LIMIT 300", [ws.id],
    );
    const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
    const list = q.trim() ? rankArticles(rows, q, 8) : rows;
    return json({
      workspace: { name: ws.name, industry: ws.industry, intro: ws.settings.helpIntro ?? "", hours: ws.settings.businessHours ?? "" },
      articles: list.map((a) => ({ id: a.id, title: a.title, category: a.category, excerpt: a.body.slice(0, 180) })),
    });
  }

  if (section === "articles" && id) {
    const a = await one<{ id: string; title: string; body: string; category: string; updated_at: Date }>(
      "UPDATE kb_articles SET views = views + 1 WHERE id = $1 AND workspace_id = $2 AND published RETURNING id, title, body, category, updated_at",
      [uuid.parse(id), ws.id],
    );
    if (!a) throw notFound("Article not found.");
    return json({ article: { id: a.id, title: a.title, body: a.body, category: a.category, updatedAt: a.updated_at } });
  }

  if (section === "tickets" && id) {
    const t = await ticketByToken(ws.id, id);
    const events = await query<{ id: string; kind: string; body: string; created_at: Date; actor_name: string | null }>(
      `SELECT e.id, e.kind, e.body, e.created_at, split_part(u.display_name, ' ', 1) AS actor_name
         FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.ticket_id = $1 AND e.kind IN ('reply', 'customer') ORDER BY e.created_at LIMIT 300`,
      [t.id],
    );
    return json({
      workspace: { name: ws.name },
      ticket: {
        number: t.number, kind: t.kind, subject: t.subject, description: t.description, status: t.status, requesterName: t.requester_name,
        agentName: t.assignee_name, createdAt: t.created_at, updatedAt: t.updated_at, resolvedAt: t.resolved_at, csat: t.csat,
      },
      messages: events.map((e) => ({ id: e.id, from: e.kind === "customer" ? "you" : "team", body: e.body, name: e.kind === "customer" ? null : e.actor_name, createdAt: e.created_at })),
    });
  }
  throw notFound();
});

export const POST = route<Ctx>(async (req, ctx) => {
  const { ws: wsId, path = [] } = await ctx.params;
  const ip = clientIp(req);
  const ws = await workspace(wsId);
  const [section, id, action] = path;

  if (section === "articles" && id && action === "vote") {
    const articleId = uuid.parse(id);
    const input = await body(req, z.object({ helpful: z.boolean() }));
    await rateLimit(`kb-vote:${ip}:${articleId}`, 1, 86_400);
    await query(
      `UPDATE kb_articles SET helpful = helpful + CASE WHEN $3 THEN 1 ELSE 0 END, not_helpful = not_helpful + CASE WHEN $3 THEN 0 ELSE 1 END
        WHERE id = $1 AND workspace_id = $2 AND published`,
      [articleId, ws.id, input.helpful],
    );
    return json({ ok: true });
  }

  if (section === "tickets" && !id) {
    await rateLimit(`help-ticket:${ip}`, 5, 3600);
    await rateLimit(`help-ticket-ws:${ws.id}`, 300, 3600);
    const input = await body(req, ticketSchema);
    if (input.website) return json({ number: 0, token: "" }); // a bot: pretend it worked, store nothing
    const phone = input.phone ? normalizePhone(input.phone, ws.settings.defaultCountry ?? "91") : null;
    if (input.phone && !phone) throw badRequest("Enter a valid phone number, e.g. +91 98765 43210");
    if (input.kind === "callback" && !phone) throw badRequest("Add a phone number so we can call you back.");
    if (!phone && !input.email) throw badRequest("Add a phone number or an email so the team can reach you.");
    const contactId = phone ? await contactForNumber(ws.id, phone, "help centre") : null;
    if (contactId) {
      await query("UPDATE crm_contacts SET name = $2 WHERE id = $1 AND name LIKE 'New caller %'", [contactId, input.name]);
      if (input.email) await query("UPDATE crm_contacts SET email = $2 WHERE id = $1 AND email = ''", [contactId, input.email]);
    }
    const created = await createTicket({
      workspaceId: ws.id, settings: ws.settings, kind: input.kind, channel: "help centre", subject: input.subject,
      description: input.description, contactId, requesterName: input.name, requesterPhone: phone, requesterEmail: input.email,
      preferredTime: input.preferredTime, withPublicToken: true,
    });
    if (contactId) await activity(null, ws.id, contactId, null, "ticket", `Ticket #${created.number} raised from the help centre: ${input.subject}`);
    return json({ number: created.number, token: created.token });
  }

  if (section === "tickets" && id && action === "reply") {
    await rateLimit(`help-reply:${ip}`, 30, 3600);
    const t = await ticketByToken(ws.id, id);
    if (t.status === "closed") throw badRequest("This ticket is closed. Please raise a new one.");
    const input = await body(req, z.object({ body: text(5000).min(1) }));
    await ticketEvent(null, t.id, null, "customer", input.body);
    // A customer writing back puts the ticket in front of the team again.
    await query("UPDATE support_tickets SET status = 'open', resolved_at = NULL, updated_at = now() WHERE id = $1", [t.id]);
    if (t.status !== "open") await ticketEvent(null, t.id, null, "event", `Customer replied · status ${t.status} → open`);
    return json({ ok: true });
  }

  if (section === "tickets" && id && action === "rate") {
    await rateLimit(`help-rate:${ip}`, 20, 3600);
    const t = await ticketByToken(ws.id, id);
    if (!["resolved", "closed"].includes(t.status)) throw badRequest("You can rate the support once your ticket is resolved.");
    if (t.csat) throw badRequest("Thanks — you've already rated this ticket.");
    const input = await body(req, z.object({ score: z.number().int().min(1).max(5), comment: text(500).default("") }));
    await query("UPDATE support_tickets SET csat = $2, csat_comment = $3 WHERE id = $1 AND csat IS NULL", [t.id, input.score, input.comment || null]);
    await ticketEvent(null, t.id, null, "event", `Customer rated the support ${input.score}/5${input.comment ? `: "${input.comment}"` : ""}`);
    return json({ ok: true });
  }
  throw notFound();
});
