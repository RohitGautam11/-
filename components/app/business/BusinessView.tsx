"use client";

import {
  AlertTriangle, BarChart3, Briefcase, Building2, CalendarClock, Check, ChevronDown, Contact as ContactIcon, Headset, Inbox, LayoutDashboard, Megaphone, Phone,
  PhoneCall, PhoneIncoming, PhoneMissed, PiggyBank, Plus, Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { INDUSTRIES, STAGES } from "@/lib/biz-shared";
import { api } from "@/lib/client/api";
import { ago } from "@/lib/client/selectors";
import { useAction, useEngine, useToast } from "../context";
import { Empty, Spinner, Toggle, useNow } from "../ui";
import { CallDock, type DockTarget } from "./CallDock";
import { ContactDrawer, Contacts } from "./Contacts";
import { CallsLog } from "./CallsLog";
import { Helpdesk } from "./Helpdesk";
import { InboxView } from "./Inbox";
import { Insights } from "./Insights";
import { BizContext, bizApi, duration, inr, STATUS_LABEL, useBiz, type BizSection, type DialTarget, type Overview } from "./shared";
import { SocialHub } from "./Social";
import { TeamView } from "./Team";

type WsSummary = { id: string; name: string; industry: string; role: string; members: number };
const WS_KEY = "vt:biz-ws";

export function BusinessView() {
  const [list, setList] = useState<WsSummary[] | null>(null);
  const [ws, setWs] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadList = useCallback(() => api<{ workspaces: WsSummary[] }>("/api/biz").then((res) => {
    setList(res.workspaces);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(WS_KEY);
    } catch {
      // ignore
    }
    setWs((cur) => cur && res.workspaces.some((w) => w.id === cur) ? cur : res.workspaces.find((w) => w.id === saved)?.id ?? res.workspaces[0]?.id ?? null);
  }), []);
  useEffect(() => {
    void loadList().catch(() => setList([]));
  }, [loadList]);

  const pick = (id: string) => {
    setWs(id);
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {
      // ignore
    }
  };

  if (!list) return <div className="center pad"><Spinner /></div>;
  if (!list.length || creating) {
    return <Onboarding canCancel={list.length > 0} onCancel={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await loadList(); pick(id); }} />;
  }
  if (!ws) return null;
  return <Workspace key={ws} ws={ws} list={list} onSwitch={pick} onNew={() => setCreating(true)} onLeft={() => { setWs(null); void loadList(); }} />;
}

