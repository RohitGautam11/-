"use client";

import { createContext, useContext } from "react";
import { api } from "@/lib/client/api";

export type Line = {
  id: string; label: string; phoneNumber: string; provider: "simulator" | "twilio" | "exotel"; channels: string[];
  routing: "ring_all" | "round_robin" | "owner_first"; missedCallReply: string | null; recordCalls: boolean; active: boolean;
};
export type Member = {
  userId: string; role: "owner" | "admin" | "agent"; displayName: string; username: string; avatarHue: number;
  availability: "available" | "busy" | "away"; lastSeenAt: string; phone: string | null;
};
export type Task = { id: string; contactId: string | null; contactName: string | null; assigneeId: string | null; assigneeName: string | null; title: string; dueAt: string; doneAt: string | null };
export type CallLog = {
  id: string; lineId: string | null; lineLabel: string | null; contactId: string | null; contactName: string | null; agentId: string | null; agentName: string | null;
  direction: "inbound" | "outbound"; status: string; remoteNumber: string; provider: string; disposition: string | null; notes: string;
  recordingUrl: string | null; durationSec: number; startedAt: string; answeredAt: string | null; endedAt: string | null;
};
export type Contact = {
  id: string; name: string; phone: string; masked: boolean; email: string; company: string; tags: string[]; stage: string; source: string;
  value: number; ownerId: string | null; ownerName: string | null; lastContactedAt: string | null; createdAt: string; updatedAt: string;
};
export type Overview = {
  workspace: { id: string; name: string; industry: string; settings: WsSettings; createdAt: string };
  role: "owner" | "admin" | "agent";
  masked: boolean;
  me: { phone: string | null; availability: string };
  providers: { simulator: boolean; twilio: boolean; exotel: boolean };
  socialWebhook: boolean;
  members: Member[];
  lines: Line[];
  today: { total: number; answered: number; missed: number; talk: number; outbound: number; inbound: number; messages: number };
  pipeline: { stage: string; n: number; value: number }[];
  tasks: Task[];
  recentCalls: CallLog[];
  social: { scheduled: number; due: number };
  helpdesk: { open: number; breached: number; callbacks: number; mine: number };
};

export type WsSettings = {
  maskForAgents?: boolean; businessHours?: string; helpCenter?: boolean; helpIntro?: string; autoAssign?: boolean;
  sla?: Partial<Record<"urgent" | "high" | "normal" | "low", { respond: number; resolve: number }>>;
};

export type BizSection = "home" | "contacts" | "calls" | "helpdesk" | "inbox" | "social" | "team" | "insights";
export type DialTarget = { contactId?: string; number?: string; name: string; phone?: string };

export type BizCtx = {
  ws: string;
  data: Overview;
  reload: () => Promise<void>;
  call: <T = unknown>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  dial: (target: DialTarget) => void;
  /** Power dialer: calls each lead in turn; the next one opens when the previous call is logged. */
  dialQueue: (targets: DialTarget[]) => void;
  queue: { left: number; stop: () => void } | null;
  openContact: (id: string) => void;
  go: (section: BizSection) => void;
  isAdmin: boolean;
  version: number;
};

export const BizContext = createContext<BizCtx | null>(null);
export function useBiz() {
  const ctx = useContext(BizContext);
  if (!ctx) throw new Error("useBiz outside BizContext");
  return ctx;
}

export function bizApi(ws: string) {
  return <T,>(path: string, options: { method?: string; body?: unknown } = {}) => api<T>(`/api/biz/${ws}${path ? `/${path}` : ""}`, options);
}

export function duration(sec: number) {
  if (!sec) return "0s";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export function inr(paise: number, compact = false) {
  const rupees = paise / 100;
  if (compact && rupees >= 1e5) return `₹${(rupees / 1e5).toFixed(rupees >= 1e6 ? 0 : 1)}L`;
  return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Dialling", ringing: "Ringing", "in-progress": "On call", completed: "Answered", "no-answer": "No answer",
  busy: "Busy", failed: "Failed", missed: "Missed", canceled: "Cancelled",
};
