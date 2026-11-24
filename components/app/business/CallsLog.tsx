"use client";

import { Delete, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { normalizePhone, STAGES } from "@/lib/biz-shared";
import { ago } from "@/lib/client/selectors";
import { useAction, useToast } from "../context";
import { Empty, Spinner } from "../ui";
import { duration, STATUS_LABEL, useBiz, type CallLog, type Contact } from "./shared";

const MISSED = ["missed", "no-answer", "busy", "failed", "canceled"];

export function CallsLog() {
  const { call, version, dial, openContact, isAdmin, data } = useBiz();
  const toast = useToast();
  const [calls, setCalls] = useState<CallLog[] | null>(null);
  const [filter, setFilter] = useState<"all" | "mine" | "missed" | "inbound" | "outbound">("all");
  const [pad, setPad] = useState("");

  useEffect(() => {
    void call<{ calls: CallLog[] }>(`calls${filter === "mine" ? "?mine=1" : ""}`).then((r) => setCalls(r.calls)).catch((e: Error) => toast(e.message, "error"));
  }, [call, filter, version, toast]);

  const shown = (calls ?? []).filter((c) =>
    filter === "missed" ? MISSED.includes(c.status) && c.direction === "inbound" || c.status === "missed"
      : filter === "inbound" || filter === "outbound" ? c.direction === filter : true);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"];

  return (
    <div className="biz-page calls-layout">
      <section className="card-section">
        <div className="row between">
          <h3>Call log</h3>
          <div className="filters" style={{ padding: 0, flexWrap: "wrap" }}>
            {(["all", "mine", "missed", "inbound", "outbound"] as const).map((f) => (
              <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
        </div>
        {!calls && <div className="center pad"><Spinner /></div>}
        {calls && shown.length === 0 && <Empty icon="📞" title="No calls"><p>Calls placed or received on your business lines appear here automatically.</p></Empty>}
        {shown.map((c) => {
          const missed = MISSED.includes(c.status);
          return (
            <div key={c.id} className="ledger-row">
              <span className={`ledger-icon ${missed ? "out" : "in"}`}>
                {missed ? <PhoneMissed size={17} /> : c.direction === "inbound" ? <PhoneIncoming size={17} /> : <PhoneOutgoing size={17} />}
              </span>
              <button className="ledger-copy" onClick={() => c.contactId && openContact(c.contactId)}>
                <strong>{c.contactName ?? c.remoteNumber}</strong>
                <small>
                  {STATUS_LABEL[c.status] ?? c.status}{c.durationSec ? ` · ${duration(c.durationSec)}` : ""} · {c.lineLabel ?? "line"} · {c.agentName ?? "unassigned"} · {ago(c.startedAt)}
                  {c.disposition ? ` · ${c.disposition}` : ""}
                </small>
                {c.recordingUrl && <audio controls preload="none" src={c.recordingUrl} className="tl-audio" onClick={(e) => e.stopPropagation()} />}
              </button>
              {c.contactId && (
                <button className="icon-btn soft" aria-label="Call back" onClick={() => dial({ contactId: c.contactId!, name: c.contactName ?? "Contact", phone: c.remoteNumber })}><Phone size={16} /></button>
              )}
            </div>
          );
        })}
      </section>

      <div className="col-stack">
      <PowerDialer />
      <section className="card-section dialpad-card">
        <h3><Phone size={17} /> Dial pad</h3>
        {isAdmin ? (
          <>
            <input className="input dial-display" value={pad} onChange={(e) => setPad(e.target.value.replace(/[^\d+ ]/g, ""))} placeholder="+91 98765 43210" inputMode="tel" />
            <div className="dialpad">
              {keys.map((k) => (
                <button key={k} onClick={() => setPad((p) => (k === "⌫" ? p.slice(0, -1) : (p + k).slice(0, 18)))} aria-label={k === "⌫" ? "Delete" : k}>
                  {k === "⌫" ? <Delete size={18} /> : k}
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-block" disabled={!normalizePhone(pad)} onClick={() => dial({ number: pad, name: "New number", phone: normalizePhone(pad) ?? pad })}>
              <Phone size={17} /> Call from {data.lines.find((l) => l.active)?.label ?? "business line"}
            </button>
            <p className="muted small">New numbers are logged; save them as a lead from the call log.</p>
          </>
        ) : (
          <p className="muted small">🔒 Number masking is on: agents call customers from the Leads list, so customer numbers never appear on agents&apos; screens or phones.</p>
        )}
      </section>
      </div>
    </div>
  );
}

/** Builds a call list from the pipeline and dials it lead after lead — the agent only talks and logs the outcome. */
function PowerDialer() {
  const { call, dialQueue, queue } = useBiz();
  const [run, busy] = useAction();
  const [stage, setStage] = useState("new");
  const [days, setDays] = useState(2);
  const [max, setMax] = useState(20);
  return (
    <section className="card-section" data-tour="power-dialer">
      <h3><Zap size={17} /> Power dialer</h3>
      <p className="muted small">Pick who to call. Each call opens as soon as you log the last one — no searching, no typing numbers.</p>
      <div className="two-col">
        <label className="field"><span>Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {STAGES.filter((x) => x.id !== "won" && x.id !== "lost").map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Not called for</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={0}>Any time</option><option value={1}>1+ day</option><option value={2}>2+ days</option><option value={7}>7+ days</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Up to</span>
        <select value={max} onChange={(e) => setMax(Number(e.target.value))}>{[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n} leads</option>)}</select>
      </label>
      <button className="btn btn-primary btn-block" disabled={busy || Boolean(queue)} onClick={() => void run(async () => {
        const res = await call<{ contacts: Contact[] }>(`contacts?stage=${stage}`);
        const cutoff = Date.now() - days * 86_400_000;
        const list = res.contacts
          .filter((c) => !days || !c.lastContactedAt || new Date(c.lastContactedAt).getTime() < cutoff)
          .sort((a, b) => (b.value - a.value) || (new Date(a.lastContactedAt ?? 0).getTime() - new Date(b.lastContactedAt ?? 0).getTime()))
          .slice(0, max);
        if (!list.length) throw new Error("No leads match. Try another stage or time window.");
        dialQueue(list.map((c) => ({ contactId: c.id, name: c.name, phone: c.phone })));
      })}><Zap size={16} /> {queue ? "Dialer running…" : "Start calling"}</button>
      <p className="muted small">Highest-value leads first. Works with masked numbers, so agents can use it too.</p>
    </section>
  );
}
