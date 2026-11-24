"use client";

import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Phone, Video, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import type { WireCall } from "@/lib/client/calls";
import { ago } from "@/lib/client/selectors";
import type { PublicUser } from "@/lib/client/types";
import { useCalls } from "./CallLayer";
import { useEngine, useToast } from "./context";
import { Avatar, Empty, Spinner } from "./ui";

type HistoryItem = WireCall & { peer: PublicUser };

export function CallsView() {
  const engine = useEngine();
  const calls = useCalls();
  const toast = useToast();
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [filter, setFilter] = useState<"all" | "missed">("all");
  const [q, setQ] = useState("");

  const load = useCallback(() => api<{ calls: HistoryItem[] }>("/api/calls").then((r) => setHistory(r.calls)).catch(() => setHistory([])), []);
  const busyKey = calls.current?.id ?? "";
  useEffect(() => {
    void load();
  }, [load, busyKey]);

  // People you chat with 1:1 — one tap to call them.
  const contacts = useMemo(() => {
    const out: { peer: PublicUser; conversationId: string }[] = [];
    for (const conv of engine.conversations.values()) {
      if (conv.kind !== "direct" || conv.leftAt) continue;
      const peer = conv.members.find((m) => m.id !== engine.me.id);
      if (peer) out.push({ peer, conversationId: conv.id });
    }
    const needle = q.trim().toLowerCase();
    return out.filter((c) => !needle || c.peer.displayName.toLowerCase().includes(needle) || c.peer.username.includes(needle));
  }, [engine.conversations, engine.me.id, q, engine.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const place = (peer: PublicUser, video: boolean) => {
    const conversationId = engine.findDirect(peer.id)?.id ?? null;
    void calls.startCall(peer, conversationId, video).catch((e: Error) => toast(e.message, "error"));
  };

  const shown = (history ?? []).filter((c) => filter === "all" || (!c.outgoing && (c.status === "missed" || c.status === "declined")));

  return (
    <div className="wallet calls-page">
      <header className="page-head">
        <div><h1>Calls</h1><p className="muted">Free HD voice & video calls, peer-to-peer encrypted.</p></div>
      </header>

      <section className="card-section">
        <h3><Phone size={17} /> Quick call</h3>
        <label className="search" style={{ margin: 0 }}>
          <Search size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people you chat with" />
        </label>
        {contacts.length === 0 && <p className="muted small">Start a 1:1 chat with someone first — then you can call them here or from the chat header.</p>}
        <div className="quick-call-grid">
          {contacts.slice(0, 12).map(({ peer }) => (
            <div key={peer.id} className="quick-call">
              <Avatar name={peer.displayName} hue={peer.avatarHue} size={46} />
              <strong>{peer.displayName.split(" ")[0]}</strong>
              <div className="row">
                <button className="icon-btn soft" onClick={() => place(peer, false)} aria-label={`Voice call ${peer.displayName}`}><Phone size={17} /></button>
                <button className="icon-btn soft" onClick={() => place(peer, true)} aria-label={`Video call ${peer.displayName}`}><Video size={17} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card-section">
        <div className="row between">
          <h3>Recent</h3>
          <div className="segmented sm">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
            <button className={filter === "missed" ? "active" : ""} onClick={() => setFilter("missed")}>Missed</button>
          </div>
        </div>
        {!history && <div className="center pad"><Spinner /></div>}
        {history && shown.length === 0 && <Empty icon="📞" title="No calls yet"><p>Tap a person above, or the phone icon in any 1:1 chat.</p></Empty>}
        {shown.map((c) => {
          const missed = !c.outgoing && (c.status === "missed" || c.status === "declined");
          const secs = c.answeredAt && c.endedAt ? Math.round((new Date(c.endedAt).getTime() - new Date(c.answeredAt).getTime()) / 1000) : 0;
          return (
            <div key={c.id} className="ledger-row">
              <Avatar name={c.peer.displayName} hue={c.peer.avatarHue} size={42} />
              <span className="ledger-copy">
                <strong className={missed ? "text-danger" : ""}>{c.peer.displayName}</strong>
                <small className="row" style={{ gap: 4 }}>
                  {missed ? <PhoneMissed size={13} /> : c.outgoing ? <PhoneOutgoing size={13} /> : <PhoneIncoming size={13} />}
                  {c.video ? "Video" : "Voice"} · {ago(c.createdAt)}{secs ? ` · ${Math.floor(secs / 60)}m ${secs % 60}s` : c.status === "busy" ? " · busy" : ""}
                </small>
              </span>
              <button className="icon-btn soft" onClick={() => place(c.peer, c.video)} aria-label="Call back">{c.video ? <Video size={17} /> : <Phone size={17} />}</button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
