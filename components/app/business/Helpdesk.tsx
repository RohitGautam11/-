"use client";

import {
  AlertTriangle, ArrowLeft, BookOpen, Copy, ExternalLink, Globe, Headset, Lightbulb, Lock, MessageSquareReply, Phone, PhoneMissed, Plus, Search,
  Settings2, Smile, Star, Trash2, UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, DEFAULT_SLA, PRIORITIES, slaState, TICKET_STATUSES, type Priority } from "@/lib/helpdesk-shared";
import { ago } from "@/lib/client/selectors";
import { useAction, useEngine, useToast } from "../context";
import { Empty, Modal, Spinner, Toggle, useNow } from "../ui";
import { duration, useBiz } from "./shared";

export type Ticket = {
  id: string; number: number; kind: "issue" | "callback" | "question"; subject: string; description: string; status: string; priority: Priority;
  category: string; sentiment: "positive" | "neutral" | "negative"; channel: string; contactId: string | null; contactName: string | null;
  assigneeId: string | null; assigneeName: string | null; requesterName: string; requesterPhone: string | null; requesterEmail: string;
  preferredTime: string; firstResponseDue: string; resolveDue: string; firstResponseAt: string | null; resolvedAt: string | null;
  csat: number | null; csatComment: string | null; createdAt: string; updatedAt: string;
};
type Detail = {
  ticket: Ticket;
  events: { id: string; kind: "reply" | "note" | "event" | "customer"; body: string; createdAt: string; actorName: string | null }[];
  suggestions: { id: string; title: string; body: string }[];
  history: { id: string; number: number; subject: string; status: string; createdAt: string }[];
};
type Board = {
  counts: { open: number; pending: number; unassigned: number; breached: number; soon: number; callbacks: number; resolved_today: number; created_today: number };
  agents: { userId: string; name: string; availability: string; open: number; resolved: number }[];
  csat: { avg: number | null; count: number };
  firstReply: { avgMinutes: number | null; slaMet: number | null };
  byCategory: { label: string; n: number }[];
  kb: { articles: number; views: number; helpful: number };
  helpCenter: { enabled: boolean; path: string };
};
type Article = { id: string; title: string; body: string; category: string; published: boolean; views: number; helpful: number; notHelpful: number; updatedAt: string };

const VIEWS = [
  { id: "open", label: "All open" }, { id: "mine", label: "Mine" }, { id: "unassigned", label: "Unassigned" },
  { id: "breached", label: "SLA breached" }, { id: "callbacks", label: "Callbacks" }, { id: "done", label: "Resolved" },
] as const;

const prio = (id: string) => PRIORITIES.find((p) => p.id === id) ?? PRIORITIES[2];
const cat = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;
const statusLabel = (id: string) => TICKET_STATUSES.find((s) => s.id === id)?.label ?? id;

/** Helpdesk: every customer problem as a ticket with an owner and an SLA clock, plus the knowledge base behind the help centre. */
export function Helpdesk() {
  const { isAdmin } = useBiz();
  const [tab, setTab] = useState<"tickets" | "kb" | "setup">("tickets");
  return (
    <div className="biz-page">
      <div className="segmented sm desk-tabs" data-tour="helpdesk-tabs">
        <button className={tab === "tickets" ? "active" : ""} onClick={() => setTab("tickets")}><Headset size={14} /> Tickets</button>
        <button className={tab === "kb" ? "active" : ""} onClick={() => setTab("kb")}><BookOpen size={14} /> Knowledge base</button>
        {isAdmin && <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}><Settings2 size={14} /> Help centre &amp; SLA</button>}
      </div>
      {tab === "tickets" && <Tickets />}
      {tab === "kb" && <KnowledgeBase />}
      {tab === "setup" && isAdmin && <Setup />}
    </div>
  );
}

// ── wallboard + queue ────────────────────────────────────────────────────────

