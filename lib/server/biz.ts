import { randomUUID } from "node:crypto";
import { maskPhone, normalizePhone } from "@/lib/biz-shared";
import type { SlaPolicy } from "@/lib/helpdesk-shared";
import { one, query, type Queryable } from "./db";
import { forbidden, notFound } from "./http";

export type Role = "owner" | "admin" | "agent";
export type WorkspaceRow = { id: string; name: string; industry: string; owner_id: string; settings: WorkspaceSettings; created_at: Date };
export type WorkspaceSettings = {
  maskForAgents?: boolean; defaultCountry?: string; businessHours?: string; currency?: string;
  /** Public help centre at /help/:workspaceId (off until an admin turns it on). */
  helpCenter?: boolean; helpIntro?: string;
  /** New tickets go to the available agent with the fewest open tickets (default on). */
  autoAssign?: boolean;
  sla?: Partial<SlaPolicy>;
};

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

export type Access = { workspace: WorkspaceRow; role: Role; userId: string; masked: boolean };

/** Loads the workspace and checks the caller's role. Agents see masked customer numbers by default. */
export async function requireWorkspace(workspaceId: string, userId: string, min: Role = "agent"): Promise<Access> {
  const row = await one<WorkspaceRow & { role: Role }>(
    `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2 WHERE w.id = $1`,
    [workspaceId, userId],
  );
  if (!row) throw notFound("Workspace not found, or you're not a member.");
  if (RANK[row.role] < RANK[min]) throw forbidden(min === "owner" ? "Only the owner can do this." : "Only admins can do this.");
  const { role, ...workspace } = row;
  const masked = role === "agent" && workspace.settings?.maskForAgents !== false;
  return { workspace, role, userId, masked };
}

export function isAdmin(a: Access) {
  return a.role !== "agent";
}

export function showPhone(a: Access, phone: string | null) {
  if (!phone) return phone;
  return a.masked ? maskPhone(phone) : phone;
}

export type ContactRow = {
  id: string; workspace_id: string; name: string; phone: string; email: string; company: string; tags: string[];
  stage: string; source: string; value_paise: number; owner_id: string | null; last_contacted_at: Date | null;
  created_at: Date; updated_at: Date; owner_name?: string | null;
};

