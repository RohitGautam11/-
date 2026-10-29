"use client";
/* eslint-disable @next/next/no-img-element -- attachments are decrypted blob: URLs, which next/image cannot optimise */

import {
  AlertCircle, Check, CheckCheck, Clock, Copy, Download, FileText, Hourglass, Lock, Pencil, Pin, PinOff,
  Reply as ReplyIcon, RotateCcw, SmilePlus, Timer, Trash2, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { bytes, clock, receipt, rupees } from "@/lib/client/selectors";
import type { BlobRef, Conversation, Message, SplitRef, TransferRef } from "@/lib/client/types";
import { useAction, useEngine, useToast } from "./context";
import { Avatar, RichText, Spinner, useNow } from "./ui";

export const QUICK_REACTIONS = ["❤️", "😂", "🙏", "👍", "😮", "🔥"];
const EDIT_WINDOW_MS = 48 * 3600_000;

type Props = {
  conv: Conversation;
  message: Message;
  first: boolean;
  reactions?: Map<string, string[]>;
  votes?: Map<string, number[]>;
  pinned: boolean;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onJump: (id: string) => void;
};

export function MessageItem({ conv, message: m, first, reactions, votes, pinned, onReply, onEdit, onJump }: Props) {
  const engine = useEngine();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const now = useNow(60_000);
  const me = engine.me.id;
  const mine = m.senderId === me;
  const sender = conv.members.find((x) => x.id === m.senderId);

  if (m.kind === "system") return <div className="system-pill">{m.systemText}</div>;

  const p = m.payload;
  const canAct = !m.deletedAt && !m.sealed && m.status !== "undecryptable" && !m.status;
  const canEdit = mine && p?.t === "text" && m.kind === "e2e" && now - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;
  const isAdmin = conv.kind === "group" && conv.role !== "member";
  const canDelete = m.kind === "e2e" && (mine || isAdmin);
  const isCard = m.kind === "payment" || m.kind === "request" || p?.t === "poll";
  const myReaction = reactions ? [...reactions].find(([, users]) => users.includes(me))?.[0] ?? null : null;

  const react = (emoji: string) => {
    setMenu(false);
    void engine.react(conv.id, m.id, myReaction === emoji ? null : emoji).catch((e: Error) => toast(e.message, "error"));
  };

  return (
    <div id={`msg-${m.id}`} className={`msg-row ${mine ? "mine" : "theirs"}${first ? " first" : ""}`}>
      {!mine && conv.kind === "group" && (
        <span className="msg-avatar">{first && sender && <Avatar name={sender.displayName} hue={sender.avatarHue} size={30} />}</span>
      )}
      <div className="msg-stack">
        {first && !mine && conv.kind === "group" && <span className="msg-sender" style={{ ["--hue" as string]: sender?.avatarHue ?? 0 }}>{sender?.displayName ?? "Former member"}</span>}
        <div
          className={`bubble${isCard ? " bubble-card" : ""}${m.deletedAt ? " bubble-deleted" : ""}${m.status === "failed" ? " bubble-failed" : ""}${pinned ? " bubble-pinned" : ""}`}
          onContextMenu={(e) => { if (canAct) { e.preventDefault(); setMenu(true); } }}
          onDoubleClick={() => canAct && react("❤️")}
        >
          {p && "reply" in p && p.reply && (
            <button className="quote" onClick={() => onJump(p.reply!.id)}>
              <strong>{p.reply.senderId === me ? "You" : conv.members.find((x) => x.id === p.reply!.senderId)?.displayName ?? "Someone"}</strong>
              <span>{p.reply.preview}</span>
            </button>
          )}
          <Body conv={conv} m={m} votes={votes} now={now} />
          <span className="meta">
            {pinned && <Pin size={11} />}
            {m.expiresAt && <Timer size={11} aria-label="Disappearing" />}
            {m.revealAt && mine && !m.sealed && <Hourglass size={11} aria-label="Time capsule" />}
            {m.editedAt && !m.deletedAt && <em>edited</em>}
            <time>{clock(m.createdAt)}</time>
            {mine && <Receipt state={receipt(conv, m, me)} />}
          </span>
          {canAct && (
            <button className="msg-more" onClick={() => setMenu(!menu)} aria-label="Message actions"><SmilePlus size={16} /></button>
          )}
        </div>

        {reactions && reactions.size > 0 && (
          <div className="reactions">
            {[...reactions].map(([emoji, users]) => (
              <button key={emoji} className={users.includes(me) ? "on" : ""} onClick={() => react(emoji)}
                title={users.map((u) => conv.members.find((x) => x.id === u)?.displayName ?? "Someone").join(", ")}>
                {emoji}{users.length > 1 && <b>{users.length}</b>}
              </button>
            ))}
          </div>
        )}

        {m.status === "failed" && (
          <div className="failed-row">
            <AlertCircle size={14} /> Not sent
            <button onClick={() => void engine.retry(conv.id, m.id).catch((e: Error) => toast(e.message, "error"))}><RotateCcw size={13} /> Retry</button>
            <button onClick={() => engine.discard(conv.id, m.id)}><X size={13} /> Discard</button>
          </div>
        )}

        {menu && (
          <>
            <div className="menu-scrim" onClick={() => setMenu(false)} />
            <div className="msg-menu" role="menu">
              <div className="menu-reactions">
                {QUICK_REACTIONS.map((e) => <button key={e} className={myReaction === e ? "on" : ""} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}
              </div>
              <button role="menuitem" onClick={() => { setMenu(false); onReply(m); }}><ReplyIcon size={16} /> Reply</button>
              {p?.t === "text" && (
                <button role="menuitem" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(p.body).then(() => toast("Copied")); }}><Copy size={16} /> Copy</button>
              )}
              {canEdit && <button role="menuitem" onClick={() => { setMenu(false); onEdit(m); }}><Pencil size={16} /> Edit</button>}
              <button role="menuitem" onClick={() => { setMenu(false); void engine.pin(conv.id, m.id, !pinned); }}>
                {pinned ? <><PinOff size={16} /> Unpin</> : <><Pin size={16} /> Pin</>}
              </button>
              {canDelete && (
                <button role="menuitem" className="danger" onClick={() => {
                  setMenu(false);
                  if (confirm("Delete this message for everyone? It will be erased from the server.")) {
                    void engine.remove(conv.id, m).catch((e: Error) => toast(e.message, "error"));
                  }
                }}><Trash2 size={16} /> Delete for everyone</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Receipt({ state }: { state: ReturnType<typeof receipt> }) {
  if (state === "sending") return <Clock size={13} className="receipt" aria-label="Sending" />;
  if (state === "failed") return <AlertCircle size={13} className="receipt failed" aria-label="Failed" />;
  if (state === "read") return <CheckCheck size={15} className="receipt read" aria-label="Read" />;
  return <Check size={14} className="receipt" aria-label="Sent" />;
}

function Body({ conv, m, votes, now }: { conv: Conversation; m: Message; votes?: Map<string, number[]>; now: number }) {
  const engine = useEngine();
  if (m.deletedAt) return <span className="text-muted-i">🚫 This message was deleted</span>;
  if (m.sealed) return <Capsule revealAt={m.revealAt!} from={conv.members.find((x) => x.id === m.senderId)?.displayName} />;
  if (m.status === "undecryptable") return <span className="text-muted-i"><Lock size={13} /> This message can&apos;t be decrypted on this device.</span>;
  const p = m.payload;
  if (m.kind === "payment") return <PaymentCard conv={conv} m={m} />;
  if (m.kind === "request") return <SplitCard conv={conv} m={m} />;
  if (!p) return null;
  const capsuleNote = m.revealAt && m.senderId === engine.me.id && new Date(m.revealAt).getTime() > now
    ? <span className="capsule-note"><Hourglass size={12} /> Opens for others {new Date(m.revealAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
    : null;
  switch (p.t) {
    case "text":
      return <>{capsuleNote}<span className={`text${isEmojiOnly(p.body) ? " emoji-only" : ""}`}><RichText text={p.body} /></span></>;
    case "media":
      return (
        <>
          {p.kind === "image" && <ImageAttachment blob={p.blob} />}
          {p.kind === "voice" && <VoiceAttachment blob={p.blob} />}
          {p.kind === "file" && <FileAttachment blob={p.blob} />}
          {p.caption && <span className="text caption"><RichText text={p.caption} /></span>}
        </>
      );
    case "poll":
      return <Poll conv={conv} m={m} votes={votes} />;
    default:
      return null;
  }
}

const isEmojiOnly = (s: string) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,8}$/u.test(s.trim()) && !/\d/.test(s);

function Capsule({ revealAt, from }: { revealAt: string; from?: string }) {
  const now = useNow(1000);
  const left = Math.max(0, new Date(revealAt).getTime() - now);
  const d = Math.floor(left / 86400_000), h = Math.floor(left / 3600_000) % 24, mi = Math.floor(left / 60_000) % 60, s = Math.floor(left / 1000) % 60;
  return (
    <div className="capsule">
      <div className="capsule-seal">⏳</div>
      <div>
        <strong>Time capsule{from ? ` from ${from.split(" ")[0]}` : ""}</strong>
        <span>{left > 0 ? `Opens in ${d ? `${d}d ` : ""}${h}h ${mi}m ${s}s` : "Opening…"}</span>
        <small>{new Date(revealAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>
      </div>
    </div>
  );
}

function useAttachment(blob: BlobRef) {
  const engine = useEngine();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    engine.attachmentUrl(blob).then((u) => live && setUrl(u)).catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [engine, blob]);
  return { url, error };
}

function ImageAttachment({ blob }: { blob: BlobRef }) {
  const { url, error } = useAttachment(blob);
  const [zoom, setZoom] = useState(false);
  const ratio = blob.width && blob.height ? blob.width / blob.height : 4 / 3;
  return (
    <>
      <button className="media" style={{ aspectRatio: String(Math.min(2, Math.max(0.5, ratio))) }} onClick={() => url && setZoom(true)} aria-label="Open photo">
        {blob.thumb && !url && <img src={blob.thumb} alt="" className="media-thumb" />}
        {url && <img src={url} alt={blob.name} />}
        {!url && !error && <span className="media-loading"><Spinner /></span>}
        {error && <span className="media-loading">Photo unavailable</span>}
      </button>
      {zoom && url && (
        <div className="lightbox" onClick={() => setZoom(false)}>
          <img src={url} alt={blob.name} />
          <a className="btn btn-ghost" href={url} download={blob.name} onClick={(e) => e.stopPropagation()}><Download size={16} /> Save</a>
        </div>
      )}
    </>
  );
}

function VoiceAttachment({ blob }: { blob: BlobRef }) {
  const { url } = useAttachment(blob);
  return (
    <div className="voice">
      <span className="voice-icon">🎙️</span>
      {url ? <audio controls preload="metadata" src={url} /> : <Spinner />}
      {blob.duration ? <small>{Math.round(blob.duration)}s</small> : null}
    </div>
  );
}

function FileAttachment({ blob }: { blob: BlobRef }) {
  const { url, error } = useAttachment(blob);
  return (
    <div className="file">
      <span className="file-icon"><FileText size={22} /></span>
      <span className="file-copy"><strong>{blob.name}</strong><small>{bytes(blob.size)} · encrypted</small></span>
      {url ? <a className="icon-btn soft" href={url} download={blob.name} aria-label="Download"><Download size={18} /></a> : error ? <AlertCircle size={18} /> : <Spinner />}
    </div>
  );
}

function Poll({ conv, m, votes }: { conv: Conversation; m: Message; votes?: Map<string, number[]> }) {
  const engine = useEngine();
  const toast = useToast();
  if (m.payload?.t !== "poll") return null;
  const poll = m.payload;
  const mine = votes?.get(engine.me.id) ?? [];
  const counts = poll.options.map((_, i) => [...(votes?.values() ?? [])].filter((c) => c.includes(i)).length);
  const voters = votes ? [...votes.values()].filter((c) => c.length).length : 0;
  const choose = (i: number) => {
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    void engine.vote(conv.id, m.id, next).catch((e: Error) => toast(e.message, "error"));
  };
  return (
    <div className="poll">
      <strong className="poll-q">📊 {poll.question}</strong>
      <small className="muted">{poll.multi ? "Choose any" : "Choose one"} · {voters} vote{voters === 1 ? "" : "s"}</small>
      {poll.options.map((opt, i) => {
        const pct = voters ? Math.round((counts[i] / voters) * 100) : 0;
        return (
          <button key={i} className={`poll-opt${mine.includes(i) ? " on" : ""}`} onClick={() => choose(i)}>
            <span className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-label">{mine.includes(i) && <Check size={14} />} {opt}</span>
            <span className="poll-pct">{pct}%</span>
          </button>
        );
      })}
    </div>
  );
}

function PaymentCard({ conv, m }: { conv: Conversation; m: Message }) {
  const ref = m.ref as TransferRef | null;
  const note = m.payload?.t === "payment" ? m.payload.note : undefined;
  const name = (id?: string) => conv.members.find((x) => x.id === id)?.displayName.split(" ")[0] ?? "Someone";
  return (
    <div className="paycard">
      <div className="paycard-top"><span>💸 Payment</span><span className="chip-ok"><Check size={12} /> Completed</span></div>
      <div className="paycard-amount">{ref ? rupees(ref.amount) : "—"}</div>
      <div className="paycard-who">{ref ? `${name(ref.fromId)} → ${name(ref.toId)}` : ""}</div>
      {note && <div className="paycard-note">“{note}”</div>}
      <div className="paycard-foot"><Lock size={11} /> Note is end-to-end encrypted</div>
    </div>
  );
}

function SplitCard({ conv, m }: { conv: Conversation; m: Message }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const ref = m.ref as SplitRef | null;
  const note = m.payload?.t === "request" ? m.payload.note : undefined;
  if (!ref) return null;
  const me = engine.me.id;
  const total = ref.items.reduce((s, i) => s + i.amount, 0);
  const paid = ref.items.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0);
  const mineItem = ref.items.find((i) => i.payerId === me && i.status === "pending");
  const name = (id: string) => (id === me ? "You" : conv.members.find((x) => x.id === id)?.displayName.split(" ")[0] ?? "Someone");
  return (
    <div className="paycard request">
      <div className="paycard-top"><span>🧾 {ref.items.length > 1 ? "Split bill" : "Payment request"}</span><span className="muted small">by {name(ref.requesterId)}</span></div>
      {note && <div className="paycard-note">“{note}”</div>}
      <div className="split-progress"><span style={{ width: `${total ? (paid / total) * 100 : 0}%` }} /></div>
      <div className="paycard-who">{rupees(paid)} of {rupees(total)} collected</div>
      <ul className="split-items">
        {ref.items.map((i) => (
          <li key={i.id}>
            <span>{name(i.payerId)}</span>
            <span>{rupees(i.amount)}</span>
            <span className={`status status-${i.status}`}>{i.status}</span>
            {ref.requesterId === me && i.status === "pending" && (
              <button className="link" disabled={busy} onClick={() => void run(() => engine.resolveRequest(i.id, "cancel"))}>Cancel</button>
            )}
          </li>
        ))}
      </ul>
      {mineItem && (
        <div className="row gap-xs">
          <button className="btn btn-primary grow" disabled={busy} onClick={() => void run(() => engine.resolveRequest(mineItem.id, "pay"), "Paid ✓")}>
            {busy ? <Spinner /> : `Pay ${rupees(mineItem.amount)}`}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => engine.resolveRequest(mineItem.id, "decline"))}>Decline</button>
        </div>
      )}
    </div>
  );
}
