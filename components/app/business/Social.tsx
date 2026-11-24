"use client";

import { CalendarClock, Copy, ExternalLink, Plus, Send, Trash2, Webhook, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cleanHandle, SOCIAL_PLATFORMS, type SocialPlatform } from "@/lib/biz-shared";
import { api } from "@/lib/client/api";
import { ago } from "@/lib/client/selectors";
import { useAction, useToast } from "../context";
import { Empty, Spinner, useNow } from "../ui";
import { useBiz } from "./shared";

type Account = { id: string; platform: SocialPlatform; handle: string; profileUrl: string };
type Post = {
  id: string; body: string; platforms: SocialPlatform[]; link: string; status: "draft" | "scheduled" | "sending" | "published" | "failed";
  scheduledAt: string | null; publishedAt: string | null; error: string | null; createdAt: string; author: string | null;
};

const P = (id: string) => SOCIAL_PLATFORMS.find((p) => p.id === id)!;

export function SocialHub() {
  const { call, isAdmin } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const [data, setData] = useState<{ webhook: boolean; accounts: Account[]; posts: Post[] } | null>(null);
  const load = useCallback(() => call<{ webhook: boolean; accounts: Account[]; posts: Post[] }>("social").then(setData).catch((e: Error) => toast(e.message, "error")), [call, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  // Add-a-handle
  const [platform, setPlatform] = useState<SocialPlatform>("instagram");
  const [handle, setHandle] = useState("");
  const preview = cleanHandle(handle);

  if (!data) return <div className="center pad"><Spinner /></div>;

  return (
    <div className="biz-page social">
      <section className="card-section">
        <h3>Your handles</h3>
        <div className="handles">
          {data.accounts.length === 0 && <p className="muted small">No handles yet. Add your brand&apos;s pages below — they&apos;re listed here for the whole team.</p>}
          {data.accounts.map((a) => (
            <span key={a.id} className="handle-chip" style={{ ["--brand" as string]: P(a.platform).color }}>
              <i />{P(a.platform).name}
              <a href={a.profileUrl} target="_blank" rel="noopener noreferrer">@{a.handle}</a>
              {isAdmin && <button aria-label={`Remove ${a.handle}`} onClick={() => void run(async () => {
                await call(`social/accounts/${a.id}`, { method: "DELETE" });
                await load();
              })}><X size={13} /></button>}
            </span>
          ))}
        </div>
        {isAdmin && (
          <div className="add-handle">
            <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as SocialPlatform)}>
              {SOCIAL_PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="input grow" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@yourbrand or paste the profile link" />
            <button className="btn btn-primary sm" disabled={busy || !preview} onClick={() => void run(async () => {
              await call("social/accounts", { body: { platform, handle } });
              setHandle("");
              await load();
            }, "Handle added")}><Plus size={16} /> Add</button>
          </div>
        )}
        {isAdmin && preview && (
          <p className="muted small">Will link to <a href={P(platform).profile(preview)} target="_blank" rel="noopener noreferrer">{P(platform).profile(preview)} <ExternalLink size={11} /></a> — open it to check it&apos;s the right page.</p>
        )}
      </section>

      <Composer accounts={data.accounts} webhook={data.webhook} onSaved={load} />

      <section className="card-section">
        <h3><CalendarClock size={17} /> Content calendar</h3>
        {data.posts.length === 0 && <Empty icon="🗓️" title="Nothing planned"><p>Write a post above and schedule it.</p></Empty>}
        {data.posts.map((p) => <PostRow key={p.id} post={p} webhook={data.webhook} onChanged={load} />)}
      </section>

      {!data.webhook && (
        <p className="muted small social-note"><Webhook size={13} /> Auto-publishing is off. Posts open each network&apos;s share screen for one-tap posting. To post automatically at the scheduled time, connect a Zapier / Make / n8n / Buffer webhook (<code>SOCIAL_WEBHOOK_URL</code> — see README).</p>
      )}
    </div>
  );
}

function Composer({ accounts, webhook, onSaved }: { accounts: Account[]; webhook: boolean; onSaved: () => void }) {
  const { call } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const connected = [...new Set(accounts.map((a) => a.platform))];
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([]);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [when, setWhen] = useState("");
  const [vichaar, setVichaar] = useState(false);
  const chosen = platforms.length ? platforms : connected.slice(0, 3);
  const over = chosen.filter((id) => text.length > P(id).max);

  const toggle = (id: SocialPlatform) => setPlatforms((cur) => {
    const base = cur.length ? cur : chosen;
    return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
  });

  const submit = (mode: "now" | "schedule" | "draft") => void run(async () => {
    if (!chosen.length) throw new Error("Pick at least one platform.");
    const res = await call<{ id: string; delivered: "webhook" | "manual" | null }>("social/posts", {
      body: { body: text.trim(), platforms: chosen, link: link.trim(), publishNow: mode === "now", scheduledAt: mode === "schedule" && when ? new Date(when).toISOString() : null },
    });
    if (vichaar) await api("/api/posts", { body: { body: (link.trim() ? `${text.trim()}\n${link.trim()}` : text.trim()).slice(0, 2000), mood: "idea" } }).catch(() => undefined);
    if (res.delivered === "manual") openShares(chosen, text.trim(), link.trim(), toast);
    setText("");
    setLink("");
    setWhen("");
    onSaved();
  }, mode === "now" ? (webhook ? "Published ✓" : "Opening share screens…") : mode === "schedule" ? "Scheduled ✓" : "Draft saved");

  return (
    <section className="card-section">
      <h3>Create a post</h3>
      <div className="chips">
        {SOCIAL_PLATFORMS.map((p) => (
          <button key={p.id} className={`chip${chosen.includes(p.id) ? " on" : ""}`} onClick={() => toggle(p.id)}>
            <i className="brand-dot" style={{ background: p.color }} />{p.name}
          </button>
        ))}
      </div>
      <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write once — post everywhere. Offers, new packages, testimonials…" maxLength={5000} />
      <div className="char-counts">
        {chosen.map((id) => <span key={id} className={text.length > P(id).max ? "over" : ""}>{P(id).name} {text.length}/{P(id).max}</span>)}
      </div>
      <div className="two-col">
        <label className="field"><span>Link (optional)</span><input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" /></label>
        <label className="field"><span>Schedule for</span><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={vichaar} onChange={(e) => setVichaar(e.target.checked)} /> Also share on Vichaar (your public feed in this app)</label>
      <div className="row gap-xs">
        <button className="btn btn-primary" disabled={busy || !text.trim() || over.length > 0} onClick={() => submit("now")}><Send size={16} /> Publish now</button>
        <button className="btn btn-ghost" disabled={busy || !text.trim() || !when || over.length > 0} onClick={() => submit("schedule")}><CalendarClock size={16} /> Schedule</button>
        <button className="btn btn-ghost" disabled={busy || !text.trim()} onClick={() => submit("draft")}>Save draft</button>
      </div>
      {over.length > 0 && <p className="form-error">Too long for {over.map((id) => P(id).name).join(", ")}.</p>}
    </section>
  );
}

function openShares(platforms: SocialPlatform[], text: string, link: string, toast: (t: string, tone?: "info" | "error" | "success") => void) {
  let blocked = false;
  const noShare: string[] = [];
  for (const id of platforms) {
    const share = P(id).share;
    if (!share) {
      noShare.push(P(id).name);
      continue;
    }
    // "noopener" in the features string makes window.open return null, so detach the opener by hand.
    const w = window.open(share(text, link), "_blank");
    if (w) w.opener = null;
    else blocked = true;
  }
  if (noShare.length) {
    void navigator.clipboard?.writeText(link ? `${text}\n${link}` : text).catch(() => undefined);
    toast(`Text copied — paste it in the ${noShare.join(" / ")} app.`, "info");
  }
  if (blocked) toast("Your browser blocked some pop-ups — use the share buttons on the post.", "error");
}

function PostRow({ post, webhook, onChanged }: { post: Post; webhook: boolean; onChanged: () => void }) {
  const { call } = useBiz();
  const toast = useToast();
  const [run, busy] = useAction();
  const now = useNow(60_000);
  const due = post.status === "scheduled" && post.scheduledAt && new Date(post.scheduledAt).getTime() <= now;
  return (
    <div className={`post-row status-${post.status}`}>
      <div className="row between">
        <div className="row gap-xs">
          {post.platforms.map((id) => <span key={id} className="brand-pill" style={{ ["--brand" as string]: P(id).color }}>{P(id).name}</span>)}
        </div>
        <span className={`status status-${post.status === "published" ? "paid" : post.status === "failed" ? "declined" : "pending"}`}>
          {due ? "due now" : post.status}
        </span>
      </div>
      <p className="post-text">{post.body}</p>
      {post.link && <a className="small" href={post.link} target="_blank" rel="noopener noreferrer">{post.link}</a>}
      <small className="muted">
        {post.status === "published" ? `Published ${ago(post.publishedAt ?? post.scheduledAt ?? post.createdAt)}`
          : post.scheduledAt ? `Scheduled for ${new Date(post.scheduledAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : `Draft · ${ago(post.createdAt)}`}
        {post.author ? ` · by ${post.author}` : ""}{post.error ? ` · ${post.error}` : ""}
      </small>
      <div className="row gap-xs post-actions">
        {post.status !== "published" && (
          <>
            {post.platforms.map((id) => P(id).share && (
              <a key={id} className="btn btn-ghost sm" href={P(id).share!(post.body, post.link)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {P(id).name}</a>
            ))}
            <button className="btn btn-ghost sm" onClick={() => void navigator.clipboard?.writeText(post.link ? `${post.body}\n${post.link}` : post.body).then(() => toast("Copied", "success"))}><Copy size={14} /> Copy</button>
            {post.status === "failed" && webhook && <button className="btn btn-ghost sm" disabled={busy} onClick={() => void run(async () => {
              await call(`social/posts/${post.id}`, { method: "PATCH", body: { action: "retry" } });
              onChanged();
            }, "Published ✓")}>Retry</button>}
            <button className="btn btn-primary sm" disabled={busy} onClick={() => void run(async () => {
              await call(`social/posts/${post.id}`, { method: "PATCH", body: { action: "published" } });
              onChanged();
            })}>Mark published</button>
          </>
        )}
        <button className="icon-btn danger" aria-label="Delete post" disabled={busy} onClick={() => void run(async () => {
          await call(`social/posts/${post.id}`, { method: "DELETE" });
          onChanged();
        })}><Trash2 size={15} /></button>
      </div>
    </div>
  );
}
