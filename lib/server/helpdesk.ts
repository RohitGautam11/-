import { createHash, randomBytes, randomUUID } from "node:crypto";
import { maskPhone } from "@/lib/biz-shared";
import { slaFor, triage, type Category, type Priority } from "@/lib/helpdesk-shared";
import { showPhone, type Access, type WorkspaceSettings } from "./biz";
import { one, query, type Queryable } from "./db";

/** Records a sensitive admin action. Never throws: auditing must not break the action itself. */
export async function audit(workspaceId: string, actorId: string | null, action: string, detail = "") {
  await query("INSERT INTO audit_log (workspace_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)", [
    workspaceId, actorId, action.slice(0, 60), detail.slice(0, 500),
  ]).catch((error) => console.error("[audit]", error));
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("base64url");

/** A customer's private tracking link. Only its hash is stored, like a password. */
export function newPublicToken() {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: sha256(token) };
}
export const hashPublicToken = sha256;

/** The available teammate with the fewest open tickets takes the next one. */
export async function pickAssignee(workspaceId: string): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    `SELECT m.user_id FROM workspace_members m
      WHERE m.workspace_id = $1 AND m.availability = 'available'
      ORDER BY (SELECT count(*) FROM support_tickets t WHERE t.assignee_id = m.user_id AND t.workspace_id = $1 AND t.status IN ('open', 'pending')),
               m.joined_at
      LIMIT 1`,
    [workspaceId],
  );
  return row?.user_id ?? null;
}

export type NewTicket = {
  workspaceId: string;
  settings: WorkspaceSettings;
  subject: string;
  description?: string;
  kind?: "issue" | "callback" | "question";
  channel: string;
  priority?: Priority;
  category?: Category;
  contactId?: string | null;
  assigneeId?: string | null;
  requesterName?: string;
  requesterPhone?: string | null;
  requesterEmail?: string;
  preferredTime?: string;
  createdBy?: string | null;
  withPublicToken?: boolean;
};

/**
 * Opens a ticket: numbers it, triages it, sets SLA deadlines and auto-assigns it.
 * Runs as separate statements (not one transaction) so it can be called from anywhere,
 * including webhooks; the per-workspace counter is incremented atomically.
 */
export async function createTicket(t: NewTicket) {
  const smart = triage(t.subject, t.description ?? "");
  const priority = t.priority ?? (t.kind === "callback" ? "high" : smart.priority);
  const category = t.category ?? smart.category;
  const sla = slaFor(t.settings.sla, priority);
  const seq = await one<{ ticket_seq: number }>("UPDATE workspaces SET ticket_seq = ticket_seq + 1 WHERE id = $1 RETURNING ticket_seq", [t.workspaceId]);
  const assignee = t.assigneeId !== undefined ? t.assigneeId : t.settings.autoAssign === false ? null : await pickAssignee(t.workspaceId);
  const token = t.withPublicToken ? newPublicToken() : null;
  const id = randomUUID();
  await query(
    `INSERT INTO support_tickets (id, workspace_id, number, kind, subject, description, priority, category, sentiment, channel, contact_id, assignee_id,
                                  requester_name, requester_phone, requester_email, preferred_time, public_token_hash, first_response_due, resolve_due, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             now() + make_interval(mins => $18), now() + make_interval(mins => $19), $20)`,
    [id, t.workspaceId, seq?.ticket_seq ?? 1, t.kind ?? "issue", t.subject.slice(0, 160), (t.description ?? "").slice(0, 5000), priority, category,
      smart.sentiment, t.channel, t.contactId ?? null, assignee, (t.requesterName ?? "").slice(0, 80), t.requesterPhone ?? null,
      (t.requesterEmail ?? "").slice(0, 120), (t.preferredTime ?? "").slice(0, 80), token?.hash ?? null, sla.respond, sla.resolve, t.createdBy ?? null],
  );
  const why = smart.reasons.length && !t.priority ? ` Smart triage: ${smart.reasons.join(", ")}.` : "";
  await ticketEvent(null, id, t.createdBy ?? null, "event", `Ticket opened via ${t.channel}. Priority ${priority}.${why}${assignee ? "" : " Waiting for an agent."}`);
  return { id, number: seq?.ticket_seq ?? 1, token: token?.token ?? null, priority, category, assigneeId: assignee };
}

