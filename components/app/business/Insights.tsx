"use client";

import { useEffect, useState } from "react";
import { useToast } from "../context";
import { Spinner } from "../ui";
import { duration, useBiz } from "./shared";

type Data = {
  days: number;
  daily: { day: string; calls: number; answered: number; talk: number; messages: number }[];
  agents: { name: string; calls: number; answered: number; talk: number; messages: number; won: number }[];
  dispositions: { label: string; n: number }[];
  channels: { label: string; n: number }[];
  sources: { label: string; n: number; won: number }[];
  hours: { hour: number; n: number }[];
};

export function Insights() {
  const { call, version } = useBiz();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    void call<Data>(`analytics?days=${days}`).then(setD).catch((e: Error) => toast(e.message, "error"));
  }, [call, days, version, toast]);

  const total = d?.daily.reduce((s, x) => s + x.calls, 0) ?? 0;
  const answered = d?.daily.reduce((s, x) => s + x.answered, 0) ?? 0;
  const talk = d?.daily.reduce((s, x) => s + x.talk, 0) ?? 0;
  const msgs = d?.daily.reduce((s, x) => s + x.messages, 0) ?? 0;

  return (
    <div className="biz-page">
      <div className="toolbar">
        <div className="segmented sm">
          {[7, 30, 90].map((n) => <button key={n} className={days === n ? "active" : ""} onClick={() => setDays(n)}>{n} days</button>)}
        </div>
      </div>
      {!d ? <div className="center pad"><Spinner /></div> : (
        <>
          <div className="kpis">
            <div className="kpi"><span>Calls</span><b>{total}</b><small>last {days} days</small></div>
            <div className="kpi"><span>Answer rate</span><b>{total ? Math.round((answered / total) * 100) : 0}%</b><small>{answered} answered</small></div>
            <div className="kpi"><span>Avg. call</span><b>{duration(answered ? Math.round(talk / answered) : 0)}</b><small>{duration(talk)} total</small></div>
            <div className="kpi"><span>Messages</span><b>{msgs}</b><small>{d.channels.map((c) => `${c.n} ${c.label}`).join(" · ") || "SMS + WhatsApp"}</small></div>
          </div>

          <div className="biz-grid">
            <section className="card-section span-2">
              <h3>Calls per day</h3>
              <Columns
                items={d.daily.map((x) => ({ key: x.day, value: x.calls, tip: `${fmtDay(x.day)} · ${x.calls} calls · ${x.answered} answered · ${duration(x.talk)}` }))}
                labelEvery={days <= 7 ? 1 : days <= 30 ? 5 : 15}
                label={(i) => fmtDay(d.daily[i].day)}
              />
            </section>

            <section className="card-section">
              <h3>When customers call</h3>
              <p className="muted small">Inbound calls by hour (IST) — staff up when the bars are tall.</p>
              <Columns
                items={Array.from({ length: 24 }, (_, h) => {
                  const n = d.hours.find((x) => x.hour === h)?.n ?? 0;
                  return { key: String(h), value: n, tip: `${h}:00–${h + 1}:00 · ${n} inbound calls` };
                })}
                labelEvery={6}
                label={(i) => `${i}:00`}
              />
            </section>

            <section className="card-section">
              <h3>Call outcomes</h3>
              <Bars items={d.dispositions.map((x) => ({ label: x.label, value: x.n }))} empty="Log outcomes after calls to see them here." />
            </section>

            <section className="card-section">
              <h3>Lead sources</h3>
              <Bars items={d.sources.map((x) => ({ label: x.label, value: x.n, note: `${x.won} won` }))} empty="No leads yet." />
            </section>

            <section className="card-section">
              <h3>Team performance</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Member</th><th>Calls</th><th>Answered</th><th>Talk</th><th>Msgs</th><th>Won</th></tr></thead>
                  <tbody>
                    {d.agents.map((a) => (
                      <tr key={a.name}><td>{a.name}</td><td>{a.calls}</td><td>{a.answered}</td><td>{duration(a.talk)}</td><td>{a.messages}</td><td>{a.won}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function fmtDay(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Single-series column chart: one accent hue, rounded data-ends, hover tooltip per column. */
function Columns({ items, labelEvery, label }: { items: { key: string; value: number; tip: string }[]; labelEvery: number; label: (i: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="colchart" role="img" aria-label={`Chart, peak ${max}`} onMouseLeave={() => setHover(null)}>
      <div className="colchart-grid"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div>
      <div className="colchart-plot">
        {items.map((it, i) => (
          <div key={it.key} className={`col${hover === i ? " hover" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={it.tip}>
            <i style={{ height: `${(it.value / max) * 100}%` }} />
            {hover === i && <span className="col-tip">{it.tip}</span>}
          </div>
        ))}
      </div>
      <div className="colchart-x">
        {items.map((it, i) => <span key={it.key}>{i % labelEvery === 0 ? label(i) : ""}</span>)}
      </div>
    </div>
  );
}

/** Horizontal bars with direct value labels (text in ink colours, bar in accent). */
function Bars({ items, empty }: { items: { label: string; value: number; note?: string }[]; empty: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="hbars">
      {items.map((it) => (
        <div key={it.label} className="hbar" title={`${it.label}: ${it.value}${it.note ? ` · ${it.note}` : ""}`}>
          <span className="hbar-label">{it.label}</span>
          <span className="hbar-track"><i style={{ width: `${(it.value / max) * 100}%` }} /></span>
          <b>{it.value}</b>{it.note && <small className="muted">{it.note}</small>}
        </div>
      ))}
    </div>
  );
}
