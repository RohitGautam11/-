"use client";

import { ArrowDown, ArrowLeft, Info, Lock, Pin, ShieldAlert, Timer } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { lastSeen, peerOf, previewText, relativeDay, timeline, titleOf } from "@/lib/client/selectors";
import type { Message } from "@/lib/client/types";
import { ChatInfo } from "./ChatInfo";
import { hueFor } from "./ChatList";
import { Composer } from "./Composer";
import { useEngine } from "./context";
import { MessageItem } from "./MessageItem";
import { Avatar } from "./ui";

type Props = { conversationId: string; onBack: () => void; onOpenProfile: (username: string) => void };

export function ChatView({ conversationId, onBack, onOpenProfile }: Props) {
  const engine = useEngine();
  const conv = engine.conversations.get(conversationId)!;
  const me = engine.me.id;
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [info, setInfo] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const { items, reactions, votes, pinned } = useMemo(() => timeline(conv), [conv, engine.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const peer = conv.kind === "direct" ? peerOf(conv, me) : undefined;
  const title = titleOf(conv, me);
  const active = conv.members.filter((m) => !m.leftAt);
  const subtitle = peer ? lastSeen(peer.lastSeenAt) || `@${peer.username}` : `${active.length} member${active.length === 1 ? "" : "s"}`;

  // Stick to the bottom as messages arrive, unless the reader scrolled up.
  const lastId = items[items.length - 1]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mineLast = items[items.length - 1]?.senderId === me;
    if (atBottom || mineLast) el.scrollTop = el.scrollHeight;
  }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Expired disappearing messages vanish without waiting for the next sync.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!conv.disappearingSeconds && !items.some((m) => m.expiresAt)) return;
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [conv.disappearingSeconds, items]);

  const jump = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1200);
  };

  return (
    <section className="chat" aria-label={`Conversation with ${title}`}>
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back"><ArrowLeft size={22} /></button>
        <button className="chat-who" onClick={() => (peer ? onOpenProfile(peer.username) : setInfo(true))}>
          <Avatar name={title} hue={peer?.avatarHue ?? hueFor(conv.id)} emoji={conv.meta?.emoji} group={conv.kind === "group"} size={42} online={subtitle === "online"} />
          <span>
            <strong>{title}</strong>
            <small className={subtitle === "online" ? "online" : ""}>{subtitle}</small>
          </span>
        </button>
        <div className="chat-actions">
          {conv.disappearingSeconds ? <span className="pill"><Timer size={13} /> {short(conv.disappearingSeconds)}</span> : null}
          <button className="icon-btn" onClick={() => setInfo(true)} aria-label="Chat info" title="Chat info"><Info size={20} /></button>
        </div>
      </header>

      {conv.keyWarning && (
        <button className="banner warn" onClick={() => setInfo(true)}><ShieldAlert size={16} /> {conv.keyWarning}</button>
      )}
      {conv.needsRotation && !conv.leftAt && <div className="banner"><Lock size={14} /> Securing the group with a fresh key…</div>}
      {pinned && (
        <button className="pinned-bar" onClick={() => jump(pinned.id)}>
          <Pin size={15} />
          <span><strong>Pinned</strong> {previewText(pinned, conv, me)}</span>
        </button>
      )}

      <div className="timeline" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
      }}>
        <div className="e2e-note"><Lock size={12} /> Messages, files, polls and payment notes in this chat are end-to-end encrypted. Only the people in it can read them.</div>
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const first = newDay || !prev || prev.senderId !== m.senderId || prev.kind === "system"
            || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
          return (
            <div key={m.id}>
              {newDay && <div className="day"><span>{relativeDay(m.createdAt)}</span></div>}
              <MessageItem
                conv={conv}
                message={m}
                first={first}
                reactions={reactions.get(m.id)}
                votes={votes.get(m.id)}
                pinned={pinned?.id === m.id}
                onReply={(x) => { setEditing(null); setReplyTo(x); }}
                onEdit={(x) => { setReplyTo(null); setEditing(x); }}
                onJump={jump}
              />
            </div>
          );
        })}
      </div>
      {!atBottom && (
        <button className="to-bottom" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })} aria-label="Scroll to latest">
          <ArrowDown size={18} />
        </button>
      )}

      <Composer conv={conv} replyTo={replyTo} editing={editing} onDone={() => { setReplyTo(null); setEditing(null); }} />
      {info && <ChatInfo conv={conv} onClose={() => setInfo(false)} onOpenProfile={(u) => { setInfo(false); onOpenProfile(u); }} onLeft={onBack} />}
    </section>
  );
}

function short(seconds: number) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 60)}m`;
}
