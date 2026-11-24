"use client";

import { ArrowLeft, CheckCircle2, Clock, Send, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";

type Data = {
  workspace: { name: string };
  ticket: { number: number; kind: string; subject: string; description: string; status: string; requesterName: string; agentName: string | null; createdAt: string; resolvedAt: string | null; csat: number | null };
  messages: { id: string; from: "you" | "team"; body: string; name: string | null; createdAt: string }[];
};

const STATUS: Record<string, { label: string; note: string }> = {
  open: { label: "Open", note: "Our team is on it." },
  pending: { label: "Waiting for you", note: "We've replied. Reply below if you need anything else." },
  resolved: { label: "Resolved", note: "We think this is sorted. Reply below to reopen it." },
  closed: { label: "Closed", note: "This ticket is closed." },
};

const when = (d: string) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The customer's private view of one ticket: status, replies, their own replies and a rating at the end. */
export function TicketTracker({ ws, token }: { ws: string; token: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const url = `/api/public/help/${ws}/tickets/${token}`;

  const load = useCallback(() => api<Data>(url).then(setData).catch(() => setMissing(true)), [url]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <main className="help"><div className="help-card center"><h1>Ticket not found</h1><p className="muted">Check that you opened the full link you were given.</p></div></main>;
  if (!data) return <main className="help"><div className="help-card center"><span className="spinner" /></div></main>;
  const t = data.ticket;
  const s = STATUS[t.status] ?? STATUS.open;
  const done = t.status === "resolved" || t.status === "closed";

  return (
    <main className="help">
      <a className="link help-back" href={`/help/${ws}`}><ArrowLeft size={15} /> {data.workspace.name} help centre</a>
      <section className="help-card">
        <div className="row between wrap">
          <div>
            <small className="muted">{t.kind === "callback" ? "Callback request" : "Ticket"} #{t.number} · opened {when(t.createdAt)}</small>
            <h1 className="help-title">{t.subject}</h1>
          </div>
          <span className={`help-status st-${t.status}`}>{done ? <CheckCircle2 size={15} /> : <Clock size={15} />} {s.label}</span>
        </div>
        <p className="muted">{s.note}{t.agentName && !done ? ` ${t.agentName} is looking after it.` : ""}</p>

        <div className="thread help-thread">
          {t.description && <div className="sms out"><p>{t.description}</p><small>You · {when(t.createdAt)}</small></div>}
          {data.messages.map((m) => (
            <div key={m.id} className={`sms ${m.from === "you" ? "out" : "in"}`}>
              <p>{m.body}</p>
              <small>{m.from === "you" ? "You" : `${m.name ?? "Support"} · ${data.workspace.name}`} · {when(m.createdAt)}</small>
            </div>
          ))}
        </div>

        {t.status !== "closed" && (
          <div className="sms-input">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder={done ? "Still a problem? Reply to reopen…" : "Add details or reply…"} aria-label="Your reply" />
            <button className="icon-btn accent" disabled={busy || !text.trim()} aria-label="Send" onClick={() => void act(async () => {
              await api(`${url}/reply`, { body: { body: text.trim() } });
              setText("");
            })}><Send size={18} /></button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
      </section>

      {done && !t.csat && (
        <section className="help-card center">
          <h2>How did we do?</h2>
          <div className="stars" role="radiogroup" aria-label="Rate the support">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} role="radio" aria-checked={score === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} className={n <= score ? "on" : ""} onClick={() => setScore(n)}><Star size={30} /></button>
            ))}
          </div>
          {score > 0 && (
            <>
              <label className="field"><span>Anything to add? (optional)</span><input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></label>
              <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api(`${url}/rate`, { body: { score, comment: comment.trim() } }))}>Send rating</button>
            </>
          )}
        </section>
      )}
      {t.csat && <p className="center muted">You rated this {t.csat}/5. Thank you! 🙏</p>}
      <footer className="help-foot">Keep this link private: anyone who has it can see this ticket · Powered by वार्तालाप</footer>
    </main>
  );
}
