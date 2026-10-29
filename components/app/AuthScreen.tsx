"use client";

import { Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { HttpError } from "@/lib/client/api";
import { login, passwordStrength, register } from "@/lib/client/session";
import type { Me } from "@/lib/client/types";
import { Spinner } from "./ui";

type Props = { onAuthed: (user: Me, identity: CryptoKey) => void; reason?: string; presetUsername?: string };

const STRENGTH = ["Too weak", "Weak", "Okay", "Strong", "Excellent"];

export function AuthScreen({ onAuthed, reason, presetUsername }: Props) {
  const [mode, setMode] = useState<"login" | "register">(presetUsername ? "login" : "register");
  const [username, setUsername] = useState(presetUsername ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(reason ?? "");
  const strength = passwordStrength(password);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const name = username.trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9_.]{3,24}$/.test(name)) return setError("Usernames are 3–24 characters: letters, numbers, dot or underscore.");
    if (mode === "register") {
      if (!displayName.trim()) return setError("Tell people what to call you.");
      if (password.length < 10) return setError("Use at least 10 characters. A short sentence works well.");
      if (strength < 2) return setError("Please choose a stronger password — it protects your encryption key.");
      if (password !== confirm) return setError("The two passwords don't match.");
    }
    setBusy(true);
    try {
      const result = mode === "register"
        ? await register(name, displayName.trim(), password)
        : await login(name, password);
      onAuthed(result.user, result.identity);
    } catch (err) {
      if (err instanceof HttpError) setError(err.message);
      else if (err instanceof DOMException) setError("Could not unlock your encryption key. Check your password.");
      else setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-art" aria-hidden="true">
        <div className="auth-glyph">व</div>
        <div className="auth-orbit"><span /><span /><span /></div>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark">व</span>
          <div>
            <h1>वार्तालाप</h1>
            <p>Talk, pay and share — privately.</p>
          </div>
        </div>

        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
        </div>

        <label className="field">
          <span>Username</span>
          <div className="input-prefix"><b>@</b><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="priya.sharma" required /></div>
        </label>
        {mode === "register" && (
          <label className="field">
            <span>Your name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" placeholder="Priya Sharma" maxLength={48} required />
          </label>
        )}
        <label className="field">
          <span>Password</span>
          <div className="input-suffix">
            <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "A memorable sentence" : "Your password"} required />
            <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
        </label>
        {mode === "register" && (
          <>
            <div className="strength" data-score={strength}><span /><span /><span /><span /><em>{password ? STRENGTH[strength] : "Use 10+ characters"}</em></div>
            <label className="field">
              <span>Confirm password</span>
              <input type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
            <div className="auth-note">
              <KeyRound size={16} />
              <p>Your password also unlocks your encryption keys, and <strong>we never receive it</strong>. If you forget it, no one — not even us — can recover your messages.</p>
            </div>
          </>
        )}

        {error && <div className="form-error" role="alert">{error}</div>}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <><Spinner /> {mode === "register" ? "Creating your keys…" : "Unlocking…"}</> : mode === "register" ? "Create account" : "Sign in"}
        </button>

        <ul className="auth-promises">
          <li><LockKeyhole size={14} /> End-to-end encrypted chats, files & payment notes</li>
          <li><ShieldCheck size={14} /> Keys are generated on your device</li>
        </ul>
      </form>
    </div>
  );
}
