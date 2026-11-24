"use client";

import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { Me } from "@/lib/client/types";

/**
 * First-run guided tour. Shown once per account (remembered on the server, so it doesn't
 * reappear on a new phone), skippable at any step, and replayable from You → Guided tour.
 */

type Step = { target?: string; title: string; body: string; emoji: string };

const STEPS: Step[] = [
  { emoji: "🙏", title: "Welcome to वार्तालाप", body: "One app for private chats, free calls, payments, and a full call centre and helpdesk for your business. Take a one-minute tour, or skip it. You can replay it any time from the You tab." },
  { target: "tab-chats", emoji: "🔐", title: "Chats, sealed on your device", body: "1:1 and group chats, voice notes, files, polls, time capsules and disappearing messages. Everything is end-to-end encrypted before it leaves your phone." },
  { target: "tab-calls", emoji: "📞", title: "Free HD voice & video calls", body: "Call anyone you chat with, peer-to-peer and encrypted. Screen sharing works on desktop." },
  { target: "tab-business", emoji: "💼", title: "Your call centre in a tab", body: "One business number for the whole team: click-to-call with number masking, a CRM, a power dialer, a shared SMS + WhatsApp inbox, and a Helpdesk where every complaint and missed call becomes a ticket with a deadline." },
  { target: "tab-feed", emoji: "🪔", title: "Vichaar", body: "A calm public feed for thoughts, gratitude and asks for help, with moods instead of algorithms." },
  { target: "tab-wallet", emoji: "💸", title: "Pay & split in chat", body: "Send money with a private note, request it back, or split a bill across a group and watch it settle." },
  { target: "tab-settings", emoji: "🛡️", title: "You stay in control", body: "Privacy Shield, notifications, theme, and every device signed in to your account, with one-tap remote sign-out. Replay this tour from here whenever you like." },
  { emoji: "🚀", title: "You're all set", body: "Start a chat from the Chats tab, or open Business to create a workspace with sample data and see the call centre working in under a minute." },
];

const localKey = (id: string) => `vt:tour-done:${id}`;

export function shouldShowTour(me: Me) {
  if (me.tourDone) return false;
  try {
    return localStorage.getItem(localKey(me.id)) !== "1";
  } catch {
    return true;
  }
}

/** Remembers that the tour was finished or skipped, on this device at once and on the account. */
export function markTourDone(me: Me) {
  me.tourDone = true;
  try {
    localStorage.setItem(localKey(me.id), "1");
  } catch {
    // ignore
  }
  void api("/api/me", { method: "PATCH", body: { tourDone: true } }).catch(() => undefined);
}

export const TOUR_EVENT = "vt-tour";

function findTarget(name?: string) {
  if (!name) return null;
  // The rail (desktop) and the tab bar (phone) both carry the same names; use whichever is on screen.
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  return null;
}

export function Tour({ me, onClose }: { me: Me; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const finish = useCallback(() => {
    markTourDone(me);
    onClose();
  }, [me, onClose]);

  useLayoutEffect(() => {
    const place = () => setRect(findTarget(step.target));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [step.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight") setI((n) => Math.min(STEPS.length - 1, n + 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  // Card goes beside the rail on desktop, above the tab bar on phones, centred when there's no target.
  const pad = 8;
  let cardStyle: React.CSSProperties = {};
  let placement = "center";
  if (rect) {
    const w = Math.min(340, window.innerWidth - 32);
    if (rect.left < 120 && window.innerWidth > 860) {
      placement = "right";
      cardStyle = { left: rect.right + 16, top: Math.max(16, Math.min(window.innerHeight - 260, rect.top - 20)), width: w };
    } else {
      placement = "above";
      const left = Math.max(16, Math.min(window.innerWidth - w - 16, rect.left + rect.width / 2 - w / 2));
      cardStyle = { left, bottom: window.innerHeight - rect.top + 16, width: w };
    }
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect
        ? <div className="tour-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
        : <div className="tour-dim" />}
      <div className={`tour-card tour-${placement}`} style={cardStyle}>
        <button className="icon-btn tour-x" onClick={finish} aria-label="Skip the tour"><X size={18} /></button>
        <div className="tour-emoji" aria-hidden="true">{step.emoji}</div>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div className="tour-dots" aria-label={`Step ${i + 1} of ${STEPS.length}`}>
          {STEPS.map((_, n) => <span key={n} className={n === i ? "on" : ""} />)}
        </div>
        <div className="row between">
          {i === 0
            ? <button className="btn btn-ghost sm" onClick={finish}>Skip tour</button>
            : <button className="btn btn-ghost sm" onClick={() => setI(i - 1)}><ArrowLeft size={15} /> Back</button>}
          {last
            ? <button className="btn btn-primary sm" onClick={finish}>Let&apos;s go</button>
            : <button className="btn btn-primary sm" onClick={() => setI(i + 1)} autoFocus>{i === 0 ? "Show me" : "Next"} <ArrowRight size={15} /></button>}
        </div>
        {i > 0 && !last && <button className="link sm tour-skip" onClick={finish}>Skip the rest</button>}
      </div>
    </div>
  );
}