function Tickets() {
  const { call, version } = useBiz();
  const toast = useToast();
  const [board, setBoard] = useState<Board | null>(null);
  const [list, setList] = useState<Ticket[] | null>(null);
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("open");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(() => Promise.all([
    call<Board>("helpdesk").then(setBoard),
    call<{ tickets: Ticket[] }>(`tickets?view=${view}&q=${encodeURIComponent(q.trim())}`).then((r) => setList(r.tickets)),
  ]).catch((e: Error) => toast(e.message, "error")), [call, view, q, toast]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [load, version, q]);

  const c = board?.counts;
  return (
    <>
      {board && c && (
        <div className="kpis wallboard" data-tour="wallboard">
          <Stat label="Open" value={c.open + c.pending} sub={`${c.pending} waiting on customer`} />
          <Stat label="SLA breached" value={c.breached} sub={`${c.soon} due within 1h`} tone={c.breached ? "bad" : undefined} onClick={() => setView("breached")} />
          <Stat label="Unassigned" value={c.unassigned} sub="pick one up" tone={c.unassigned ? "warn" : undefined} onClick={() => setView("unassigned")} />
          <Stat label="Callbacks" value={c.callbacks} sub="missed calls to return" tone={c.callbacks ? "warn" : undefined} onClick={() => setView("callbacks")} />
          <Stat label="First reply" value={board.firstReply.avgMinutes == null ? "—" : duration(Math.round(board.firstReply.avgMinutes * 60))} sub={board.firstReply.slaMet == null ? "no replies yet" : `${board.firstReply.slaMet}% within SLA`} />
          <Stat label="CSAT" value={board.csat.avg == null ? "—" : `${board.csat.avg.toFixed(1)}★`} sub={`${board.csat.count} ratings · 30 days`} />
          <Stat label="Resolved today" value={c.resolved_today} sub={`${c.created_today} new today`} />
        </div>
      )}

      <div className={`desk${open ? " has-open" : ""}`}>
        <section className="card-section desk-list">
          <div className="row between">
            <label className="search" style={{ margin: 0, flex: 1 }}><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, name or #number" /></label>
            <button className="btn btn-primary sm" onClick={() => setCreating(true)}><Plus size={16} /> New</button>
          </div>
          <div className="filters" style={{ padding: 0, flexWrap: "wrap" }}>
            {VIEWS.map((v) => <button key={v.id} className={view === v.id ? "active" : ""} onClick={() => setView(v.id)}>{v.label}</button>)}
          </div>
          {!list && <div className="center pad"><Spinner /></div>}
          {list && list.length === 0 && <Empty icon="🎉" title={view === "breached" ? "No SLA breaches" : "Queue is clear"}><p>Tickets from the help centre, missed calls and your team land here, sorted by urgency.</p></Empty>}
          {list?.map((t) => {
            const sla = slaState(t, now);
            const p = prio(t.priority);
            return (
              <button key={t.id} className={`ticket-row${open === t.id ? " selected" : ""}`} onClick={() => setOpen(t.id)}>
                <span className="prio-bar" style={{ background: p.color }} aria-hidden="true" />
                <span className="ticket-copy">
                  <span className="ticket-top">
                    <strong>{t.kind === "callback" && <PhoneMissed size={13} />} #{t.number} {t.subject}</strong>
                    <span className={`sla sla-${sla.state}`}>{sla.label}</span>
                  </span>
                  <small>
                    {t.requesterName || "Customer"} · {cat(t.category)} · {t.channel} · {t.assigneeName ?? "unassigned"} · {ago(t.updatedAt)}
                    {t.sentiment === "negative" ? " · 😟 upset" : ""}
                  </small>
                </span>
              </button>
            );
          })}
        </section>
        <section className="card-section desk-detail">
          {open
            ? <TicketDetail key={open} id={open} onBack={() => setOpen(null)} onChanged={() => void load()} />
            : (
              <div>
                <Empty icon="🎧" title="Pick a ticket"><p>Reply to the customer, add an internal note, call them back, or resolve it. The SLA clock shows how long you have.</p></Empty>
                {board && board.agents.length > 0 && (
                  <div className="agent-load">
                    <h3>Team load</h3>
                    {board.agents.map((a) => (
                      <div key={a.userId} className="hbar">
                        <span className="hbar-label"><span className={`avail-dot inline avail-${a.availability}`} /> {a.name}</span>
                        <span className="hbar-track"><i style={{ width: `${Math.min(100, a.open * 10)}%` }} /></span>
                        <b>{a.open} open · {a.resolved} done</b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
        </section>
      </div>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); void load(); }} />}
    </>
  );
}

function Stat({ label, value, sub, tone, onClick }: { label: string; value: string | number; sub: string; tone?: "warn" | "bad"; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return <Tag className={`kpi${tone ? ` kpi-${tone}` : ""}`} onClick={onClick}><span>{label}</span><b>{value}</b><small>{sub}</small></Tag>;
}

// ── one ticket ───────────────────────────────────────────────────────────────

function TicketDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { call, data, isAdmin, dial, openContact } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const [d, setD] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(() => call<Detail>(`tickets/${id}`).then(setD).catch((e: Error) => toast(e.message, "error")), [call, id, toast]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (!d) return <div className="center pad"><Spinner /></div>;
  const t = d.ticket;
  const sla = slaState(t, now);
  const patch = (body: Record<string, unknown>, msg?: string) => void run(async () => {
    await call(`tickets/${id}`, { method: "PATCH", body });
    await load();
    onChanged();
  }, msg);
  const send = (status?: string) => void run(async () => {
    await call(`tickets/${id}/reply`, { body: { body: text.trim(), internal, status } });
    setText("");
    await load();
    onChanged();
  }, internal ? "Note added" : status === "resolved" ? "Replied and resolved ✓" : "Reply sent");

  return (
    <div className="ticket-detail">
      <header className="row gap-xs thread-head">
        <button className="icon-btn back-inbox" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="grow">
          <strong className="ticket-title">#{t.number} {t.subject}</strong>
          <small className="muted block">
            {t.requesterName || "Customer"}{t.requesterPhone ? ` · ${t.requesterPhone}` : ""}{t.requesterEmail ? ` · ${t.requesterEmail}` : ""} · via {t.channel} · {ago(t.createdAt)}
          </small>
        </div>
        <span className={`sla sla-${sla.state}`}>{sla.label}</span>
      </header>

      <div className="ticket-controls">
        <label className="field"><span>Status</span>
          <select value={t.status} onChange={(e) => patch({ status: e.target.value }, "Status updated")}>
            {TICKET_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Priority</span>
          <select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        <label className="field"><span>Category</span>
          <select value={t.category} onChange={(e) => patch({ category: e.target.value })}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
        <label className="field"><span>Owner</span>
          {isAdmin ? (
            <select value={t.assigneeId ?? ""} onChange={(e) => patch({ assigneeId: e.target.value || null }, "Reassigned")}>
              <option value="">Unassigned</option>
              {data.members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </select>
          ) : (
            <span className="owner-cell">{t.assigneeName ?? "Unassigned"}</span>
          )}
        </label>
      </div>
      <div className="row gap-xs wrap">
        {!isAdmin && t.assigneeId == null && <TakeButton id={id} onDone={() => { void load(); onChanged(); }} />}
        {t.contactId && <button className="btn btn-ghost sm" onClick={() => dial({ contactId: t.contactId!, name: t.requesterName || "Customer", phone: t.requesterPhone ?? undefined })}><Phone size={15} /> Call {t.kind === "callback" ? "back" : ""}</button>}
        {t.contactId && <button className="btn btn-ghost sm" onClick={() => openContact(t.contactId!)}><UserCheck size={15} /> Open lead</button>}
        {isAdmin && <button className="btn btn-ghost sm danger-link" onClick={() => {
          if (confirm(`Delete ticket #${t.number}? This can't be undone.`)) void run(async () => { await call(`tickets/${id}`, { method: "DELETE" }); onBack(); onChanged(); }, "Ticket deleted");
        }}><Trash2 size={15} /> Delete</button>}
      </div>

      {t.preferredTime && <p className="banner"><Phone size={14} /> Best time to call: <b>{t.preferredTime}</b></p>}
      {t.csat && <p className="banner good"><Star size={14} /> Customer rated <b>{t.csat}/5</b>{t.csatComment ? ` — “${t.csatComment}”` : ""}</p>}

      <div className="thread ticket-thread">
        {t.description && <div className="sms in"><p>{t.description}</p><small>{t.requesterName || "Customer"} · {ago(t.createdAt)}</small></div>}
        {d.events.map((e) => e.kind === "event"
          ? <div key={e.id} className="system-pill">{e.body} · {ago(e.createdAt)}</div>
          : (
            <div key={e.id} className={`sms ${e.kind === "customer" ? "in" : "out"}${e.kind === "note" ? " note" : ""}`}>
              <p>{e.body}</p>
              <small>{e.kind === "note" ? "🔒 Internal note · " : ""}{e.kind === "customer" ? t.requesterName || "Customer" : e.actorName ?? "Team"} · {ago(e.createdAt)}</small>
            </div>
          ))}
      </div>

      {d.suggestions.length > 0 && (
        <div className="suggest">
          <small className="muted"><Lightbulb size={13} /> Suggested answers from your knowledge base</small>
          <div className="chips">
            {d.suggestions.map((s) => <button key={s.id} className="chip" title={s.body} onClick={() => setText((v) => `${v ? `${v}\n\n` : ""}${s.body}`)}>{s.title}</button>)}
          </div>
        </div>
      )}

      <div className={`reply-box${internal ? " is-note" : ""}`}>
        <div className="segmented sm">
          <button className={!internal ? "active" : ""} onClick={() => setInternal(false)}><MessageSquareReply size={14} /> Reply to customer</button>
          <button className={internal ? "active" : ""} onClick={() => setInternal(true)}><Lock size={14} /> Internal note</button>
        </div>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000}
          placeholder={internal ? "Only your team sees this…" : t.channel === "help centre" ? "The customer sees this on their tracking page…" : "Your reply (also call or message them from the lead)…"} />
        <div className="row gap-xs wrap">
          <button className="btn btn-primary sm" disabled={busy || !text.trim()} onClick={() => send()}>{internal ? "Add note" : "Send reply"}</button>
          {!internal && <button className="btn btn-ghost sm" disabled={busy || !text.trim()} onClick={() => send("resolved")}>Send &amp; resolve</button>}
        </div>
      </div>

      {d.history.length > 0 && (
        <details className="history">
          <summary>{d.history.length} earlier ticket{d.history.length > 1 ? "s" : ""} from this customer</summary>
          {d.history.map((h) => <div key={h.id} className="muted small">#{h.number} {h.subject} · {statusLabel(h.status)} · {ago(h.createdAt)}</div>)}
        </details>
      )}
    </div>
  );
}

function TakeButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { call } = useBiz();
  const engine = useEngine();
  const [run, busy] = useAction();
  return (
    <button className="btn btn-primary sm" disabled={busy} onClick={() => void run(async () => {
      await call(`tickets/${id}`, { method: "PATCH", body: { assigneeId: engine.me.id } });
      onDone();
    }, "It's yours")}><UserCheck size={15} /> Take it</button>
  );
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { call, isAdmin } = useBiz();
  const [run, busy] = useAction();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState<"issue" | "callback">("issue");
  const [priority, setPriority] = useState<"" | Priority>("");
  return (
    <Modal title="New ticket" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={busy || subject.trim().length < 3} onClick={() => void run(async () => {
        const res = await call<{ id: string }>("tickets", {
          body: { subject: subject.trim(), description: description.trim(), kind, channel: "phone", requesterName: name.trim() || undefined, requesterPhone: phone.trim() || undefined, priority: priority || undefined },
        });
        onCreated(res.id);
      }, "Ticket opened")}>Open ticket</button>
    }>
      <div className="segmented sm">
        <button className={kind === "issue" ? "active" : ""} onClick={() => setKind("issue")}>Issue</button>
        <button className={kind === "callback" ? "active" : ""} onClick={() => setKind("callback")}>Callback request</button>
      </div>
      <label className="field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} placeholder="e.g. Refund not received" /></label>
      <label className="field"><span>Details</span><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} placeholder="What did the customer say?" /></label>
      <div className="two-col">
        <label className="field"><span>Customer name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        {isAdmin && <label className="field"><span>Phone (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="+91 98765 43210" /></label>}
      </div>
      <label className="field"><span>Priority</span>
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | "")}>
          <option value="">Let smart triage decide</option>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <p className="muted small">Smart triage reads the words (English, Hindi, Hinglish) to suggest priority and category, then the ticket goes to the available agent with the lightest load.</p>
    </Modal>
  );
}

// ── knowledge base ───────────────────────────────────────────────────────────

function KnowledgeBase() {
  const { call, isAdmin } = useBiz();
  const toast = useToast();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [editing, setEditing] = useState<Article | "new" | null>(null);
  const load = useCallback(() => call<{ articles: Article[] }>("kb").then((r) => setArticles(r.articles)).catch((e: Error) => toast(e.message, "error")), [call, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card-section">
      <div className="row between">
        <h3><BookOpen size={17} /> Knowledge base</h3>
        {isAdmin && <button className="btn btn-primary sm" onClick={() => setEditing("new")}><Plus size={16} /> Article</button>}
      </div>
      <p className="muted small">Answers customers find themselves in the help centre, and that agents insert into replies with one tap. Every answer found here is a ticket nobody has to open.</p>
      {!articles && <div className="center pad"><Spinner /></div>}
      {articles?.length === 0 && <Empty icon="📚" title="No articles yet"><p>Start with your 5 most-asked questions: refunds, timings, how to book, cancellations, documents.</p></Empty>}
      {articles?.map((a) => (
        <div key={a.id} className="ledger-row">
          <span className="ledger-icon in"><BookOpen size={16} /></span>
          <button className="ledger-copy" onClick={() => isAdmin && setEditing(a)}>
            <strong>{a.title}{!a.published && <span className="pill">draft</span>}</strong>
            <small>{a.category} · {a.views} views · 👍 {a.helpful} · 👎 {a.notHelpful} · updated {ago(a.updatedAt)}</small>
          </button>
        </div>
      ))}
      {editing && <ArticleEditor article={editing === "new" ? null : editing} onClose={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function ArticleEditor({ article, onClose }: { article: Article | null; onClose: () => void }) {
  const { call } = useBiz();
  const [run, busy] = useAction();
  const [title, setTitle] = useState(article?.title ?? "");
  const [body, setBody] = useState(article?.body ?? "");
  const [category, setCategory] = useState(article?.category ?? "General");
  const [published, setPublished] = useState(article?.published ?? true);
  return (
    <Modal wide title={article ? "Edit article" : "New article"} onClose={onClose} footer={
      <div className="row gap-xs">
        {article && <button className="btn btn-ghost danger-link" disabled={busy} onClick={() => confirm("Delete this article?") && void run(async () => { await call(`kb/${article.id}`, { method: "DELETE" }); onClose(); }, "Deleted")}><Trash2 size={15} /> Delete</button>}
        <button className="btn btn-primary grow" disabled={busy || title.trim().length < 3 || body.trim().length < 10} onClick={() => void run(async () => {
          const payload = { title: title.trim(), body: body.trim(), category: category.trim() || "General", published };
          if (article) await call(`kb/${article.id}`, { method: "PATCH", body: payload });
          else await call("kb", { body: payload });
          onClose();
        }, "Saved")}>Save article</button>
      </div>
    }>
      <label className="field"><span>Question / title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="When will I get my refund?" /></label>
      <label className="field"><span>Category</span><input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} /></label>
      <label className="field"><span>Answer</span><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} placeholder="Write it the way you'd explain it on the phone." /></label>
      <div className="setting"><span>Published<small>Visible in the public help centre and in reply suggestions.</small></span><Toggle label="Published" checked={published} onChange={setPublished} /></div>
    </Modal>
  );
}

// ── help centre + SLA settings ───────────────────────────────────────────────

function Setup() {
  const { data, call, reload, ws } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const s = data.workspace.settings;
  const [intro, setIntro] = useState(s.helpIntro ?? "");
  const [sla, setSla] = useState(() => Object.fromEntries(PRIORITIES.map((p) => [p.id, { ...DEFAULT_SLA[p.id], ...s.sla?.[p.id] }])) as typeof DEFAULT_SLA);
  const url = typeof window === "undefined" ? `/help/${ws}` : `${window.location.origin}/help/${ws}`;
  const save = (body: Record<string, unknown>, msg = "Saved") => void run(async () => {
    await call("", { method: "PATCH", body });
    await reload();
  }, msg);

  return (
    <div className="biz-grid">
      <section className="card-section">
        <h3><Globe size={17} /> Public help centre</h3>
        <p className="muted small">A self-service page for your customers: they search your answers, raise a ticket or ask for a callback, track it with a private link and rate the help, with no app or login needed.</p>
        <div className="setting"><span>Help centre is live<small>Anyone with the link can open it.</small></span><Toggle label="Help centre" checked={s.helpCenter === true} onChange={(v) => save({ helpCenter: v }, v ? "Help centre is live 🎉" : "Help centre turned off")} /></div>
        {s.helpCenter && (
          <div className="row gap-xs wrap">
            <code className="fp grow">{url}</code>
            <button className="btn btn-ghost sm" onClick={() => void navigator.clipboard.writeText(url).then(() => toast("Link copied", "success"))}><Copy size={15} /> Copy</button>
            <a className="btn btn-ghost sm" href={`/help/${ws}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Open</a>
          </div>
        )}
        <label className="field"><span>Welcome line</span><textarea rows={2} value={intro} maxLength={400} onChange={(e) => setIntro(e.target.value)} placeholder="Hi! Search our answers or tell us what's wrong — we usually reply within an hour." /></label>
        <button className="btn btn-ghost sm" disabled={busy || intro === (s.helpIntro ?? "")} onClick={() => save({ helpIntro: intro.trim() })}>Save welcome line</button>
        <p className="muted small">Tip: put the link in your WhatsApp Business profile, Instagram bio, invoices and missed-call SMS.</p>
      </section>

      <section className="card-section">
        <h3><AlertTriangle size={17} /> Response targets (SLA)</h3>
        <p className="muted small">How fast your team promises to reply and to resolve, by priority. Tickets that slip turn red on the wallboard.</p>
        <div className="sla-grid">
          <span /><b>First reply (min)</b><b>Resolve (min)</b>
          {PRIORITIES.map((p) => (
            <SlaRow key={p.id} label={p.label} color={p.color} value={sla[p.id]} onChange={(v) => setSla({ ...sla, [p.id]: v })} />
          ))}
        </div>
        <button className="btn btn-primary sm" disabled={busy} onClick={() => save({ sla }, "SLA targets saved")}>Save targets</button>
        <div className="setting"><span>Auto-assign new tickets<small>To the available teammate with the fewest open tickets.</small></span><Toggle label="Auto-assign" checked={s.autoAssign !== false} onChange={(v) => save({ autoAssign: v })} /></div>
        <p className="muted small"><Smile size={13} /> Every missed call on your lines opens a <b>callback ticket</b> automatically, so no caller is forgotten.</p>
      </section>
    </div>
  );
}

function SlaRow({ label, color, value, onChange }: { label: string; color: string; value: { respond: number; resolve: number }; onChange: (v: { respond: number; resolve: number }) => void }) {
  const n = (v: string) => Math.max(5, Math.min(43200, Math.round(Number(v) || 5)));
  return (
    <>
      <span className="row gap-xs"><i className="prio-dot" style={{ background: color }} /> {label}</span>
      <input className="input" type="number" min={5} value={value.respond} onChange={(e) => onChange({ ...value, respond: n(e.target.value) })} aria-label={`${label} first reply minutes`} />
      <input className="input" type="number" min={5} value={value.resolve} onChange={(e) => onChange({ ...value, resolve: n(e.target.value) })} aria-label={`${label} resolve minutes`} />
    </>
  );
}
