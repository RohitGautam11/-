"use client";

import { Lock, MessageSquarePlus, Search, Timer, Users } from "lucide-react";
import { useState } from "react";
import { lastMessage, listTime, peerOf, previewText, titleOf, unreadCount } from "@/lib/client/selectors";
import type { PublicUser } from "@/lib/client/types";
import { useAction, useEngine } from "./context";
import { PeoplePicker } from "./People";
import { Avatar, Empty, Modal, Spinner, useNow } from "./ui";

type Props = { selectedId: string | null; onSelect: (id: string) => void; onOpenProfile: (username: string) => void };

const GROUP_EMOJI = ["👨‍👩‍👧", "🎉", "🏏", "🎓", "💼", "🏡", "✈️", "🎵", "🍲", "🪔"];

export function ChatList({ selectedId, onSelect }: Props) {
  const engine = useEngine();
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"all" | "unread" | "groups">("all");
  const [creating, setCreating] = useState<null | "direct" | "group">(null);
  const now = useNow();
  const me = engine.me.id;

  const items = [...engine.conversations.values()]
    .map((conv) => {
      const last = lastMessage(conv);
      return { conv, last, title: titleOf(conv, me), unread: unreadCount(conv, me), sortKey: last?.createdAt ?? conv.createdAt };
    })
    .filter((x) => x.title.toLowerCase().includes(filter.trim().toLowerCase()))
    .filter((x) => view === "all" || (view === "unread" ? x.unread > 0 : x.conv.kind === "group"))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return (
    <div className="chatlist">
      <header className="list-head">
        <div>
          <h1>Chats</h1>
          <p className="muted small"><Lock size={11} /> End-to-end encrypted</p>
        </div>
        <div className="row gap-xs">
          <button className="icon-btn soft" onClick={() => setCreating("group")} aria-label="New group" title="New group"><Users size={19} /></button>
          <button className="icon-btn accent" onClick={() => setCreating("direct")} aria-label="New chat" title="New chat"><MessageSquarePlus size={19} /></button>
        </div>
      </header>
      <label className="search">
        <Search size={17} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search chats" />
      </label>
      <div className="filters">
        {(["all", "unread", "groups"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
        ))}
      </div>

      <div className="conv-list">
        {!engine.ready && <div className="center pad"><Spinner /></div>}
        {engine.ready && items.length === 0 && (
          <Empty icon="💬" title={filter || view !== "all" ? "Nothing here" : "No chats yet"}>
            {!filter && view === "all" && <button className="btn btn-primary" onClick={() => setCreating("direct")}>Start a conversation</button>}
          </Empty>
        )}
        {items.map(({ conv, last, title, unread }) => {
          const peer = conv.kind === "direct" ? peerOf(conv, me) : undefined;
          const online = peer?.lastSeenAt ? now - new Date(peer.lastSeenAt).getTime() < 150_000 : false;
          return (
            <button key={conv.id} className={`conv${selectedId === conv.id ? " selected" : ""}${unread ? " has-unread" : ""}`} onClick={() => onSelect(conv.id)}>
              <Avatar name={title} hue={peer?.avatarHue ?? hueFor(conv.id)} emoji={conv.meta?.emoji} group={conv.kind === "group"} online={online} />
              <span className="conv-copy">
                <span className="conv-top">
                  <strong>{title}</strong>
                  <time>{listTime(last?.createdAt ?? conv.createdAt)}</time>
                </span>
                <span className="conv-bottom">
                  <span className="conv-preview">
                    {conv.disappearingSeconds ? <Timer size={13} className="inline-icon" /> : null}
                    {conv.leftAt ? "You left this group" : previewText(last, conv, me)}
                  </span>
                  {unread > 0 && <span className="badge">{unread}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {creating && <NewChat mode={creating} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); onSelect(id); }} />}
    </div>
  );
}

export function hueFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function NewChat({ mode, onClose, onCreated }: { mode: "direct" | "group"; onClose: () => void; onCreated: (id: string) => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(GROUP_EMOJI[0]);

  if (mode === "direct") {
    return (
      <Modal title="New chat" onClose={onClose}>
        <PeoplePicker onPick={(u) => void run(async () => onCreated(await engine.openDirect(u)))} />
        {busy && <p className="muted center pad"><Spinner /> Exchanging keys…</p>}
      </Modal>
    );
  }
  const toggle = (u: PublicUser) => setSelected((s) => (s.some((x) => x.id === u.id) ? s.filter((x) => x.id !== u.id) : [...s, u]));
  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <button className="btn btn-primary btn-block" disabled={busy || !name.trim() || selected.length === 0}
          onClick={() => void run(async () => onCreated(await engine.createGroup({ name: name.trim(), emoji }, selected)))}>
          {busy ? <Spinner /> : `Create group${selected.length ? ` with ${selected.length}` : ""}`}
        </button>
      }
    >
      <div className="group-name-row">
        <div className="emoji-pick">
          {GROUP_EMOJI.map((e) => <button key={e} className={emoji === e ? "on" : ""} onClick={() => setEmoji(e)} aria-label={`Group icon ${e}`}>{e}</button>)}
        </div>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" maxLength={60} />
        <p className="muted small"><Lock size={11} /> The group name is encrypted too — only members can see it.</p>
      </div>
      <PeoplePicker onPick={toggle} selected={selected} exclude={[engine.me.id]} autoFocus={false} />
    </Modal>
  );
}
