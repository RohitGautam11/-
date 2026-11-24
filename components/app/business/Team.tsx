"use client";

import { CheckCircle2, CircleDashed, History, Info, MessageSquareText, Pencil, Phone, Plus, Settings2, Smartphone, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { formatPhone, PROVIDERS } from "@/lib/biz-shared";
import { useAction, useEngine } from "../context";
import { Avatar, Modal, Toggle } from "../ui";
import { useBiz, type Line } from "./shared";
import { ago } from "@/lib/client/selectors";

export function TeamView({ onLeft }: { onLeft: () => void }) {
  const { data, call, reload, isAdmin } = useBiz();
  const engine = useEngine();
  const [run, busy] = useAction();
  const [adding, setAdding] = useState(false);
  const [editLine, setEditLine] = useState<Line | "new" | null>(null);
  const [simHelp, setSimHelp] = useState(false);
  const [myPhone, setMyPhone] = useState(data.me.phone ?? "");
  const me = engine.me.id;

  return (
    <div className="biz-page">
      <section className="card-section">
        <h3><Smartphone size={17} /> Your phone for business calls</h3>
        <p className="muted small">When you click Call, the business line rings <b>this</b> phone first, then connects the customer — who only ever sees the business number. Inbound calls ring here too while you&apos;re Available.</p>
        <div className="row gap-xs">
          <input className="input grow" value={myPhone} onChange={(e) => setMyPhone(e.target.value)} placeholder="+91 98765 43210" inputMode="tel" />
          <button className="btn btn-primary sm" disabled={busy || myPhone === (data.me.phone ?? "")} onClick={() => void run(async () => {
            await call(`members/${me}`, { method: "PATCH", body: { phone: myPhone.trim() || null } });
            await reload();
          }, "Saved")}>Save</button>
        </div>
      </section>

      <section className="card-section">
        <div className="row between">
          <h3>Team · {data.members.length}</h3>
          {isAdmin && <button className="btn btn-ghost sm" onClick={() => setAdding(true)}><UserPlus size={15} /> Add teammate</button>}
        </div>
        {data.members.map((m) => (
          <div key={m.userId} className="ledger-row">
            <Avatar name={m.displayName} hue={m.avatarHue} size={40} />
            <span className="ledger-copy">
              <strong>{m.displayName}{m.userId === me ? " (you)" : ""}</strong>
              <small>@{m.username} · <span className={`avail-text avail-${m.availability}`}>{m.availability}</span> · {m.phone ? (isAdmin || m.userId === me ? formatPhone(m.phone) : "phone on file") : "no phone yet"}</small>
            </span>
            {isAdmin && m.role !== "owner" ? (
              <select className="input sm-select" value={m.role} disabled={busy} onChange={(e) => void run(async () => {
                await call(`members/${m.userId}`, { method: "PATCH", body: { role: e.target.value } });
                await reload();
              }, "Role updated")}>
                <option value="admin">Admin</option>
                <option value="agent">Agent</option>
              </select>
            ) : <span className="pill">{m.role}</span>}
            {m.role !== "owner" && (isAdmin || m.userId === me) && (
              <button className="icon-btn danger" aria-label={m.userId === me ? "Leave workspace" : `Remove ${m.displayName}`} onClick={() => {
                if (!confirm(m.userId === me ? "Leave this workspace?" : `Remove ${m.displayName} from the team?`)) return;
                void run(async () => {
                  await call(`members/${m.userId}`, { method: "DELETE" });
                  if (m.userId === me) onLeft();
                  else await reload();
                });
              }}><Trash2 size={15} /></button>
            )}
          </div>
        ))}
        <p className="muted small"><b>Agents</b> see masked customer numbers and can only dial from the lead list. <b>Admins</b> manage numbers, team, templates and exports.</p>
      </section>

      <section className="card-section">
        <div className="row between">
          <h3><Phone size={17} /> Business lines</h3>
          {isAdmin && <button className="btn btn-ghost sm" onClick={() => setEditLine("new")}><Plus size={15} /> Add number</button>}
        </div>
        {data.lines.map((l) => (
          <div key={l.id} className="ledger-row">
            <span className={`ledger-icon ${l.active ? "in" : "out"}`}><Phone size={17} /></span>
            <span className="ledger-copy">
              <strong>{l.label} · {formatPhone(l.phoneNumber)}</strong>
              <small>{PROVIDERS.find((p) => p.id === l.provider)?.label} · {l.channels.join(" + ")} · {l.routing.replace("_", " ")}{l.recordCalls ? " · recording" : ""}{l.missedCallReply ? " · missed-call reply" : ""}{l.active ? "" : " · paused"}</small>
            </span>
            {isAdmin && <button className="icon-btn soft" aria-label={`Edit ${l.label}`} onClick={() => setEditLine(l)}><Pencil size={15} /></button>}
          </div>
        ))}
        <div className="provider-status">
          {PROVIDERS.map((p) => (
            <span key={p.id} className={data.providers[p.id] ? "ok" : ""}>
              {data.providers[p.id] ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />} {p.label} {data.providers[p.id] ? "ready" : "not configured"}
            </span>
          ))}
        </div>
        <button className="banner" onClick={() => setSimHelp(true)}><Info size={15} /> Have a single SIM you want the whole team to use? See how →</button>
      </section>

      {isAdmin && <Templates />}
      {isAdmin && <AuditLog />}
      {isAdmin && <WorkspaceSettings onLeft={onLeft} />}

      {adding && <AddMember onClose={() => setAdding(false)} />}
      {editLine && <LineEditor line={editLine === "new" ? null : editLine} onClose={() => setEditLine(null)} />}
      {simHelp && <SimGuide onClose={() => setSimHelp(false)} />}
    </div>
  );
}

function AddMember({ onClose }: { onClose: () => void }) {
  const { call, reload } = useBiz();
  const [run, busy] = useAction();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [phone, setPhone] = useState("");
  return (
    <Modal title="Add teammate" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={busy || username.trim().length < 3} onClick={() => void run(async () => {
        await call("members", { body: { username: username.trim(), role, phone: phone.trim() || undefined } });
        await reload();
        onClose();
      }, "Teammate added")}>Add to team</button>
    }>
      <p className="muted">They need a वार्तालाप account first (free). Share the app link, then add them by username.</p>
      <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@username" /></label>
      <label className="field"><span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as "agent" | "admin")}><option value="agent">Agent — calls & messages, numbers masked</option><option value="admin">Admin — full access</option></select>
      </label>
      <label className="field"><span>Their mobile (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" inputMode="tel" /></label>
    </Modal>
  );
}