export async function ticketEvent(q: Queryable | null, ticketId: string, actorId: string | null, kind: "reply" | "note" | "event" | "customer", body: string) {
  const sql = "INSERT INTO ticket_events (id, ticket_id, actor_id, kind, body) VALUES ($1, $2, $3, $4, $5)";
  const params = [randomUUID(), ticketId, actorId, kind, body.slice(0, 5000)];
  if (q) await q.query(sql, params);
  else await query(sql, params);
}

/** A missed inbound call becomes a callback ticket with an SLA, so no caller is forgotten. */
export async function missedCallTicket(workspaceId: string, contactId: string, phone: string, lineLabel: string) {
  const open = await one("SELECT 1 FROM support_tickets WHERE contact_id = $1 AND kind = 'callback' AND status IN ('open', 'pending')", [contactId]);
  if (open) return null;
  const ws = await one<{ settings: WorkspaceSettings }>("SELECT settings FROM workspaces WHERE id = $1", [workspaceId]);
  const contact = await one<{ name: string }>("SELECT name FROM crm_contacts WHERE id = $1", [contactId]);
  return createTicket({
    workspaceId, settings: ws?.settings ?? {}, kind: "callback", channel: "missed call",
    subject: `Call back ${contact?.name ?? maskPhone(phone)}`,
    description: `Missed call on ${lineLabel}. Call the customer back.`, contactId, requesterName: contact?.name ?? "", requesterPhone: phone,
  });
}

export type TicketRow = {
  id: string; number: number; kind: string; subject: string; description: string; status: string; priority: string; category: string;
  sentiment: string; channel: string; contact_id: string | null; assignee_id: string | null; requester_name: string; requester_phone: string | null;
  requester_email: string; preferred_time: string; first_response_due: Date; resolve_due: Date; first_response_at: Date | null;
  resolved_at: Date | null; csat: number | null; csat_comment: string | null; created_at: Date; updated_at: Date;
  assignee_name?: string | null; contact_name?: string | null; contact_phone?: string | null;
};

export const TICKET_SQL = `SELECT t.*, u.display_name AS assignee_name, c.name AS contact_name, c.phone AS contact_phone
  FROM support_tickets t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN crm_contacts c ON c.id = t.contact_id`;

