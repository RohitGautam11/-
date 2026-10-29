"use client";

import { Bell, Download, KeyRound, LogOut, Moon, Palette, ShieldCheck, Sun, SunMoon, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { keyFingerprint } from "@/lib/crypto";
import { api } from "@/lib/client/api";
import { changePassword, passwordStrength } from "@/lib/client/session";
import type { Me } from "@/lib/client/types";
import { useAction, useEngine, usePrefs, type Prefs } from "./context";
import { Avatar, Modal, Toggle } from "./ui";

const ACCENTS: { id: Prefs["accent"]; label: string }[] = [
  { id: "saffron", label: "Kesariya" },
  { id: "peacock", label: "Mor" },
  { id: "lotus", label: "Kamal" },
  { id: "indigo", label: "Neel" },
  { id: "emerald", label: "Panna" },
];

export function SettingsView({ onSignOut, onOpenProfile }: { onSignOut: () => void; onOpenProfile: (username: string) => void }) {
  const engine = useEngine();
  const [prefs, setPrefs] = usePrefs();
  const [run, busy] = useAction();
  const me = engine.me;
  const [name, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [hue, setHue] = useState(me.avatarHue);
  const [fingerprint, setFingerprint] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [notifPerm, setNotifPerm] = useState<string>(() => ("Notification" in globalThis ? Notification.permission : "unsupported"));

  useEffect(() => {
    void keyFingerprint(me.publicKey).then(setFingerprint);
  }, [me.publicKey]);

  const dirty = name.trim() !== me.displayName || bio.trim() !== me.bio || hue !== me.avatarHue;

  return (
    <div className="settings">
      <header className="page-head"><div><h1>You</h1><p className="muted">Profile, privacy and how वार्तालाप looks on this device.</p></div></header>

      <section className="card-section">
        <h3><UserRound size={17} /> Profile</h3>
        <div className="profile-edit">
          <Avatar name={name || me.displayName} hue={hue} size={76} />
          <div className="grow">
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} /></label>
            <label className="field"><span>Bio</span><input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={160} placeholder="A line about you" /></label>
            <label className="field"><span>Avatar colour</span><input type="range" min={0} max={359} value={hue} onChange={(e) => setHue(Number(e.target.value))} className="hue-range" /></label>
          </div>
        </div>
        <div className="row gap-xs">
          <button className="btn btn-primary" disabled={!dirty || busy || !name.trim()} onClick={() => void run(async () => {
            const res = await api<{ user: Me }>("/api/me", { method: "PATCH", body: { displayName: name.trim(), bio: bio.trim(), avatarHue: hue } });
            Object.assign(engine.me, res.user);
          }, "Profile saved")}>Save profile</button>
          <button className="btn btn-ghost" onClick={() => onOpenProfile(me.username)}>View public profile</button>
        </div>
        <p className="muted small">You are <b>@{me.username}</b>. Share it so friends can find you.</p>
      </section>

      <section className="card-section">
        <h3><Palette size={17} /> Appearance</h3>
        <div className="setting">
          <span>Theme</span>
          <div className="segmented sm">
            {([["light", Sun], ["dark", Moon], ["system", SunMoon]] as const).map(([id, Icon]) => (
              <button key={id} className={prefs.theme === id ? "active" : ""} onClick={() => setPrefs({ theme: id })}><Icon size={14} /> {id[0].toUpperCase() + id.slice(1)}</button>
            ))}
          </div>
        </div>
        <div className="setting">
          <span>Accent</span>
          <div className="accents">
            {ACCENTS.map((a) => (
              <button key={a.id} data-swatch={a.id} className={prefs.accent === a.id ? "on" : ""} onClick={() => setPrefs({ accent: a.id })} title={a.label} aria-label={a.label} />
            ))}
          </div>
        </div>
        <div className="setting"><span>Enter sends the message<small>Shift + Enter for a new line</small></span><Toggle label="Enter to send" checked={prefs.enterToSend} onChange={(v) => setPrefs({ enterToSend: v })} /></div>
      </section>

      <section className="card-section">
        <h3><ShieldCheck size={17} /> Privacy & security</h3>
        <div className="setting">
          <span>Privacy Shield<small>Blur the app instantly when you switch away or someone glances over.</small></span>
          <Toggle label="Privacy Shield" checked={prefs.shield} onChange={(v) => setPrefs({ shield: v })} />
        </div>
        <div className="setting">
          <span>Message previews in notifications<small>Decrypted on your device only.</small></span>
          <Toggle label="Previews" checked={prefs.previews} onChange={(v) => setPrefs({ previews: v })} />
        </div>
        <div className="setting">
          <span><Bell size={14} /> Notifications<small>{notifPerm === "granted" ? "Allowed while the app is open in the background." : notifPerm === "denied" ? "Blocked in browser settings." : "Get alerted about new messages."}</small></span>
          {notifPerm === "granted"
            ? <Toggle label="Notifications" checked={prefs.notify} onChange={(v) => setPrefs({ notify: v })} />
            : notifPerm !== "denied" && "Notification" in globalThis && (
              <button className="btn btn-ghost sm" onClick={() => void Notification.requestPermission().then(setNotifPerm)}>Allow</button>
            )}
        </div>
        <div className="setting">
          <span>Your key fingerprint<small><code className="fp">{fingerprint.match(/.{1,4}/g)?.join(" ")}</code></small></span>
        </div>
        <button className="btn btn-ghost" onClick={() => setPwOpen(true)}><KeyRound size={16} /> Change password</button>
      </section>

      <section className="card-section">
        <h3><Download size={17} /> Get the app</h3>
        <p className="muted small">Install वार्तालाप on Android, iPhone or desktop from the download page.</p>
        <Link className="btn btn-ghost" href="/#download">Open download page</Link>
      </section>

      <button className="btn btn-danger btn-block" onClick={onSignOut}><LogOut size={16} /> Sign out of this device</button>
      <p className="muted small center">Signing out removes your keys from this device. You&apos;ll need your password to sign in again.</p>

      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const ok = current && next.length >= 10 && passwordStrength(next) >= 2 && next === confirm;
  return (
    <Modal title="Change password" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!ok || busy} onClick={() => void run(async () => {
        await changePassword(engine.me, current, next);
        onClose();
      }, "Password changed. Other devices were signed out.")}>Change password</button>
    }>
      <p className="muted small">Your encryption key is re-sealed with the new password on this device. Other devices are signed out.</p>
      <label className="field"><span>Current password</span><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
      <label className="field"><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
      <label className="field"><span>Confirm new password</span><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
    </Modal>
  );
}