function Onboarding({ onCreated, canCancel, onCancel }: { onCreated: (id: string) => void; canCancel: boolean; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("travel");
  const [demo, setDemo] = useState(true);
  const [run, busy] = useAction();
  return (
    <div className="wallet biz-onboard">
      <header className="page-head"><div><h1>Business Suite</h1><p className="muted">One number. Your whole team. Every channel.</p></div></header>
      <div className="biz-hero">
        <div className="biz-hero-copy">
          <h2>Turn one business number into a call centre</h2>
          <ul>
            <li><PhoneCall size={16} /> <span><b>Click-to-call with number masking</b> — customers see only your business number; agents never see customers&apos; numbers.</span></li>
            <li><Users size={16} /> <span><b>One number rings the whole team</b> — ring-all or round-robin, so no call is missed and nobody needs a second SIM.</span></li>
            <li><Inbox size={16} /> <span><b>SMS + WhatsApp inbox</b> on the same number, with templates and a missed-call auto-reply.</span></li>
            <li><Headset size={16} /> <span><b>Helpdesk with SLAs</b> — every complaint, question and missed call becomes a ticket with an owner and a deadline, plus a public help centre for your customers.</span></li>
            <li><ContactIcon size={16} /> <span><b>Built-in CRM</b> — every call and message lands on the customer&apos;s timeline automatically.</span></li>
            <li><Megaphone size={16} /> <span><b>Social hub</b> — manage all your handles and schedule posts from one place.</span></li>
            <li><PiggyBank size={16} /> <span><b>Lower bills</b> — pay per minute on one line instead of a SIM and plan for every employee.</span></li>
          </ul>
        </div>
      </div>
      <section className="card-section">
        <h3><Building2 size={17} /> Create your workspace</h3>
        <label className="field"><span>Business name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Yatra Sathi Tours" maxLength={60} /></label>
        <label className="field"><span>Industry</span>
          <select value={industry} onChange={(e) => setIndustry(e.target.value)}>{INDUSTRIES.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>
        </label>
        <div className="row between setting-row">
          <span><b>Add sample data</b><small className="muted block">Leads, calls, messages and follow-ups so you can demo every screen right away.</small></span>
          <Toggle checked={demo} onChange={setDemo} label="Add sample data" />
        </div>
        <p className="muted small">You start on the free <b>demo line</b> (simulated calls and texts). Connect a real Twilio or Exotel number any time under Team &amp; lines.</p>
        <div className="row gap-xs">
          <button className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={() => void run(async () => {
            const res = await api<{ id: string }>("/api/biz", { body: { name: name.trim(), industry, demo } });
            onCreated(res.id);
          }, "Workspace ready 🎉")}>{busy ? <Spinner size={16} /> : <Plus size={17} />} Create workspace</button>
          {canCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        </div>
      </section>
    </div>
  );
}

const SECTIONS: { id: BizSection; label: string; icon: typeof Phone }[] = [
  { id: "home", label: "Overview", icon: LayoutDashboard },
  { id: "contacts", label: "Leads", icon: ContactIcon },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "helpdesk", label: "Helpdesk", icon: Headset },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "social", label: "Social", icon: Megaphone },
  { id: "insights", label: "Insights", icon: BarChart3 },
  { id: "team", label: "Team & lines", icon: Users },
];

function Workspace({ ws, list, onSwitch, onNew, onLeft }: { ws: string; list: WsSummary[]; onSwitch: (id: string) => void; onNew: () => void; onLeft: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [section, setSection] = useState<BizSection>("home");
  const [contactId, setContactId] = useState<string | null>(null);
  const [dock, setDock] = useState<DockTarget | null>(null);
  const [queue, setQueue] = useState<DialTarget[]>([]);
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState(false);
  const call = useMemo(() => bizApi(ws), [ws]);

  const reload = useCallback(() => call<Overview>("").then((next) => {
    setData(next);
    setVersion((v) => v + 1);
  }, (error: Error) => {
    toast(error.message, "error");
    onLeft();
  }), [call, toast, onLeft]);
  useEffect(() => {
    void reload();
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);

  if (!data) return <div className="center pad"><Spinner /></div>;
  const ctx = {
    ws, data, reload, call, version, isAdmin: data.role !== "agent",
    dial: (t: DockTarget) => setDock(t),
    dialQueue: (targets: DialTarget[]) => {
      if (!targets.length) return;
      setQueue(targets.slice(1));
      setDock(targets[0]);
    },
    queue: queue.length || dock ? { left: queue.length, stop: () => setQueue([]) } : null,
    openContact: (id: string) => setContactId(id),
    go: (s: BizSection) => setSection(s),
  };
  const current = list.find((w) => w.id === ws);

  return (
    <BizContext.Provider value={ctx}>
      <div className="biz">
        <header className="biz-head">
          <div className="biz-switch">
            <button className="biz-ws" onClick={() => setMenu(!menu)}>
              <span className="biz-ws-icon"><Briefcase size={18} /></span>
              <span><strong>{data.workspace.name}</strong><small>{data.role} · {current?.members ?? data.members.length} member{(current?.members ?? 1) === 1 ? "" : "s"}</small></span>
              <ChevronDown size={16} />
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="msg-menu biz-ws-menu">
                  {list.map((w) => (
                    <button key={w.id} onClick={() => { setMenu(false); onSwitch(w.id); }}>
                      {w.id === ws ? <Check size={16} /> : <span style={{ width: 16 }} />} {w.name}
                    </button>
                  ))}
                  <button onClick={() => { setMenu(false); onNew(); }}><Plus size={16} /> New workspace</button>
                </div>
              </>
            )}
          </div>
          <Availability />
        </header>
        <nav className="biz-nav" aria-label="Business sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={section === id ? "active" : ""} onClick={() => setSection(id)} data-tour={`biz-${id}`}>
              <Icon size={16} /> {label}
              {id === "inbox" && data.today.messages > 0 ? <span className="dot" /> : null}
              {id === "helpdesk" && data.helpdesk.breached > 0 ? <span className="badge">{data.helpdesk.breached}</span> : null}
            </button>
          ))}
        </nav>
        <div className="biz-body">
          {section === "home" && <Home />}
          {section === "contacts" && <Contacts />}
          {section === "calls" && <CallsLog />}
          {section === "helpdesk" && <Helpdesk />}
          {section === "inbox" && <InboxView />}
          {section === "social" && <SocialHub />}
          {section === "insights" && <Insights />}
          {section === "team" && <TeamView onLeft={onLeft} />}
        </div>
        {contactId && <ContactDrawer id={contactId} onClose={() => { setContactId(null); void reload(); }} />}
        {dock && <CallDock key={dock.contactId ?? dock.number} target={dock} queueLeft={queue.length} onStopQueue={() => setQueue([])} onClose={() => {
          // Power dialer: the next lead opens as soon as this call is logged.
          const [next, ...rest] = queue;
          setQueue(rest);
          setDock(next ?? null);
          void reload();
        }} />}
      </div>
    </BizContext.Provider>
  );
}