function LineEditor({ line, onClose }: { line: Line | null; onClose: () => void }) {
  const { call, reload, data } = useBiz();
  const [run, busy] = useAction();
  const [f, setF] = useState({
    label: line?.label ?? "Sales line",
    phoneNumber: line?.phoneNumber ?? "",
    provider: line?.provider ?? (data.providers.exotel ? "exotel" : data.providers.twilio ? "twilio" : "simulator"),
    channels: line?.channels ?? ["voice", "sms", "whatsapp"],
    routing: line?.routing ?? "ring_all",
    missedCallReply: line?.missedCallReply ?? "Sorry we missed your call! We'll call you back shortly — or reply here with your query.",
    recordCalls: line?.recordCalls ?? false,
    active: line?.active ?? true,
  });
  const provider = PROVIDERS.find((p) => p.id === f.provider)!;
  const toggleChannel = (c: string) => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] });
  return (
    <Modal title={line ? "Edit line" : "Add a business number"} wide onClose={onClose} footer={
      <div className="row gap-xs">
        <button className="btn btn-primary grow" disabled={busy || !f.label.trim() || !f.phoneNumber.trim() || !f.channels.length} onClick={() => void run(async () => {
          const payload = { ...f, missedCallReply: f.missedCallReply.trim() || null };
          if (line) await call(`lines/${line.id}`, { method: "PATCH", body: payload });
          else await call("lines", { body: payload });
          await reload();
          onClose();
        }, "Line saved")}>Save line</button>
        {line && <button className="btn btn-danger" disabled={busy} onClick={() => {
          if (!confirm("Remove this line? Its call history stays.")) return;
          void run(async () => {
            await call(`lines/${line.id}`, { method: "DELETE" });
            await reload();
            onClose();
          });
        }}><Trash2 size={15} /></button>}
      </div>
    }>
      <div className="two-col">
        <label className="field"><span>Label</span><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
        <label className="field"><span>Number (E.164)</span><input value={f.phoneNumber} onChange={(e) => setF({ ...f, phoneNumber: e.target.value })} placeholder="+91 80 4718 xxxx" inputMode="tel" /></label>
      </div>
      <label className="field"><span>Provider</span>
        <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as Line["provider"] })}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}{data.providers[p.id] ? "" : " — not configured"}</option>)}
        </select>
      </label>
      <p className="muted small">{provider.note}{!data.providers[f.provider] && " Add its keys to the server environment before going live."}</p>
      <div className="field"><span>Channels on this number</span>
        <div className="chips">{["voice", "sms", "whatsapp"].map((c) => <button key={c} className={`chip${f.channels.includes(c) ? " on" : ""}`} onClick={() => toggleChannel(c)}>{c === "voice" ? "📞 Voice" : c === "sms" ? "💬 SMS" : "🟢 WhatsApp"}</button>)}</div>
      </div>
      <label className="field"><span>Inbound calls ring</span>
        <select value={f.routing} onChange={(e) => setF({ ...f, routing: e.target.value as Line["routing"] })}>
          <option value="ring_all">Everyone available at once (first to pick up)</option>
          <option value="round_robin">One agent at a time, in turns (round robin)</option>
          <option value="owner_first">Admins first, then agents</option>
        </select>
      </label>
      <label className="field"><span>Missed-call auto-reply (SMS)</span><textarea rows={2} value={f.missedCallReply} onChange={(e) => setF({ ...f, missedCallReply: e.target.value })} maxLength={320} placeholder="Leave empty to turn off" /></label>
      <div className="row between setting-row"><span>Record calls <small className="muted block">Tell callers they may be recorded (legal requirement in many places).</small></span><Toggle checked={f.recordCalls} onChange={(v) => setF({ ...f, recordCalls: v })} label="Record calls" /></div>
      <div className="row between setting-row"><span>Line active</span><Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Line active" /></div>
    </Modal>
  );
}

