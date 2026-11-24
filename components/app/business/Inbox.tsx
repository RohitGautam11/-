"use client";

import { ArrowLeft, Headset, Search, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ago } from "@/lib/client/selectors";
import { useAction, useToast } from "../context";
import { Avatar, Empty, Spinner } from "../ui";
import { useBiz } from "./shared";

type Thread = {
  contactId: string; contactName: string; contactPhone: string; unanswered: boolean;
  last: { body: string; channel: string; direction: string; createdAt: string };
};
type Msg = { id: string; channel: string; direction: string; body: string; status: string; createdAt: string; agentName: string | null };

/** Unified inbox: every SMS and WhatsApp conversation on the business number(s), shared by the team. */
export function InboxView() {
  const { call, version } = useBiz();
  const toast = useToast();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [open, setOpen] = useState<Thread | null>(null);
  const [q, setQ] = useState("");
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);

  const load = useCallback(() => call<{ threads: Thread[] }>("messages").then((r) => setThreads(r.threads)).catch((e: Error) => toast(e.message, "error")), [call, toast]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 8000);
    return () => clearInterval(t);
  }, [load, version]);

  const shown = (threads ?? []).filter((t) => (!onlyUnanswered || t.unanswered) && (!q.trim() || t.contactName.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div className={`biz-page inbox${open ? " has-open" : ""}`}>
      <section className="card-section inbox-list">
        <label className="search" style={{ margin: 0 }}><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" /></label>
        <div className="filters" style={{ padding: 0 }}>
          <button className={!onlyUnanswered ? "active" : ""} onClick={() => setOnlyUnanswered(false)}>All</button>
          <button className={onlyUnanswered ? "active" : ""} onClick={() => setOnlyUnanswered(true)}>Needs reply</button>
        </div>
        {!threads && <div className="center pad"><Spinner /></div>}
        {threads && shown.length === 0 && <Empty icon="💬" title="Inbox zero"><p>Texts and WhatsApp messages to your business number land here.</p></Empty>}
        {shown.map((t) => (
          <button key={t.contactId} className={`conv${open?.contactId === t.contactId ? " selected" : ""}${t.unanswered ? " has-unread" : ""}`} onClick={() => setOpen(t)}>
            <Avatar name={t.contactName} hue={t.last.channel === "whatsapp" ? 140 : 210} size={42} />
            <span className="conv-copy">
              <span className="conv-top"><strong>{t.contactName}</strong><time>{ago(t.last.createdAt)}</time></span>
              <span className="conv-bottom"><span className="conv-preview">{t.last.channel === "whatsapp" ? "🟢 " : "💬 "}{t.last.direction === "outbound" ? "You: " : ""}{t.last.body}</span>{t.unanswered && <span className="badge">1</span>}</span>
            </span>
          </button>
        ))}
      </section>
      <section className="card-section inbox-thread">
        {open ? <ThreadView key={open.contactId} thread={open} onBack={() => setOpen(null)} onSent={load} /> : <Empty icon="📨" title="Pick a conversation"><p>Reply by SMS or WhatsApp from your business number. Use templates for speed.</p></Empty>}
      </section>
    </div>
  );
}

function ThreadView({ thread, onBack, onSent }: { thread: Thread; onBack: () => void; onSent: () => void }) {
  const { call, openContact, go } = useBiz();
  const [run, busy] = useAction();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const load = useCallback(() => call<{ messages: Msg[] }>(`contacts/${thread.contactId}`).then((r) => setMsgs(r.messages)), [call, thread.contactId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <>
      <header className="row gap-xs thread-head">
        <button className="icon-btn back-inbox" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <button className="grow ledger-copy" onClick={() => openContact(thread.contactId)}>
          <strong>{thread.contactName}</strong><small>{thread.contactPhone} · open lead</small>
        </button>
        <button className="btn btn-ghost sm" disabled={busy} title="Track this conversation as a helpdesk ticket with an SLA" onClick={() => void run(async () => {
          const lastIn = [...(msgs ?? [])].reverse().find((m) => m.direction === "inbound");
          const body = lastIn?.body ?? thread.last.body;
          await call("tickets", { body: { subject: body.slice(0, 80) || `Message from ${thread.contactName}`, description: body, contactId: thread.contactId, channel: thread.last.channel } });
          go("helpdesk");
        }, "Ticket opened")}><Headset size={15} /> Ticket</button>
      </header>
      <div className="thread">
        {!msgs && <div className="center pad"><Spinner /></div>}
        {msgs?.map((m) => (
          <div key={m.id} className={`sms ${m.direction === "outbound" ? "out" : "in"}`}>
            <p>{m.body}</p>
            <small>{m.channel === "whatsapp" ? "WhatsApp" : "SMS"} · {ago(m.createdAt)}{m.direction === "outbound" ? ` · ${m.agentName ?? "auto"} · ${m.status}` : ""}</small>
          </div>
        ))}
      </div>
      <MessageComposer contactId={thread.contactId} contactName={thread.contactName} defaultChannel={thread.last.channel as "sms" | "whatsapp"} onSent={() => {
        void load();
        onSent();
        setTimeout(() => void load(), 5000);
      }} />
    </>
  );
}

export function MessageComposer({ contactId, contactName, defaultChannel = "whatsapp", onSent }: {
  contactId: string; contactName: string; defaultChannel?: "sms" | "whatsapp"; onSent: () => void;
}) {
  const { call, data } = useBiz();
  const [run, busy] = useAction();
  const lines = data.lines.filter((l) => l.active && (l.channels.includes("sms") || l.channels.includes("whatsapp")));
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const line = lines.find((l) => l.id === lineId);
  const [channel, setChannel] = useState<"sms" | "whatsapp">(defaultChannel);
  const [text, setText] = useState("");
  const [templates, setTemplates] = useState<{ id: string; name: string; body: string }[]>([]);
  useEffect(() => {
    void call<{ templates: { id: string; name: string; body: string }[] }>("templates").then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [call]);
  const effective = line && !line.channels.includes(channel) ? (line.channels.includes("sms") ? "sms" : "whatsapp") : channel;

  if (!lines.length) return <p className="muted small">No line has SMS or WhatsApp enabled. Turn it on under Team &amp; lines.</p>;
  return (
    <div className="sms-composer">
      {templates.length > 0 && (
        <div className="chips">
          {templates.map((t) => <button key={t.id} className="chip" onClick={() => setText(t.body.replaceAll("{name}", contactName.split(" ")[0]))}>{t.name}</button>)}
        </div>
      )}
      <div className="row gap-xs">
        <div className="segmented sm">
          {line?.channels.includes("whatsapp") && <button className={effective === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")}>WhatsApp</button>}
          {line?.channels.includes("sms") && <button className={effective === "sms" ? "active" : ""} onClick={() => setChannel("sms")}>SMS</button>}
        </div>
        {lines.length > 1 && (
          <select className="input sm-select" value={lineId} onChange={(e) => setLineId(e.target.value)}>{lines.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
        )}
      </div>
      <div className="sms-input">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${contactName.split(" ")[0]} from ${line?.label ?? "your business number"}…`} maxLength={1600} />
        <button className="icon-btn accent" disabled={busy || !text.trim()} aria-label="Send" onClick={() => void run(async () => {
          await call("messages", { body: { lineId, contactId, channel: effective, body: text.trim() } });
          setText("");
          onSent();
        }, "Sent")}>{busy ? <Spinner size={16} /> : <Send size={18} />}</button>
      </div>
      {effective === "sms" && <small className="muted">{text.length} chars · {Math.max(1, Math.ceil(text.length / 160))} SMS</small>}
    </div>
  );
}
