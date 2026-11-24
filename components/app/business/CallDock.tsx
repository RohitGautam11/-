"use client";

import { PhoneCall, PhoneOff, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { DISPOSITIONS, formatPhone } from "@/lib/biz-shared";
import { useAction, useToast } from "../context";
import { Spinner } from "../ui";
import { duration, STATUS_LABEL, useBiz, type CallLog } from "./shared";

export type DockTarget = { contactId?: string; number?: string; name: string; phone?: string };

const FINAL = ["completed", "no-answer", "busy", "failed", "missed", "canceled"];

/** Floating panel for one business call: pick a line → dial → live status → log the outcome. */
export function CallDock({ target, onClose, queueLeft = 0, onStopQueue }: { target: DockTarget; onClose: () => void; queueLeft?: number; onStopQueue?: () => void }) {
  const { data, call } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const voiceLines = data.lines.filter((l) => l.active && l.channels.includes("voice"));
  const [lineId, setLineId] = useState(voiceLines[0]?.id ?? "");
  const [log, setLog] = useState<CallLog | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [disposition, setDisposition] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followWhen, setFollowWhen] = useState(() => tomorrowAt10());

  const line = data.lines.find((l) => l.id === (log?.lineId ?? lineId));
  const simulated = line?.provider === "simulator";
  const final = log && FINAL.includes(log.status);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Real carriers report progress through webhooks; poll the call row until it settles.
  useEffect(() => {
    if (!log || simulated || final) return;
    const t = setInterval(() => {
      void call<{ call: CallLog }>(`calls/${log.id}`).then((r) => setLog(r.call)).catch(() => undefined);
    }, 2500);
    return () => clearInterval(t);
  }, [log, simulated, final, call]);

  const dial = () => void run(async () => {
    const res = await call<{ call: CallLog }>("calls", { body: { lineId, contactId: target.contactId, number: target.number } });
    setLog(res.call);
  });

  const simulate = (status: "in-progress" | "completed" | "no-answer" | "busy") => void run(async () => {
    const res = await call<{ call: CallLog }>(`calls/${log!.id}`, { method: "PATCH", body: { status } });
    setLog(res.call);
    if (status === "no-answer" || status === "busy") setDisposition("No answer");
  });

  const save = () => void run(async () => {
    if (disposition || notes.trim()) await call(`calls/${log!.id}`, { method: "PATCH", body: { disposition, notes: notes.trim() || undefined } });
    if (followUp.trim()) {
      await call("tasks", { body: { title: followUp.trim(), dueAt: new Date(followWhen).toISOString(), contactId: log!.contactId ?? undefined } });
    }
    toast(queueLeft ? "Call logged ✓ — next lead" : "Call logged ✓", "success");
    onClose();
  });

  const live = log?.status === "in-progress";
  const elapsed = live && log.answeredAt ? Math.max(0, Math.floor((now - new Date(log.answeredAt).getTime()) / 1000)) : 0;

  return (
    <aside className="call-dock" aria-label={`Call ${target.name}`}>
      <header className="row between">
        <div className="call-dock-who">
          <span className={`call-dock-icon${live ? " live" : ""}`}><PhoneCall size={18} /></span>
          <span><strong>{target.name}</strong><small>{target.phone ? formatPhone(target.phone) : target.number}</small></span>
        </div>
        {(!log || final) && <button className="icon-btn" onClick={onClose} aria-label={queueLeft ? "Skip to next lead" : "Close"} title={queueLeft ? "Skip to next lead" : "Close"}><X size={18} /></button>}
      </header>
      {queueLeft > 0 && (
        <div className="dialer-strip">
          <span>⚡ Power dialer · {queueLeft} more lead{queueLeft > 1 ? "s" : ""} after this</span>
          <button className="link sm" onClick={onStopQueue}>Stop after this call</button>
        </div>
      )}

      {!log && (
        <>
          {voiceLines.length === 0 ? (
            <p className="muted small">No active line has voice enabled. Add one under Team &amp; lines.</p>
          ) : (
            <label className="field"><span>Call from</span>
              <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
                {voiceLines.map((l) => <option key={l.id} value={l.id}>{l.label} · {formatPhone(l.phoneNumber)}{l.provider === "simulator" ? " (demo)" : ""}</option>)}
              </select>
            </label>
          )}
          <p className="muted small mask-note"><ShieldCheck size={13} /> The customer sees only your business number{line && line.provider !== "simulator" ? ". Your phone rings first — pick up and we connect the customer." : "."}</p>
          <button className="btn btn-primary btn-block" disabled={busy || !lineId} onClick={dial}>{busy ? <Spinner size={16} /> : <PhoneCall size={17} />} Call now</button>
        </>
      )}

      {log && !final && (
        <div className="call-dock-live">
          <div className="call-dock-status">
            <b>{live ? `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}` : STATUS_LABEL[log.status] ?? log.status}</b>
            <small>{simulated ? "Demo call — choose what the customer does" : live ? "Connected" : "Ring your phone, then the customer…"}</small>
          </div>
          {simulated && !live && (
            <div className="row gap-xs">
              <button className="btn btn-primary sm" disabled={busy} onClick={() => simulate("in-progress")}>Customer answered</button>
              <button className="btn btn-ghost sm" disabled={busy} onClick={() => simulate("no-answer")}>No answer</button>
              <button className="btn btn-ghost sm" disabled={busy} onClick={() => simulate("busy")}>Busy</button>
            </div>
          )}
          {simulated && live && (
            <button className="btn btn-danger btn-block" disabled={busy} onClick={() => simulate("completed")}><PhoneOff size={17} /> End call</button>
          )}
          {!simulated && <p className="muted small">Hang up on your phone to end. This panel updates by itself.</p>}
          <label className="field"><span>Notes while you talk</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Dates, budget, people…" /></label>
        </div>
      )}

      {log && final && (
        <div className="call-dock-live">
          <div className="call-dock-status">
            <b>{STATUS_LABEL[log.status] ?? log.status}</b>
            <small>{log.durationSec ? `Talk time ${duration(log.durationSec)}` : log.notes || "Log the outcome"}</small>
          </div>
          <div className="chips">
            {DISPOSITIONS.map((d) => <button key={d} className={`chip${disposition === d ? " on" : ""}`} onClick={() => setDisposition(disposition === d ? null : d)}>{d}</button>)}
          </div>
          <label className="field"><span>Notes</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed?" /></label>
          <div className="followup">
            <label className="field grow"><span>Follow-up (optional)</span><input value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="e.g. Send revised quote" /></label>
            <label className="field"><span>When</span><input type="datetime-local" value={followWhen} onChange={(e) => setFollowWhen(e.target.value)} /></label>
          </div>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={save}>{queueLeft ? "Save & call next" : "Save & close"}</button>
        </div>
      )}
    </aside>
  );
}

export function tomorrowAt10() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