function SimGuide({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Use one SIM for the whole team" wide onClose={onClose}>
      <div className="guide">
        <p><b>The honest limit:</b> a physical SIM can carry only <b>one voice call at a time</b>. No app can make a single SIM card take 10 calls at once. What you <i>can</i> do is put a cloud number in front of it — then one number serves your whole team, with as many simultaneous calls as you have agents.</p>
        <h4>Option A — keep your existing SIM number (recommended)</h4>
        <ol>
          <li>Get a virtual number from <b>Exotel</b> (India) or <b>Twilio</b> and add it here as a line.</li>
          <li>On the SIM&apos;s phone, turn on <b>unconditional call forwarding</b> to that virtual number: dial <code>**21*&lt;virtual number&gt;#</code> (most Indian operators; turn off with <code>##21#</code>).</li>
          <li>Customers keep calling your old number → it forwards to the cloud line → it rings every available agent at once. Missed calls get your auto-reply SMS.</li>
          <li>Outbound calls go out from the virtual number (Indian rules don&apos;t allow showing a mobile SIM&apos;s number as caller ID from a cloud system). Print the virtual number on your website and cards so customers recognise it.</li>
        </ol>
        <h4>Option B — port the number</h4>
        <p>Some providers can port a business mobile/landline number into their cloud (MNP rules permitting). Then that exact number gets all the features above for both inbound and outbound.</p>
        <h4>Option C — start fresh</h4>
        <p>Buy a new virtual number (toll-free or local) in minutes and publish it as your single business number.</p>
        <h4>Compliance (India)</h4>
        <ul>
          <li>Business SMS needs <b>DLT registration</b> (sender ID + templates) — your provider helps with this.</li>
          <li>Telemarketing calls must respect DND and use registered series. Service/transactional calls to your own leads are fine.</li>
          <li>Announce call recording when it&apos;s on.</li>
        </ul>
      </div>
    </Modal>
  );
}