export function contactView(a: Access, c: ContactRow) {
  return {
    id: c.id,
    name: c.name,
    phone: showPhone(a, c.phone),
    masked: a.masked,
    email: a.masked && c.email ? c.email.replace(/^(.).*(@.*)$/, "$1•••$2") : c.email,
    company: c.company,
    tags: c.tags,
    stage: c.stage,
    source: c.source,
    value: c.value_paise,
    ownerId: c.owner_id,
    ownerName: c.owner_name ?? null,
    lastContactedAt: c.last_contacted_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export async function activity(q: Queryable | null, workspaceId: string, contactId: string, actorId: string | null, kind: string, text: string) {
  const sql = "INSERT INTO crm_activities (id, workspace_id, contact_id, actor_id, kind, body) VALUES ($1, $2, $3, $4, $5, $6)";
  const params = [randomUUID(), workspaceId, contactId, actorId, kind, text.slice(0, 2000)];
  if (q) await q.query(sql, params);
  else await query(sql, params);
}

/** Finds a contact by number, creating an "inbound" lead the first time a stranger calls or texts. */
export async function contactForNumber(workspaceId: string, rawPhone: string, source = "inbound") {
  const phone = normalizePhone(rawPhone) ?? rawPhone;
  const existing = await one<{ id: string }>("SELECT id FROM crm_contacts WHERE workspace_id = $1 AND phone = $2", [workspaceId, phone]);
  if (existing) return existing.id;
  const id = randomUUID();
  const row = await one<{ id: string }>(
    `INSERT INTO crm_contacts (id, workspace_id, name, phone, source) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, phone) DO UPDATE SET updated_at = now() RETURNING id`,
    [id, workspaceId, `New caller ${maskPhone(phone)}`, phone, source],
  );
  if (row?.id === id) await activity(null, workspaceId, id, null, "created", `Lead created automatically from an ${source} contact`);
  return row!.id;
}

export type LineRow = {
  id: string; workspace_id: string; label: string; phone_number: string; provider: "simulator" | "twilio" | "exotel";
  channels: string[]; routing: "ring_all" | "round_robin" | "owner_first"; missed_call_reply: string | null;
  record_calls: boolean; active: boolean; rr_cursor: number; created_at: Date;
};

export async function lineByNumber(number: string) {
  const phone = normalizePhone(number) ?? number;
  return one<LineRow>("SELECT * FROM business_lines WHERE phone_number = $1 AND active ORDER BY created_at LIMIT 1", [phone]);
}

/** Which agents' phones ring for an inbound call on this line. */
export async function agentsToRing(line: LineRow) {
  const agents = await query<{ user_id: string; phone: string; role: Role }>(
    `SELECT user_id, phone, role FROM workspace_members
      WHERE workspace_id = $1 AND availability = 'available' AND phone IS NOT NULL AND phone <> ''
      ORDER BY joined_at`,
    [line.workspace_id],
  );
  if (!agents.length) return [];
  if (line.routing === "round_robin") {
    const pick = agents[line.rr_cursor % agents.length];
    await query("UPDATE business_lines SET rr_cursor = rr_cursor + 1 WHERE id = $1", [line.id]);
    return [pick];
  }
  if (line.routing === "owner_first") {
    return [...agents].sort((a, b) => RANK[b.role] - RANK[a.role]).slice(0, 10);
  }
  return agents.slice(0, 10); // Twilio rings up to 10 numbers at once
}

export async function touchContact(contactId: string | null) {
  if (contactId) await query("UPDATE crm_contacts SET last_contacted_at = now(), updated_at = now(), stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END WHERE id = $1", [contactId]);
}

/**
 * Publishes due scheduled posts through SOCIAL_WEBHOOK_URL (Zapier, Make, n8n, Buffer…).
 * Without a webhook, due posts stay "scheduled" and the app reminds the team to publish them.
 */
export async function dispatchDuePosts(workspaceId?: string) {
  const hook = process.env.SOCIAL_WEBHOOK_URL;
  if (!hook) return 0;
  const due = await query<{ id: string; workspace_id: string; body: string; platforms: string[]; link: string; scheduled_at: Date }>(
    `UPDATE social_posts SET status = 'sending'
      WHERE id IN (SELECT id FROM social_posts WHERE status = 'scheduled' AND scheduled_at <= now() ${workspaceId ? "AND workspace_id = $1" : ""} LIMIT 25)
      RETURNING id, workspace_id, body, platforms, link, scheduled_at`,
    workspaceId ? [workspaceId] : [],
  );
  for (const post of due) await publishViaWebhook(post);
  return due.length;
}

export async function publishViaWebhook(post: { id: string; workspace_id: string; body: string; platforms: string[]; link: string }) {
  const hook = process.env.SOCIAL_WEBHOOK_URL;
  if (!hook) return false;
  const accounts = await query<{ platform: string; handle: string; profile_url: string }>(
    "SELECT platform, handle, profile_url FROM social_accounts WHERE workspace_id = $1 AND platform = ANY($2::text[])",
    [post.workspace_id, post.platforms],
  );
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.SOCIAL_WEBHOOK_SECRET ? { "x-vartalap-secret": process.env.SOCIAL_WEBHOOK_SECRET } : {}) },
      body: JSON.stringify({ event: "social.publish", postId: post.id, text: post.body, link: post.link || null, platforms: post.platforms, accounts }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
    await query("UPDATE social_posts SET status = 'published', published_at = now(), error = NULL WHERE id = $1", [post.id]);
    return true;
  } catch (error) {
    await query("UPDATE social_posts SET status = 'failed', error = $2 WHERE id = $1", [post.id, (error as Error).message.slice(0, 300)]);
    return false;
  }
}