export function ticketView(a: Access, t: TicketRow) {
  const phone = t.requester_phone ?? t.contact_phone ?? null;
  return {
    id: t.id, number: t.number, kind: t.kind, subject: t.subject, description: t.description, status: t.status, priority: t.priority,
    category: t.category, sentiment: t.sentiment, channel: t.channel, contactId: t.contact_id, contactName: t.contact_name ?? null,
    assigneeId: t.assignee_id, assigneeName: t.assignee_name ?? null, requesterName: t.requester_name || t.contact_name || "",
    requesterPhone: showPhone(a, phone), requesterEmail: a.masked && t.requester_email ? t.requester_email.replace(/^(.).*(@.*)$/, "$1•••$2") : t.requester_email,
    preferredTime: t.preferred_time, firstResponseDue: t.first_response_due, resolveDue: t.resolve_due, firstResponseAt: t.first_response_at,
    resolvedAt: t.resolved_at, csat: t.csat, csatComment: t.csat_comment, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

/** Sample help-centre articles and tickets so a demo workspace shows the helpdesk working. */
export async function seedHelpdesk(q: Queryable, workspaceId: string, ownerId: string, travel: boolean) {
  const articles: [string, string, string][] = travel
    ? [
        ["How do I cancel or reschedule my booking?", "Reply on WhatsApp or raise a ticket with your booking reference. Free date changes are allowed up to 7 days before travel. Inside 7 days, the hotel and airline change fees apply — we always show them before confirming.", "Booking"],
        ["When will I get my refund?", "Refunds are started within 24 hours of a cancellation being confirmed. UPI and card refunds reach your account in 5–7 working days; bank transfers in 3 working days. You get a confirmation message with the reference number.", "Payments"],
        ["What documents do I need for international travel?", "A passport valid for at least 6 months after your return date, the visa for your destination, travel insurance, and printed hotel and flight confirmations. We send a checklist 10 days before departure.", "Travel"],
        ["How do I pay the advance?", "Pay the 25% advance by UPI, card or net banking using the payment link we send on WhatsApp. The balance is due 15 days before travel.", "Payments"],
      ]
    : [
        ["How do I track my request?", "When you raise a ticket you get a private tracking link. Open it any time to see the status and replies from our team, and to add more details.", "General"],
        ["What are your support hours?", "Our team replies Monday to Saturday, 9 am to 8 pm. Urgent issues raised outside these hours are picked up first thing the next morning.", "General"],
        ["How do refunds work?", "Approved refunds are started within 24 hours and reach your account in 5–7 working days. You'll receive a confirmation with the reference number.", "Payments"],
      ];
  for (const [title, body, category] of articles) {
    await q.query("INSERT INTO kb_articles (id, workspace_id, title, body, category, created_by, views, helpful) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      randomUUID(), workspaceId, title, body, category, ownerId, 20 + Math.floor(Math.random() * 120), 5 + Math.floor(Math.random() * 30),
    ]);
  }
  const contacts = await q.query<{ id: string; name: string; phone: string }>("SELECT id, name, phone FROM crm_contacts WHERE workspace_id = $1 ORDER BY created_at LIMIT 4", [workspaceId]);
  const samples: [string, string, Priority, string, string, number, string | null][] = [
    ["Charged twice for the Goa package", "I see two deductions of ₹46,250 on my card. Please refund one urgently, this is very frustrating!!!", "urgent", "billing", "web", 50, null],
    ["Need to change travel dates", "Can we move the Dubai trip from 12th to 19th? Same number of people.", "normal", "booking", "whatsapp", 300, "reply"],
    ["Visa documents checklist?", "What documents do we need for the Umrah visa?", "low", "general", "phone", 1500, "resolved"],
    ["Call back about honeymoon package", "Customer asked for a call after 6 pm.", "high", "booking", "missed call", 90, null],
  ];
  let n = 0;
  for (const [i, [subject, description, priority, category, channel, minsAgo, state]] of samples.entries()) {
    const c = contacts.rows[i % Math.max(1, contacts.rows.length)];
    n++;
    const sla = slaFor(undefined, priority);
    const id = randomUUID();
    const triaged = triage(subject, description);
    await q.query(
      `INSERT INTO support_tickets (id, workspace_id, number, kind, subject, description, priority, category, sentiment, channel, contact_id, assignee_id,
                                    requester_name, requester_phone, first_response_due, resolve_due, first_response_at, status, resolved_at, csat, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               now() - make_interval(mins => $15) + make_interval(mins => $16), now() - make_interval(mins => $15) + make_interval(mins => $17),
               CASE WHEN $18::text IS NOT NULL THEN now() - make_interval(mins => $15) + interval '20 minutes' END,
               CASE WHEN $18 = 'resolved' THEN 'resolved' WHEN $18 = 'reply' THEN 'pending' ELSE 'open' END,
               CASE WHEN $18 = 'resolved' THEN now() - interval '2 hours' END, CASE WHEN $18 = 'resolved' THEN 5 END,
               now() - make_interval(mins => $15), now() - make_interval(mins => $15))`,
      [id, workspaceId, n, channel === "missed call" ? "callback" : "issue", subject, description, priority, category, triaged.sentiment, channel,
        c?.id ?? null, ownerId, c?.name ?? "", c?.phone ?? null, minsAgo, sla.respond, sla.resolve, state],
    );
    await q.query("INSERT INTO ticket_events (id, ticket_id, actor_id, kind, body, created_at) VALUES ($1, $2, NULL, 'event', $3, now() - make_interval(mins => $4))", [
      randomUUID(), id, `Ticket opened via ${channel} (sample data).`, minsAgo,
    ]);
    if (state) {
      await q.query("INSERT INTO ticket_events (id, ticket_id, actor_id, kind, body, created_at) VALUES ($1, $2, $3, 'reply', $4, now() - make_interval(mins => $5) + interval '20 minutes')", [
        randomUUID(), id, ownerId, state === "resolved" ? "Sharing the checklist: passport (6+ months validity), photos, vaccination certificate. Let us know if you need help!" : "Sure! Checking availability for the 19th — will confirm within the hour.", minsAgo,
      ]);
    }
  }
  await q.query("UPDATE workspaces SET ticket_seq = $2 WHERE id = $1", [workspaceId, n]);
}