function Templates() {
  const { call } = useBiz();
  const [run, busy] = useAction();
  const [list, setList] = useState<{ id: string; name: string; body: string }[]>([]);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const load = () => call<{ templates: { id: string; name: string; body: string }[] }>("templates").then((r) => setList(r.templates));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="card-section">
      <h3><MessageSquareText size={17} /> Quick-reply templates</h3>
      <p className="muted small">Use <code>{"{name}"}</code> to insert the customer&apos;s first name.</p>
      {list.map((t) => (
        <div key={t.id} className="ledger-row">
          <span className="ledger-copy"><strong>{t.name}</strong><small>{t.body}</small></span>
          <button className="icon-btn danger" aria-label={`Delete ${t.name}`} onClick={() => void run(async () => {
            await call(`templates/${t.id}`, { method: "DELETE" });
            await load();
          })}><Trash2 size={15} /></button>
        </div>
      ))}
      <div className="two-col">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Price list" maxLength={40} />
        <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {name}, …" maxLength={1600} />
      </div>
      <button className="btn btn-ghost sm" disabled={busy || !name.trim() || !body.trim()} onClick={() => void run(async () => {
        await call("templates", { body: { name: name.trim(), body: body.trim() } });
        setName("");
        setBody("");
        await load();
      }, "Template added")}><Plus size={15} /> Add template</button>
    </section>
  );
}

function WorkspaceSettings({ onLeft }: { onLeft: () => void }) {
  const { data, call, reload } = useBiz();
  const [run, busy] = useAction();
  const [name, setName] = useState(data.workspace.name);
  const mask = data.workspace.settings.maskForAgents !== false;
  return (
    <section className="card-section">
      <h3><Settings2 size={17} /> Workspace</h3>
      <div className="row gap-xs">
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn btn-ghost sm" disabled={busy || name.trim().length < 2 || name === data.workspace.name} onClick={() => void run(async () => {
          await call("", { method: "PATCH", body: { name: name.trim() } });
          await reload();
        }, "Renamed")}>Rename</button>
      </div>
      <div className="row between setting-row">
        <span><b>Mask customer numbers for agents</b><small className="muted block">Agents see +91 98••••••10 and can only call through the business line.</small></span>
        <Toggle checked={mask} onChange={(v) => void run(async () => {
          await call("", { method: "PATCH", body: { maskForAgents: v } });
          await reload();
        })} label="Mask numbers for agents" />
      </div>
      {data.role === "owner" && (
        <button className="link sm danger-link" onClick={() => {
          if (!confirm(`Delete "${data.workspace.name}" with all its leads, calls and messages? This can't be undone.`)) return;
          void run(async () => {
            await call("", { method: "DELETE" });
            onLeft();
          }, "Workspace deleted");
        }}><Trash2 size={13} /> Delete workspace</button>
      )}
    </section>
  );
}

/** Who changed what: members, roles, numbers, exports, settings. Append-only, admins only. */
function AuditLog() {
  const { call, version } = useBiz();
  const [entries, setEntries] = useState<{ id: number; action: string; detail: string; createdAt: string; actorName: string | null }[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void call<{ entries: NonNullable<typeof entries> }>("audit").then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, [call, version]);
  const shown = all ? entries : entries?.slice(0, 8);
  return (
    <section className="card-section">
      <h3><History size={17} /> Audit log</h3>
      <p className="muted small">A permanent record of sensitive changes: teammates added or removed, roles, numbers, exports and settings.</p>
      {entries?.length === 0 && <p className="muted small">Nothing recorded yet.</p>}
      {shown?.map((e) => (
        <div key={e.id} className="audit-row">
          <code>{e.action}</code>
          <span className="grow">{e.detail}</span>
          <small className="muted">{e.actorName ?? "system"} · {ago(e.createdAt)}</small>
        </div>
      ))}
      {entries && entries.length > 8 && <button className="link sm" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${entries.length}`}</button>}
    </section>
  );
}