/** Fills a fresh workspace with realistic sample data so a demo shows every screen working. */
export async function seedDemo(q: Queryable, workspaceId: string, ownerId: string, lineId: string, industry: string) {
  const travel = industry === "travel";
  const people: [string, string, string, string, number, string[]][] = [
    ["Ananya Sharma", "+919812345601", "Sharma Family", "qualified", 18500000, ["Goa", "family"]],
    ["Rahul Verma", "+919812345602", "Verma Exports", "proposal", 42000000, ["corporate", "Dubai"]],
    ["Priya Nair", "+919812345603", "", "new", 6500000, ["honeymoon"]],
    ["Mohammed Aslam", "+919812345604", "Aslam & Sons", "contacted", 9000000, ["Umrah"]],
    ["Kavya Reddy", "+919812345605", "", "won", 12500000, ["Kashmir", "repeat"]],
    ["Arjun Mehta", "+919812345606", "TechNova Pvt Ltd", "qualified", 76000000, ["corporate", "offsite"]],
    ["Sneha Kulkarni", "+919812345607", "", "lost", 4000000, ["budget"]],
    ["Vikram Singh", "+919812345608", "Singh Travels (B2B)", "new", 0, ["partner"]],
  ];
  const ids: string[] = [];
  for (const [i, [name, phone, company, stage, value, tags]] of people.entries()) {
    const id = randomUUID();
    ids.push(id);
    await q.query(
      `INSERT INTO crm_contacts (id, workspace_id, name, phone, email, company, tags, stage, source, value_paise, owner_id, last_contacted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(hours => $12), now() - make_interval(days => $13))`,
      [id, workspaceId, name, phone, `${name.split(" ")[0].toLowerCase()}@example.com`, company, travel ? tags : tags.slice(0, 1),
        stage, i % 3 === 0 ? "website" : i % 3 === 1 ? "instagram" : "referral", value, ownerId, i * 5 + 1, i + 2],
    );
    await q.query(
      "INSERT INTO crm_activities (id, workspace_id, contact_id, actor_id, kind, body, created_at) VALUES ($1, $2, $3, $4, 'created', $5, now() - make_interval(days => $6))",
      [randomUUID(), workspaceId, id, ownerId, "Lead added (sample data)", i + 2],
    );
  }
  const outcomes: [string, string, number, string | null][] = [
    ["outbound", "completed", 312, "Interested"], ["inbound", "completed", 184, "Sent quote"], ["outbound", "no-answer", 0, "No answer"],
    ["inbound", "missed", 0, null], ["outbound", "completed", 545, "Booked / converted"], ["outbound", "completed", 97, "Call back later"],
    ["inbound", "completed", 230, "Interested"], ["outbound", "busy", 0, null], ["outbound", "completed", 410, "Sent quote"],
  ];
  for (const [i, [direction, status, dur, disposition]] of outcomes.entries()) {
    const contact = ids[i % ids.length];
    const phone = people[i % people.length][1];
    const hoursAgo = i * 7 + 1;
    await q.query(
      `INSERT INTO crm_calls (id, workspace_id, line_id, contact_id, agent_id, direction, status, remote_number, provider, disposition, duration_sec, notes, started_at, answered_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'simulator', $9, $10, $11, now() - make_interval(hours => $12),
               CASE WHEN $10 > 0 THEN now() - make_interval(hours => $12) END, now() - make_interval(hours => $12) + make_interval(secs => $10))`,
      [randomUUID(), workspaceId, lineId, contact, ownerId, direction, status, phone, disposition, dur, dur > 300 ? "Discussed package options and dates." : "", hoursAgo],
    );
  }
  const texts: [number, string, string, number][] = [
    [0, "outbound", "Hi Ananya, sharing the Goa family package — 4N/5D, ₹1,85,000 all inclusive. Shall I block the dates?", 30],
    [0, "inbound", "Looks good! Can we add one more room for my parents?", 26],
    [1, "outbound", "Rahul ji, quote for the Dubai corporate trip is in your inbox. Valid till Friday.", 50],
    [3, "inbound", "Please call me after 6 pm regarding Umrah dates.", 8],
  ];
  for (const [ci, direction, body, minsAgo] of texts) {
    await q.query(
      `INSERT INTO crm_messages (id, workspace_id, line_id, contact_id, agent_id, channel, direction, body, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'delivered', now() - make_interval(mins => $9))`,
      [randomUUID(), workspaceId, lineId, ids[ci], direction === "outbound" ? ownerId : null, ci % 2 ? "sms" : "whatsapp", direction, body, minsAgo * 10],
    );
  }
  const tasks: [number, string, number][] = [
    [0, "Confirm extra room & send revised quote", 2], [1, "Follow up on Dubai quote", 26], [3, "Call back after 6 pm about Umrah", 5], [5, "Share offsite venue shortlist", -3],
  ];
  for (const [ci, title, dueHours] of tasks) {
    await q.query(
      "INSERT INTO crm_tasks (id, workspace_id, contact_id, assignee_id, title, due_at, created_by) VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $4)",
      [randomUUID(), workspaceId, ids[ci], ownerId, title, dueHours],
    );
  }
  const templates: [string, string][] = travel
    ? [
        ["Greeting", "Namaste {name}! Thank you for contacting us. How can we help plan your trip?"],
        ["Quote follow-up", "Hi {name}, just checking if you had a chance to look at the quote we shared. Happy to adjust dates or hotels."],
        ["Payment reminder", "Hi {name}, a gentle reminder that the advance for your booking is due today. Reply here if you need the payment link again."],
        ["Missed call", "Sorry we missed your call! We'll call you back shortly — or reply here with your query."],
      ]
    : [
        ["Greeting", "Hi {name}! Thanks for reaching out. How can we help you today?"],
        ["Follow-up", "Hi {name}, following up on our last conversation. Is now a good time to talk?"],
        ["Missed call", "Sorry we missed your call! We'll call you back shortly — or reply here."],
      ];
  for (const [name, body] of templates) {
    await q.query("INSERT INTO crm_templates (id, workspace_id, name, body) VALUES ($1, $2, $3, $4)", [randomUUID(), workspaceId, name, body]);
  }
  await q.query(
    `INSERT INTO social_posts (id, workspace_id, body, platforms, status, scheduled_at, created_by)
     VALUES ($1, $2, $3, ARRAY['instagram', 'facebook', 'whatsapp'], 'scheduled', now() + interval '1 day', $4),
            ($5, $2, $6, ARRAY['linkedin', 'x'], 'published', now() - interval '2 days', $4)`,
    [randomUUID(), workspaceId, travel ? "🏝️ Monsoon special: 3N/4D Kerala backwaters from ₹18,999 per person. DM us to book!" : "🎉 New offers this week — message us to know more!", ownerId,
      randomUUID(), travel ? "We just helped 40 colleagues from TechNova plan their offsite in Udaipur. Planning a team trip? Let's talk." : "Thank you to all our customers this month! 🙏"],
  );
}
