"use client";

import {
  CalendarClock, Download, KanbanSquare, List, MessageSquare, Phone, Plus, Search, StickyNote, Trash2, Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatPhone, STAGES } from "@/lib/biz-shared";
import { ago } from "@/lib/client/selectors";
import { useAction, useToast } from "../context";
import { Avatar, Empty, Modal, Spinner } from "../ui";
import { tomorrowAt10 } from "./CallDock";
import { MessageComposer } from "./Inbox";
import { duration, inr, STATUS_LABEL, useBiz, type CallLog, type Contact, type Task } from "./shared";

export function Contacts() {
  const { call, version, isAdmin, ws, openContact, dial } = useBiz();
  const toast = useToast();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [view, setView] = useState<"list" | "board">("list");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (stage && view === "list") params.set("stage", stage);
    return call<{ contacts: Contact[] }>(`contacts?${params}`).then((r) => setContacts(r.contacts)).catch((e: Error) => toast(e.message, "error"));
  }, [call, q, stage, view, toast]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load, version]);

  const move = async (id: string, to: string) => {
    setContacts((cs) => cs?.map((c) => (c.id === id ? { ...c, stage: to } : c)) ?? null);
    await call(`contacts/${id}`, { method: "PATCH", body: { stage: to } }).catch((e: Error) => {
      toast(e.message, "error");
      void load();
    });
  };

  return (
    <div className="biz-page">
      <div className="toolbar">
        <label className="search grow" style={{ margin: 0 }}>
          <Search size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, number or tag" />
        </label>
        <div className="segmented sm">
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={15} /> List</button>
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><KanbanSquare size={15} /> Board</button>
        </div>
        <button className="btn btn-primary sm" onClick={() => setAdding(true)}><Plus size={16} /> Lead</button>
        <button className="btn btn-ghost sm" onClick={() => setImporting(true)}><Upload size={15} /> Import</button>
        {isAdmin && <a className="btn btn-ghost sm" href={`/api/biz/${ws}/export`} download><Download size={15} /> Export</a>}
      </div>

      {view === "list" && (
        <div className="filters" style={{ padding: 0, flexWrap: "wrap" }}>
          <button className={!stage ? "active" : ""} onClick={() => setStage("")}>All</button>
          {STAGES.map((s) => <button key={s.id} className={stage === s.id ? "active" : ""} onClick={() => setStage(s.id)}>{s.label}</button>)}
        </div>
      )}

      {!contacts && <div className="center pad"><Spinner /></div>}
      {contacts && contacts.length === 0 && (
        <Empty icon="📇" title="No leads here yet"><p>Add one, or import a CSV exported from Excel or Google Sheets.</p></Empty>
      )}

      {contacts && contacts.length > 0 && view === "list" && (
        <section className="card-section" style={{ padding: 8 }}>
          {contacts.map((c) => (
            <div key={c.id} className="ledger-row contact-row">
              <Avatar name={c.name} hue={hue(c.id)} size={40} />
              <button className="ledger-copy" onClick={() => openContact(c.id)}>
                <strong>{c.name}{c.company ? <span className="muted"> · {c.company}</span> : null}</strong>
                <small>{formatPhone(c.phone)} · {c.lastContactedAt ? `last contact ${ago(c.lastContactedAt)}` : "never contacted"}{c.tags.length ? ` · ${c.tags.map((t) => `#${t}`).join(" ")}` : ""}</small>
              </button>
              <StageBadge stage={c.stage} />
              {c.value > 0 && <span className="ledger-amt small">{inr(c.value, true)}</span>}
              <button className="icon-btn soft" onClick={() => dial({ contactId: c.id, name: c.name, phone: c.phone })} aria-label={`Call ${c.name}`}><Phone size={16} /></button>
            </div>
          ))}
        </section>
      )}

      {contacts && contacts.length > 0 && view === "board" && (
        <div className="board">
          {STAGES.map((s) => {
            const col = contacts.filter((c) => c.stage === s.id);
            return (
              <div key={s.id} className="board-col" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
                const id = e.dataTransfer.getData("text/plain");
                if (id) void move(id, s.id);
              }}>
                <header><i style={{ background: s.color }} /> {s.label} <span className="muted">{col.length}</span>
                  <small className="muted">{inr(col.reduce((x, c) => x + c.value, 0), true)}</small></header>
                {col.map((c) => (
                  <div key={c.id} className="board-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)} onClick={() => openContact(c.id)}>
                    <strong>{c.name}</strong>
                    <small>{c.company || formatPhone(c.phone)}</small>
                    <div className="row between">
                      <span className="small">{c.value ? inr(c.value, true) : ""}</span>
                      <select value={c.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => void move(c.id, e.target.value)} aria-label="Move to stage">
                        {STAGES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {adding && <AddContact onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
      {importing && <ImportCsv onClose={() => setImporting(false)} onDone={() => { setImporting(false); void load(); }} />}
    </div>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  const s = STAGES.find((x) => x.id === stage);
  return <span className="stage-badge" style={{ ["--stage" as string]: s?.color ?? "#888" }}>{s?.label ?? stage}</span>;
}

function hue(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function AddContact({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { call } = useBiz();
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: "", phone: "", email: "", company: "", tags: "", stage: "new", value: "", source: "manual" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="New lead" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={busy || !f.name.trim() || f.phone.replace(/\D/g, "").length < 7} onClick={() => void run(async () => {
        const res = await call<{ created: number; updated: number; errors: string[] }>("contacts", {
          body: { contacts: [{ name: f.name, phone: f.phone, email: f.email, company: f.company, stage: f.stage, source: f.source,
            tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), value: Math.round((Number(f.value) || 0) * 100) }] },
        });
        if (res.errors.length) throw new Error(res.errors[0]);
        onDone();
      }, "Lead saved")}>Save lead</button>
    }>
      <label className="field"><span>Name</span><input value={f.name} onChange={set("name")} placeholder="Customer name" /></label>
      <label className="field"><span>Mobile</span><input value={f.phone} onChange={set("phone")} inputMode="tel" placeholder="+91 98765 43210" /></label>
      <div className="two-col">
        <label className="field"><span>Email</span><input value={f.email} onChange={set("email")} type="email" /></label>
        <label className="field"><span>Company</span><input value={f.company} onChange={set("company")} /></label>
        <label className="field"><span>Stage</span><select value={f.stage} onChange={set("stage")}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="field"><span>Deal value (₹)</span><input value={f.value} onChange={set("value")} inputMode="decimal" /></label>
        <label className="field"><span>Source</span>
          <select value={f.source} onChange={set("source")}>{["manual", "website", "instagram", "facebook", "whatsapp", "referral", "walk-in", "ads"].map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label className="field"><span>Tags</span><input value={f.tags} onChange={set("tags")} placeholder="Goa, family" /></label>
      </div>
    </Modal>
  );
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function ImportCsv({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { call } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const read = async (file: File) => {
    const table = parseCsv(await file.text());
    if (table.length < 2) return toast("That file has no data rows.", "error");
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
    const idx = { name: col("name"), phone: col("phone", "mobile", "number", "contact"), email: col("email"), company: col("company", "organisation", "organization"), tags: col("tag"), stage: col("stage", "status"), value: col("value", "amount", "budget") };
    if (idx.phone < 0) return toast("Couldn't find a phone/mobile column.", "error");
    setRows(table.slice(1, 2001).map((r) => ({
      name: (idx.name >= 0 ? r[idx.name] : "")?.trim() || "Unnamed",
      phone: r[idx.phone]?.trim() ?? "",
      email: idx.email >= 0 ? r[idx.email]?.trim() ?? "" : "",
      company: idx.company >= 0 ? r[idx.company]?.trim() ?? "" : "",
      tags: idx.tags >= 0 ? r[idx.tags] ?? "" : "",
      stage: idx.stage >= 0 ? (r[idx.stage] ?? "").trim().toLowerCase() : "",
      value: idx.value >= 0 ? r[idx.value] ?? "" : "",
    })));
  };

  return (
    <Modal title="Import leads from CSV" onClose={onClose} footer={rows ? (
      <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void run(async () => {
        const res = await call<{ created: number; updated: number; errors: string[] }>("contacts", {
          body: { contacts: rows.map((r) => ({
            name: r.name.slice(0, 80), phone: r.phone, email: /\S+@\S+/.test(r.email) ? r.email.slice(0, 120) : "", company: r.company.slice(0, 80),
            tags: r.tags.split(/[;,|]/).map((t) => t.trim().slice(0, 24)).filter(Boolean).slice(0, 12),
            stage: STAGES.some((s) => s.id === r.stage) ? r.stage : "new",
            value: Math.max(0, Math.round((Number(r.value.replace(/[^\d.]/g, "")) || 0) * 100)), source: "import",
          })) },
        });
        setErrors(res.errors);
        toast(`${res.created} added, ${res.updated} updated${res.errors.length ? `, ${res.errors.length}+ skipped` : ""}`, "success");
        if (!res.errors.length) onDone();
      })}>{busy ? <Spinner size={16} /> : <Upload size={16} />} Import {rows.length} leads</button>
    ) : undefined}>
      <p className="muted">Columns are matched by name: <b>name, phone/mobile, email, company, tags, stage, value</b>. Existing numbers are updated, not duplicated. 10-digit numbers are treated as Indian (+91).</p>
      <label className="btn btn-ghost btn-block file-pick">
        <Upload size={16} /> Choose CSV file
        <input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
      </label>
      {rows && (
        <div className="csv-preview">
          {rows.slice(0, 5).map((r, i) => <div key={i}><b>{r.name}</b> <span className="muted">{r.phone}</span></div>)}
          {rows.length > 5 && <div className="muted small">…and {rows.length - 5} more</div>}
        </div>
      )}
      {errors.length > 0 && <div className="form-error">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
    </Modal>
  );
}

type Detail = {
  contact: Contact;
  activities: { id: string; kind: string; body: string; createdAt: string; actorName: string | null }[];
  calls: CallLog[];
  messages: { id: string; channel: string; direction: string; body: string; status: string; createdAt: string; agentName: string | null }[];
  tasks: Task[];
};

export function ContactDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { call, dial, data, isAdmin, reload } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"timeline" | "message" | "tasks">("timeline");
  const [note, setNote] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskWhen, setTaskWhen] = useState(tomorrowAt10);

  const load = useCallback(() => call<Detail>(`contacts/${id}`).then(setD).catch((e: Error) => {
    toast(e.message, "error");
    onClose();
  }), [call, id, toast, onClose]);
  useEffect(() => {
    void load();
  }, [load]);

  const timeline = useMemo(() => {
    if (!d) return [];
    type Item = { key: string; at: string; icon: string; title: string; body?: string; mine?: boolean; audio?: string | null };
    const items: Item[] = [
      ...d.activities.filter((a) => a.kind !== "call" || a.body.startsWith("Call outcome")).map((a) => ({
        key: `a${a.id}`, at: a.createdAt, icon: a.kind === "note" ? "📝" : a.kind === "stage" ? "🔀" : a.kind === "task" ? "⏰" : a.kind === "call" ? "☎️" : "•",
        title: a.kind === "note" ? `Note by ${a.actorName ?? "someone"}` : a.body, body: a.kind === "note" ? a.body : undefined,
      })),
      ...d.calls.map((c) => ({
        key: `c${c.id}`, at: c.startedAt, icon: c.direction === "inbound" ? "📥" : "📤",
        title: `${c.direction === "inbound" ? "Inbound" : "Outbound"} call · ${STATUS_LABEL[c.status] ?? c.status}${c.durationSec ? ` · ${duration(c.durationSec)}` : ""}`,
        body: [c.agentName && `by ${c.agentName}`, c.disposition, c.notes].filter(Boolean).join(" — ") || undefined, audio: c.recordingUrl,
      })),
      ...d.messages.map((m) => ({
        key: `m${m.id}`, at: m.createdAt, icon: m.channel === "whatsapp" ? "🟢" : "💬", mine: m.direction === "outbound",
        title: `${m.channel === "whatsapp" ? "WhatsApp" : "SMS"} ${m.direction === "outbound" ? `sent${m.agentName ? ` by ${m.agentName}` : ""}` : "received"} · ${m.status}`, body: m.body,
      })),
    ];
    return items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  }, [d]);

  if (!d) return <Modal title="Lead" onClose={onClose}><div className="center pad"><Spinner /></div></Modal>;
  const c = d.contact;
  const patch = (body: Record<string, unknown>, msg?: string) => void run(async () => {
    await call(`contacts/${id}`, { method: "PATCH", body });
    await load();
  }, msg);

  return (
    <Modal title={c.name} wide onClose={onClose}>
      <div className="contact-head">
        <Avatar name={c.name} hue={hue(c.id)} size={56} />
        <div className="grow">
          <div className="muted small">{c.company || "—"} · added {ago(c.createdAt)} · source {c.source}</div>
          <div className="contact-phone">{formatPhone(c.phone)} {c.masked && <span className="pill">🔒 masked</span>}</div>
          {c.email && <div className="muted small">{c.email}</div>}
        </div>
        <div className="col-actions">
          <button className="btn btn-primary sm" onClick={() => { onClose(); dial({ contactId: c.id, name: c.name, phone: c.phone }); }}><Phone size={15} /> Call</button>
          <button className="btn btn-ghost sm" onClick={() => setTab("message")}><MessageSquare size={15} /> Message</button>
        </div>
      </div>
      <div className="contact-meta">
        <label className="field"><span>Stage</span>
          <select value={c.stage} disabled={busy} onChange={(e) => patch({ stage: e.target.value }, "Stage updated")}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        </label>
        <label className="field"><span>Deal value (₹)</span>
          <input defaultValue={c.value / 100 || ""} inputMode="decimal" onBlur={(e) => {
            const v = Math.round((Number(e.target.value) || 0) * 100);
            if (v !== c.value) patch({ value: v }, "Value saved");
          }} />
        </label>
        <label className="field"><span>Owner</span>
          <select value={c.ownerId ?? ""} disabled={busy} onChange={(e) => patch({ ownerId: e.target.value || null }, "Reassigned")}>
            <option value="">Unassigned</option>
            {data.members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </select>
        </label>
        <label className="field"><span>Tags</span>
          <input defaultValue={c.tags.join(", ")} onBlur={(e) => {
            const tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12);
            if (tags.join(",") !== c.tags.join(",")) patch({ tags }, "Tags saved");
          }} />
        </label>
      </div>

      <div className="segmented sm" style={{ margin: "6px 0 12px" }}>
        <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>Timeline</button>
        <button className={tab === "message" ? "active" : ""} onClick={() => setTab("message")}>SMS / WhatsApp</button>
        <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>Follow-ups {d.tasks.filter((t) => !t.doneAt).length || ""}</button>
      </div>

      {tab === "timeline" && (
        <>
          <div className="note-box">
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team…" />
            <button className="btn btn-ghost sm" disabled={busy || !note.trim()} onClick={() => void run(async () => {
              await call(`contacts/${id}/notes`, { body: { body: note.trim() } });
              setNote("");
              await load();
            })}><StickyNote size={15} /> Add note</button>
          </div>
          <ol className="timeline-list">
            {timeline.map((t) => (
              <li key={t.key} className={t.mine ? "mine" : ""}>
                <span className="tl-icon">{t.icon}</span>
                <div>
                  <div className="tl-title">{t.title} <time className="muted small">{ago(t.at)}</time></div>
                  {t.body && <p className="tl-body">{t.body}</p>}
                  {t.audio && <audio controls preload="none" src={t.audio} className="tl-audio" />}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {tab === "message" && (
        <>
          <div className="thread mini">
            {d.messages.length === 0 && <p className="muted small center pad">No messages yet.</p>}
            {d.messages.map((m) => (
              <div key={m.id} className={`sms ${m.direction === "outbound" ? "out" : "in"}`}>
                <p>{m.body}</p>
                <small>{m.channel === "whatsapp" ? "WhatsApp" : "SMS"} · {ago(m.createdAt)}{m.direction === "outbound" ? ` · ${m.status}` : ""}</small>
              </div>
            ))}
          </div>
          <MessageComposer contactId={c.id} contactName={c.name} onSent={() => {
            void load();
            setTimeout(() => void load(), 5000);
          }} />
        </>
      )}

      {tab === "tasks" && (
        <>
          <div className="followup">
            <label className="field grow"><span>New follow-up</span><input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="e.g. Share hotel options" /></label>
            <label className="field"><span>Due</span><input type="datetime-local" value={taskWhen} onChange={(e) => setTaskWhen(e.target.value)} /></label>
            <button className="btn btn-primary sm add-task" disabled={busy || !taskTitle.trim()} onClick={() => void run(async () => {
              await call("tasks", { body: { title: taskTitle.trim(), dueAt: new Date(taskWhen).toISOString(), contactId: id } });
              setTaskTitle("");
              await load();
              void reload();
            })}><CalendarClock size={15} /> Add</button>
          </div>
          {d.tasks.length === 0 && <p className="muted small">No follow-ups yet.</p>}
          {d.tasks.map((t) => (
            <label key={t.id} className={`task-row${t.doneAt ? " done" : ""}`}>
              <input type="checkbox" checked={Boolean(t.doneAt)} onChange={(e) => void run(async () => {
                await call(`tasks/${t.id}`, { method: "PATCH", body: { done: e.target.checked } });
                await load();
                void reload();
              })} />
              <span className="grow">{t.title}<small className="muted block">{t.assigneeName ?? "Unassigned"} · due {new Date(t.dueAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small></span>
            </label>
          ))}
        </>
      )}

      {isAdmin && (
        <button className="link sm danger-link" onClick={() => {
          if (!confirm(`Delete ${c.name} and their history?`)) return;
          void run(async () => {
            await call(`contacts/${id}`, { method: "DELETE" });
            onClose();
            void reload();
          }, "Lead deleted");
        }}><Trash2 size={13} /> Delete lead</button>
      )}
    </Modal>
  );
}