function Availability() {
  const { data, call, reload } = useBiz();
  const engine = useEngine();
  const toast = useToast();
  const set = (availability: string) => {
    void call(`members/${engine.me.id}`, { method: "PATCH", body: { availability } }).then(reload).catch((e: Error) => toast(e.message, "error"));
  };
  return (
    <label className={`avail avail-${data.me.availability}`} title="Your availability — only available teammates ring for inbound calls">
      <span className="avail-dot" />
      <select value={data.me.availability} onChange={(e) => set(e.target.value)} aria-label="Your availability">
        <option value="available">Available</option>
        <option value="busy">Busy</option>
        <option value="away">Away</option>
      </select>
    </label>
  );
}

function Home() {
  const { data, go, openContact, dial, call, reload, isAdmin } = useBiz();
  const [run, busy] = useAction();
  const now = useNow(60_000);
  const t = data.today;
  const answerRate = t.total ? Math.round((t.answered / t.total) * 100) : 0;
  const pipelineValue = data.pipeline.filter((p) => !["won", "lost"].includes(p.stage)).reduce((s, p) => s + Number(p.value), 0);
  const won = data.pipeline.find((p) => p.stage === "won");
  const demoLine = data.lines.some((l) => l.provider === "simulator");

  return (
    <div className="biz-page">
      {demoLine && (
        <div className="banner biz-banner"><PhoneCall size={15} /> You&apos;re on the <b>demo line</b> — calls and texts are simulated. {data.role !== "agent" && <button className="link sm" onClick={() => go("team")}>Connect a real number →</button>}</div>
      )}
      {data.social.due > 0 && !data.socialWebhook && (
        <button className="banner warn" onClick={() => go("social")}><CalendarClock size={15} /> {data.social.due} scheduled post{data.social.due > 1 ? "s are" : " is"} due — tap to publish.</button>
      )}
      <div className="kpis">
        <Kpi label="Calls today" value={t.total} sub={`${t.outbound} out · ${t.inbound} in`} />
        <Kpi label="Answer rate" value={`${answerRate}%`} sub={`${t.answered} answered`} />
        <Kpi label="Missed" value={t.missed} sub="call them back" tone={t.missed ? "warn" : undefined} onClick={() => go("calls")} />
        <Kpi label="Talk time" value={duration(t.talk)} sub={`${t.messages} messages`} />
        <Kpi label="Open pipeline" value={inr(pipelineValue, true)} sub={`${inr(Number(won?.value ?? 0), true)} won`} />
        <Kpi label="Open tickets" value={data.helpdesk.open} sub={`${data.helpdesk.mine} assigned to you`} onClick={() => go("helpdesk")} />
        <Kpi label="SLA breached" value={data.helpdesk.breached} sub={`${data.helpdesk.callbacks} callbacks waiting`} tone={data.helpdesk.breached ? "warn" : undefined} onClick={() => go("helpdesk")} />
      </div>
      {data.helpdesk.breached > 0 && (
        <button className="banner warn" onClick={() => go("helpdesk")}><AlertTriangle size={15} /> {data.helpdesk.breached} ticket{data.helpdesk.breached > 1 ? "s have" : " has"} missed the response target — tap to see the queue.</button>
      )}
      {demoLine && isAdmin && (
        <div className="row gap-xs wrap">
          <button className="btn btn-ghost sm" disabled={busy} onClick={() => void run(async () => {
            const res = await call<{ contactName: string; ticket: { number: number } | null }>("calls/simulate-inbound", { body: {} });
            await reload();
            return res;
          }, "Missed call from a customer → callback ticket opened in Helpdesk")}><PhoneIncoming size={15} /> Demo: simulate a missed customer call</button>
        </div>
      )}

      <div className="biz-grid">
        <section className="card-section">
          <div className="row between"><h3>Pipeline</h3><button className="link sm" onClick={() => go("contacts")}>Open board →</button></div>
          <div className="funnel">
            {STAGES.map((s) => {
              const row = data.pipeline.find((p) => p.stage === s.id);
              const max = Math.max(1, ...data.pipeline.map((p) => p.n));
              return (
                <div key={s.id} className="funnel-row" title={`${s.label}: ${row?.n ?? 0} leads · ${inr(Number(row?.value ?? 0))}`}>
                  <span className="funnel-label">{s.label}</span>
                  <span className="funnel-track"><i style={{ width: `${((row?.n ?? 0) / max) * 100}%`, background: s.color }} /></span>
                  <b>{row?.n ?? 0}</b>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card-section">
          <div className="row between"><h3><CalendarClock size={17} /> Follow-ups</h3><button className="link sm" onClick={() => go("contacts")}>All leads →</button></div>
          {data.tasks.length === 0 && <p className="muted small">Nothing due. Add follow-ups from any lead.</p>}
          {data.tasks.map((task) => {
            const overdue = new Date(task.dueAt).getTime() < now;
            return (
              <button key={task.id} className="ledger-row" onClick={() => task.contactId && openContact(task.contactId)}>
                <span className={`task-dot${overdue ? " overdue" : ""}`} />
                <span className="ledger-copy"><strong>{task.title}</strong><small>{task.contactName ?? "General"} · {overdue ? "overdue" : "due"} {ago(task.dueAt).replace(" ago", "")}</small></span>
              </button>
            );
          })}
        </section>

        <section className="card-section span-2">
          <div className="row between"><h3>Recent calls</h3><button className="link sm" onClick={() => go("calls")}>Call log →</button></div>
          {data.recentCalls.length === 0 && <Empty icon="📞" title="No calls yet"><p>Open a lead and tap Call.</p></Empty>}
          {data.recentCalls.map((c) => (
            <div key={c.id} className="ledger-row">
              <span className={`ledger-icon ${c.status === "completed" ? "in" : "out"}`}>{["missed", "no-answer", "busy", "failed"].includes(c.status) ? <PhoneMissed size={17} /> : <Phone size={17} />}</span>
              <button className="ledger-copy" onClick={() => c.contactId && openContact(c.contactId)}>
                <strong>{c.contactName ?? c.remoteNumber}</strong>
                <small>{c.direction === "inbound" ? "Inbound" : "Outbound"} · {STATUS_LABEL[c.status] ?? c.status}{c.durationSec ? ` · ${duration(c.durationSec)}` : ""} · {ago(c.startedAt)}{c.agentName ? ` · ${c.agentName}` : ""}</small>
              </button>
              {c.contactId && <button className="icon-btn soft" aria-label="Call back" onClick={() => dial({ contactId: c.contactId!, name: c.contactName ?? "Contact", phone: c.remoteNumber })}><Phone size={16} /></button>}
            </div>
          ))}
        </section>

        <SavingsCalculator />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string | number; sub: string; tone?: "warn"; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`kpi${tone ? ` kpi-${tone}` : ""}`} onClick={onClick}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
    </Tag>
  );
}

/** Sales tool: shows a prospect what moving from "a SIM per employee" to one shared line saves. */
function SavingsCalculator() {
  const [agents, setAgents] = useState(8);
  const [simCost, setSimCost] = useState(399);
  const [phoneCost, setPhoneCost] = useState(600);
  const [minutes, setMinutes] = useState(3000);
  const [rate, setRate] = useState(0.6);
  const [platform, setPlatform] = useState(299);
  const before = agents * (simCost + phoneCost);
  const after = minutes * rate + agents * platform;
  const saved = before - after;
  return (
    <section className="card-section span-2 savings">
      <h3><PiggyBank size={17} /> Bill savings calculator</h3>
      <p className="muted small">Compare one SIM + handset per employee with one shared business line. Adjust the numbers for your own business.</p>
      <div className="savings-grid">
        <Num label="Team members" value={agents} set={setAgents} />
        <Num label="Plan per SIM (₹/mo)" value={simCost} set={setSimCost} />
        <Num label="Phone EMI / upkeep (₹/mo)" value={phoneCost} set={setPhoneCost} />
        <Num label="Call minutes / month" value={minutes} set={setMinutes} />
        <Num label="Per-minute rate (₹)" value={rate} set={setRate} step={0.05} />
        <Num label="Seat price (₹/agent/mo)" value={platform} set={setPlatform} />
      </div>
      <div className="savings-result">
        <div><span>Today</span><b>{inr(before * 100)}</b><small>/month</small></div>
        <div><span>With one line</span><b>{inr(after * 100)}</b><small>/month</small></div>
        <div className={saved >= 0 ? "good" : "bad"}><span>{saved >= 0 ? "You save" : "Extra cost"}</span><b>{inr(Math.abs(saved) * 100)}</b><small>{inr(Math.abs(saved) * 1200)} / year</small></div>
      </div>
    </section>
  );
}

function Num({ label, value, set, step = 1 }: { label: string; value: number; set: (n: number) => void; step?: number }) {
  return (
    <label className="field"><span>{label}</span>
      <input type="number" min={0} step={step} value={value} onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))} />
    </label>
  );
}
