"use client";

import { Crown, LogOut, Pencil, RefreshCcw, ShieldCheck, Timer, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { peerOf, titleOf } from "@/lib/client/selectors";
import type { Conversation, Member, PublicUser } from "@/lib/client/types";
import { hueFor } from "./ChatList";
import { useAction, useEngine } from "./context";
import { PeoplePicker } from "./People";
import { Avatar, Modal, Spinner } from "./ui";

const TIMERS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "5 minutes", value: 300 },
  { label: "1 hour", value: 3600 },
  { label: "24 hours", value: 86400 },
  { label: "7 days", value: 7 * 86400 },
  { label: "90 days", value: 90 * 86400 },
];

type Props = { conv: Conversation; onClose: () => void; onOpenProfile: (username: string) => void; onLeft: () => void };

export function ChatInfo({ conv, onClose, onOpenProfile, onLeft }: Props) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [adding, setAdding] = useState<PublicUser[] | null>(null);
  const [verify, setVerify] = useState<Member | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(conv.meta?.name ?? "");
  const me = engine.me.id;
  const isGroup = conv.kind === "group";
  const isAdmin = !isGroup || conv.role !== "member";
  const peer = peerOf(conv, me);
  const active = conv.members.filter((m) => !m.leftAt);
  const title = titleOf(conv, me);

  return (
    <Modal title={isGroup ? "Group info" : "Chat info"} onClose={onClose} wide>
      <div className="info-hero">
        <Avatar name={title} hue={peer?.avatarHue ?? hueFor(conv.id)} emoji={conv.meta?.emoji} group={isGroup} size={84} />
        {renaming ? (
          <div className="row gap-xs">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void run(async () => {
              await engine.updateGroupMeta(conv.id, { ...(conv.meta ?? { name: "" }), name: name.trim() });
              setRenaming(false);
            })}>Save</button>
          </div>
        ) : (
          <h3>{title} {isGroup && isAdmin && !conv.leftAt && <button className="icon-btn" onClick={() => setRenaming(true)} aria-label="Rename group"><Pencil size={15} /></button>}</h3>
        )}
        {peer && <button className="link" onClick={() => onOpenProfile(peer.username)}>@{peer.username}</button>}
        {isGroup && <p className="muted">{active.length} members · created {new Date(conv.createdAt).toLocaleDateString()}</p>}
      </div>

      {conv.keyWarning && <div className="banner warn">{conv.keyWarning}</div>}

      <section className="info-section">
        <h4><ShieldCheck size={16} /> Encryption</h4>
        <p className="muted small">
          Messages use AES-256-GCM with a key shared only among members, sealed to each person&apos;s device key (P-256 ECDH).
          The server stores ciphertext only. Current key generation: <b>#{conv.keyEpoch}</b>.
        </p>
        {peer && <button className="btn btn-ghost" onClick={() => setVerify(peer)}><ShieldCheck size={16} /> Verify safety number</button>}
        {isGroup && isAdmin && !conv.leftAt && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => engine.refreshKey(conv.id), "Group key refreshed")}>
            <RefreshCcw size={16} /> Refresh group key
          </button>
        )}
      </section>

      {!conv.leftAt && (
        <section className="info-section">
          <h4><Timer size={16} /> Disappearing messages</h4>
          <p className="muted small">New messages vanish for everyone after the timer — and are erased from the server.</p>
          <div className="presets">
            {TIMERS.map((t) => (
              <button key={t.label} className={`chip${conv.disappearingSeconds === t.value ? " on" : ""}`} disabled={busy || !isAdmin}
                onClick={() => void run(() => engine.setDisappearing(conv.id, t.value))}>{t.label}</button>
            ))}
          </div>
        </section>
      )}

      {isGroup && (
        <section className="info-section">
          <div className="row between">
            <h4>Members</h4>
            {isAdmin && !conv.leftAt && <button className="btn btn-ghost sm" onClick={() => setAdding([])}><UserPlus size={16} /> Add</button>}
          </div>
          <div className="member-list">
            {active.map((m) => (
              <div key={m.id} className="member">
                <button className="member-main" onClick={() => onOpenProfile(m.username)}>
                  <Avatar name={m.displayName} hue={m.avatarHue} size={38} />
                  <span><strong>{m.id === me ? "You" : m.displayName}</strong><small>@{m.username}</small></span>
                </button>
                {m.role !== "member" && <span className={`role role-${m.role}`}>{m.role === "owner" ? <><Crown size={11} /> Owner</> : "Admin"}</span>}
                {m.id !== me && (
                  <div className="member-actions">
                    <button className="icon-btn" onClick={() => setVerify(m)} aria-label={`Verify ${m.displayName}`} title="Verify"><ShieldCheck size={16} /></button>
                    {isAdmin && m.role !== "owner" && !conv.leftAt && (
                      <>
                        <button className="link sm" disabled={busy} onClick={() => void run(() => engine.setRole(conv.id, m.id, m.role === "admin" ? "member" : "admin"))}>
                          {m.role === "admin" ? "Remove admin" : "Make admin"}
                        </button>
                        <button className="icon-btn danger" disabled={busy} aria-label={`Remove ${m.displayName}`} title="Remove"
                          onClick={() => confirm(`Remove ${m.displayName}? The group key will be changed so they can't read new messages.`) && void run(() => engine.removeMember(conv.id, m.id))}>
                          <UserMinus size={16} />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isGroup && !conv.leftAt && (
        <button className="btn btn-danger btn-block" disabled={busy} onClick={() => {
          if (confirm("Leave this group? The remaining members will switch to a new key you won't have.")) {
            void run(async () => {
              await engine.leave(conv.id);
              onClose();
              onLeft();
            });
          }
        }}><LogOut size={16} /> Leave group</button>
      )}

      {adding && (
        <Modal title="Add members" onClose={() => setAdding(null)} footer={
          <button className="btn btn-primary btn-block" disabled={busy || adding.length === 0} onClick={() => void run(async () => {
            await engine.addMembers(conv.id, adding);
            setAdding(null);
          }, "Added — new key shared with everyone")}>{busy ? <Spinner /> : `Add ${adding.length || ""}`}</button>
        }>
          <p className="muted small">New members get a fresh key: they&apos;ll see messages from now on, but not the earlier history.</p>
          <PeoplePicker selected={adding} exclude={active.map((m) => m.id)}
            onPick={(u) => setAdding((s) => (s!.some((x) => x.id === u.id) ? s!.filter((x) => x.id !== u.id) : [...s!, u]))} />
        </Modal>
      )}
      {verify && <SafetyNumber member={verify} onClose={() => setVerify(null)} />}
    </Modal>
  );
}

function SafetyNumber({ member, onClose }: { member: Member; onClose: () => void }) {
  const engine = useEngine();
  const [digits, setDigits] = useState<string[] | null>(null);
  useEffect(() => {
    void engine.safetyNumber(member).then(setDigits);
  }, [engine, member]);
  return (
    <Modal title={`Verify ${member.displayName}`} onClose={onClose} footer={
      <button className="btn btn-primary btn-block" onClick={() => { engine.acceptKey(member); onClose(); }}>Mark as verified</button>
    }>
      <p className="muted">Compare these numbers with {member.displayName.split(" ")[0]} in person or on a call. If they match, nobody is intercepting your conversation.</p>
      <div className="safety">{digits ? digits.map((d, i) => <code key={i}>{d}</code>) : <Spinner />}</div>
    </Modal>
  );
}
