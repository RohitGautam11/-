"use client";

import {
  BarChart3, FileUp, Hourglass, ImagePlus, IndianRupee, Mic, Pencil, Plus, Receipt, Reply as ReplyIcon, Send, X,
} from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { pickRecorderMime, prepareImage } from "@/lib/client/media";
import { previewText, rupees } from "@/lib/client/selectors";
import type { Conversation, Member, Message, Payload } from "@/lib/client/types";
import { useAction, useEngine, usePrefs, useToast } from "./context";
import { Modal, Spinner, useNow } from "./ui";

const MAX_UPLOAD = 4 * 1024 * 1024 - 80 * 1024;

type Props = {
  conv: Conversation;
  replyTo: Message | null;
  editing: Message | null;
  onDone: () => void;
};

export function Composer({ conv, replyTo, editing, onDone }: Props) {
  const engine = useEngine();
  const toast = useToast();
  const [prefs] = usePrefs();
  const draftKey = `vt:draft:${conv.id}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<null | "poll" | "capsule" | "pay" | "request">(null);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState<{ rec: MediaRecorder; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Starting an edit loads that message's text (derived during render, not in an effect).
  const [editingId, setEditingId] = useState<string | null>(null);
  if ((editing?.id ?? null) !== editingId) {
    setEditingId(editing?.id ?? null);
    if (editing?.payload?.t === "text") setText(editing.payload.body);
  }
  const cancelRecording = useRef(false);

  useEffect(() => {
    if (editing || replyTo) area.current?.focus();
  }, [editing, replyTo]);

  useEffect(() => {
    try {
      if (text && !editing) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
  }, [text, draftKey, editing]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((Date.now() - recording.started) / 1000), 250);
    return () => clearInterval(t);
  }, [recording]);

  const reply = replyTo
    ? { id: replyTo.id, senderId: replyTo.senderId, preview: previewText(replyTo, conv, "").replace(/^You: /, "").slice(0, 120) }
    : undefined;

  async function submit() {
    const body = text.trim();
    if (!body) return;
    if (editing) {
      setText("");
      onDone();
      await engine.edit(conv.id, editing.id, { t: "text", body, reply: editing.payload?.t === "text" ? editing.payload.reply : undefined })
        .catch((e: Error) => toast(e.message, "error"));
      return;
    }
    setText("");
    onDone();
    await engine.send(conv.id, { t: "text", body, reply }).catch((e: Error) => toast(e.message, "error"));
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && prefs.enterToSend && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && (editing || replyTo)) {
      setText(editing ? "" : text);
      onDone();
    }
  }

  async function sendFiles(files: FileList | null, asPhoto: boolean) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 10)) {
        let payload: Payload;
        if (asPhoto && file.type.startsWith("image/") && file.type !== "image/gif") {
          const img = await prepareImage(file);
          const ref = await engine.upload(conv.id, img.blob, { name: file.name.replace(/\.\w+$/, ".jpg"), mime: "image/jpeg", width: img.width, height: img.height, thumb: img.thumb });
          payload = { t: "media", kind: "image", blob: ref, caption: files.length === 1 ? text.trim() || undefined : undefined, reply };
        } else {
          if (file.size > MAX_UPLOAD) {
            toast(`${file.name} is larger than 4 MB.`, "error");
            continue;
          }
          const ref = await engine.upload(conv.id, file, { name: file.name, mime: file.type || "application/octet-stream" });
          payload = { t: "media", kind: file.type.startsWith("image/") ? "image" : "file", blob: ref, reply };
        }
        await engine.send(conv.id, payload);
      }
      if (asPhoto && files.length === 1) setText("");
      onDone();
    } catch (e) {
      toast((e as Error).message || "Upload failed", "error");
    } finally {
      setUploading(false);
      if (photoInput.current) photoInput.current.value = "";
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) return toast("Voice notes need microphone access, which this browser doesn't offer.", "error");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const duration = (Date.now() - started) / 1000;
        if (cancelRecording.current || duration < 0.6) return;
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setUploading(true);
        try {
          const ref = await engine.upload(conv.id, blob, { name: `voice-${Date.now()}.${blob.type.includes("mp4") ? "m4a" : "webm"}`, mime: blob.type, duration });
          await engine.send(conv.id, { t: "media", kind: "voice", blob: ref, reply });
          onDone();
        } catch (e) {
          toast((e as Error).message, "error");
        } finally {
          setUploading(false);
        }
      };
      const started = Date.now();
      cancelRecording.current = false;
      rec.start();
      setElapsed(0);
      setRecording({ rec, started });
    } catch {
      toast("Microphone permission was denied.", "error");
    }
  }

  function stopRecording(cancel = false) {
    if (!recording) return;
    cancelRecording.current = cancel;
    recording.rec.stop();
    setRecording(null);
  }

  if (conv.leftAt) return <div className="composer-disabled">You can&apos;t send messages to this group because you&apos;re no longer a member.</div>;

  return (
    <div className="composer-wrap">
      {(replyTo || editing) && (
        <div className="composer-context">
          {editing ? <Pencil size={16} /> : <ReplyIcon size={16} />}
          <div>
            <strong>{editing ? "Editing message" : `Replying to ${replyTo!.senderId === engine.me.id ? "yourself" : conv.members.find((m) => m.id === replyTo!.senderId)?.displayName ?? "message"}`}</strong>
            <span>{previewText(editing ?? replyTo, conv, "").replace(/^You: /, "")}</span>
          </div>
          <button className="icon-btn" onClick={() => { if (editing) setText(""); onDone(); }} aria-label="Cancel"><X size={18} /></button>
        </div>
      )}

      {recording ? (
        <div className="composer recording">
          <button className="icon-btn" onClick={() => stopRecording(true)} aria-label="Cancel recording"><X size={20} /></button>
          <span className="rec-dot" />
          <span className="rec-time">{Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}</span>
          <span className="muted grow">Recording an encrypted voice note…</span>
          <button className="send-btn" onClick={() => stopRecording(false)} aria-label="Send voice note"><Send size={19} /></button>
        </div>
      ) : (
        <div className="composer">
          <div className="attach">
            <button className={`icon-btn${menu ? " active" : ""}`} onClick={() => setMenu(!menu)} aria-label="Attach" aria-expanded={menu} disabled={!!editing}>
              {uploading ? <Spinner /> : <Plus size={22} className={menu ? "rot45" : ""} />}
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="attach-menu" role="menu">
                  <button onClick={() => { setMenu(false); photoInput.current?.click(); }}><span className="am-icon am-photo"><ImagePlus size={18} /></span>Photo</button>
                  <button onClick={() => { setMenu(false); fileInput.current?.click(); }}><span className="am-icon am-file"><FileUp size={18} /></span>File</button>
                  <button onClick={() => { setMenu(false); setDialog("poll"); }}><span className="am-icon am-poll"><BarChart3 size={18} /></span>Poll</button>
                  <button onClick={() => { setMenu(false); setDialog("capsule"); }}><span className="am-icon am-capsule"><Hourglass size={18} /></span>Time capsule</button>
                  <button onClick={() => { setMenu(false); setDialog("pay"); }}><span className="am-icon am-pay"><IndianRupee size={18} /></span>Pay</button>
                  <button onClick={() => { setMenu(false); setDialog("request"); }}><span className="am-icon am-request"><Receipt size={18} /></span>{conv.kind === "group" ? "Split bill" : "Request"}</button>
                </div>
              </>
            )}
          </div>
          <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => void sendFiles(e.target.files, true)} />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void sendFiles(e.target.files, false)} />
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={(e) => {
              const files = e.clipboardData.files;
              if (files.length && files[0].type.startsWith("image/")) {
                e.preventDefault();
                void sendFiles(files, true);
              }
            }}
            placeholder={conv.disappearingSeconds ? "Disappearing message" : "Message"}
            aria-label="Message"
            maxLength={20000}
          />
          {text.trim()
            ? <button className="send-btn" onClick={() => void submit()} aria-label={editing ? "Save edit" : "Send"}><Send size={19} /></button>
            : <button className="send-btn mic" onClick={() => void startRecording()} aria-label="Record voice note" disabled={uploading || !!editing}><Mic size={20} /></button>}
        </div>
      )}

      {dialog === "poll" && <PollDialog conv={conv} onClose={() => setDialog(null)} />}
      {dialog === "capsule" && <CapsuleDialog conv={conv} initial={text} onClose={(sent) => { setDialog(null); if (sent) setText(""); }} />}
      {dialog === "pay" && <PayDialog conv={conv} onClose={() => setDialog(null)} />}
      {dialog === "request" && <RequestDialog conv={conv} onClose={() => setDialog(null)} />}
    </div>
  );
}

function others(conv: Conversation, meId: string): Member[] {
  return conv.members.filter((m) => m.id !== meId && !m.leftAt);
}

function toPaise(value: string) {
  const n = Number(value.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function PollDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const valid = question.trim() && options.filter((o) => o.trim()).length >= 2;
  return (
    <Modal title="Create a poll" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!valid || busy} onClick={() => void run(async () => {
        await engine.send(conv.id, { t: "poll", question: question.trim(), options: options.map((o) => o.trim()).filter(Boolean), multi });
        onClose();
      })}>Send poll</button>
    }>
      <label className="field"><span>Question</span><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Where should we eat?" maxLength={200} /></label>
      <div className="field"><span>Options</span>
        {options.map((o, i) => (
          <div key={i} className="row gap-xs">
            <input className="input grow" value={o} placeholder={`Option ${i + 1}`} maxLength={100} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
            {options.length > 2 && <button className="icon-btn" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove option"><X size={16} /></button>}
          </div>
        ))}
        {options.length < 10 && <button className="link" onClick={() => setOptions([...options, ""])}>+ Add option</button>}
      </div>
      <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Allow multiple answers</label>
    </Modal>
  );
}

function CapsuleDialog({ conv, initial, onClose }: { conv: Conversation; initial: string; onClose: (sent: boolean) => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [text, setText] = useState(initial);
  const presets = [
    { label: "In 1 hour", at: () => new Date(Date.now() + 3600_000) },
    { label: "Tomorrow 9 AM", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { label: "In a week", at: () => new Date(Date.now() + 7 * 86400_000) },
    { label: "In a month", at: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; } },
  ];
  const [when, setWhen] = useState(() => toLocalInput(presets[1].at()));
  const now = useNow(15_000);
  const date = new Date(when);
  const valid = text.trim() && date.getTime() - now > 60_000;
  return (
    <Modal title="⏳ Time capsule" onClose={() => onClose(false)} footer={
      <button className="btn btn-primary btn-block" disabled={!valid || busy} onClick={() => void run(async () => {
        await engine.send(conv.id, { t: "text", body: text.trim() }, { revealAt: date });
        onClose(true);
      }, "Capsule sealed 🔒")}>Seal capsule</button>
    }>
      <p className="muted">Write it now, and it opens later. Until then the server holds only a sealed envelope, and no one else can read it.</p>
      <label className="field"><span>Message</span><textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Happy birthday! Open this when…" maxLength={5000} /></label>
      <div className="presets">{presets.map((p) => <button key={p.label} className="chip" onClick={() => setWhen(toLocalInput(p.at()))}>{p.label}</button>)}</div>
      <label className="field"><span>Opens on</span><input type="datetime-local" value={when} min={toLocalInput(new Date(now + 120_000))} onChange={(e) => setWhen(e.target.value)} /></label>
    </Modal>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PayDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const people = others(conv, engine.me.id);
  const [to, setTo] = useState(people[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const paise = toPaise(amount);
  const valid = to && paise >= 100;
  return (
    <Modal title="Send money" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!valid || busy} onClick={() => void run(async () => {
        await engine.pay(conv.id, to, paise, note.trim());
        onClose();
      }, "Payment sent ✓")}>{busy ? <Spinner /> : valid ? `Pay ${rupees(paise)}` : "Pay"}</button>
    }>
      {people.length > 1 && (
        <label className="field"><span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>
        </label>
      )}
      {people.length === 1 && <p className="muted">To <strong>{people[0].displayName}</strong></p>}
      <div className="amount"><span>₹</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" autoFocus /></div>
      <div className="presets">{[50, 100, 250, 500].map((v) => <button key={v} className="chip" onClick={() => setAmount(String(v))}>₹{v}</button>)}</div>
      <label className="field"><span>Note (end-to-end encrypted)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Chai pe charcha ☕" maxLength={140} /></label>
      <p className="muted small">Test wallet — money is simulated until a payment gateway is connected.</p>
    </Modal>
  );
}

function RequestDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const people = others(conv, engine.me.id);
  const [selected, setSelected] = useState<string[]>(people.map((p) => p.id));
  const [amount, setAmount] = useState("");
  const [includeMe, setIncludeMe] = useState(true);
  const [note, setNote] = useState("");
  const total = toPaise(amount);
  const parts = selected.length + (conv.kind === "group" && includeMe ? 1 : 0);
  const share = parts ? Math.floor(total / parts) : 0;
  const valid = selected.length > 0 && share >= 100;
  const isGroup = conv.kind === "group";
  return (
    <Modal title={isGroup ? "Split a bill" : "Request money"} onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!valid || busy} onClick={() => void run(async () => {
        await engine.requestMoney(conv.id, selected.map((payerId) => ({ payerId, amount: share })), note.trim());
        onClose();
      }, "Request sent")}>{valid ? (isGroup ? `Request ${rupees(share)} each` : `Request ${rupees(share)}`) : "Request"}</button>
    }>
      <div className="amount"><span>₹</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder={isGroup ? "Total bill" : "0"} autoFocus /></div>
      {isGroup && (
        <>
          <label className="check"><input type="checkbox" checked={includeMe} onChange={(e) => setIncludeMe(e.target.checked)} /> Include my share in the split</label>
          <div className="field"><span>Split between</span>
            <div className="split-people">
              {people.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                  {p.displayName}
                </label>
              ))}
            </div>
          </div>
          {valid && <p className="muted small">{parts} people · {rupees(share)} each</p>}
        </>
      )}
      <label className="field"><span>What&apos;s it for? (encrypted)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Dinner at Sharma ji's" maxLength={140} /></label>
    </Modal>
  );
}
