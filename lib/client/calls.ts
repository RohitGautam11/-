import { api, HttpError } from "./api";
import type { PublicUser } from "./types";

export type WireCall = {
  id: string;
  conversationId: string | null;
  callerId: string;
  calleeId: string;
  peerId: string;
  outgoing: boolean;
  video: boolean;
  status: "ringing" | "active" | "ended" | "declined" | "missed" | "busy";
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
};

type Signal = { id: number; callId: string; type: "offer" | "answer" | "ice" | "renegotiate"; payload: string };
type PollResponse = { calls: WireCall[]; peers: PublicUser[]; signals: Signal[]; cursor: number };

export type ActiveCall = {
  id: string;
  peer: PublicUser;
  video: boolean;
  outgoing: boolean;
  conversationId: string | null;
  phase: "ringing" | "connecting" | "active" | "ended";
  connectedAt: number | null;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  local: MediaStream | null;
  remote: MediaStream | null;
  endedReason: string | null;
};

export type IncomingCall = { call: WireCall; peer: PublicUser };

/**
 * Runs 1:1 WebRTC calls. Signalling goes through /api/calls (short polling, so it works on
 * serverless hosting without WebSockets); media is peer-to-peer and DTLS-SRTP encrypted.
 */
export class CallManager {
  current: ActiveCall | null = null;
  incoming: IncomingCall | null = null;
  version = 0;

  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private cursor = 0;
  private primed = false;
  private pc: RTCPeerConnection | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private pending = new Map<string, Signal[]>();
  private remoteReady = false;
  private queuedIce: RTCIceCandidateInit[] = [];
  private seenIncoming = new Set<string>();
  private ringer: Ringer | null = null;
  private cameraTrack: MediaStreamTrack | null = null;

  constructor(private meId: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.current) void this.hangup();
    this.stopRing();
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") void this.poll();
  };

  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const hidden = document.visibilityState === "hidden";
    const delay = this.current && this.current.phase !== "ended" ? 800 : this.incoming ? 1500 : hidden ? 12_000 : 3000;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private polling = false;
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await api<PollResponse>(`/api/calls/poll?after=${this.cursor}`);
      const firstRound = !this.primed;
      this.primed = true;
      this.cursor = res.cursor;
      const peers = new Map(res.peers.map((p) => [p.id, p]));
      const live = new Map(res.calls.map((c) => [c.id, c]));

      for (const s of res.signals) {
        if (!live.has(s.callId) && firstRound) continue; // leftovers from old calls
        if (this.current?.id === s.callId && this.pc) await this.handleSignal(s);
        else this.pending.set(s.callId, [...(this.pending.get(s.callId) ?? []), s]);
      }

      // Incoming ring.
      const ringing = res.calls.find((c) => !c.outgoing && c.status === "ringing" && !this.seenIncoming.has(c.id));
      if (ringing && !this.current && !this.incoming) {
        const peer = peers.get(ringing.peerId);
        if (peer) {
          this.incoming = { call: ringing, peer };
          this.startRing("incoming");
          this.notify(peer, ringing.video);
          this.emit();
        }
      }
      if (this.incoming) {
        const now = live.get(this.incoming.call.id);
        if (!now || now.status !== "ringing") {
          this.seenIncoming.add(this.incoming.call.id);
          this.incoming = null;
          this.stopRing();
          this.emit();
        }
      }

      // State of the call we're in.
      if (this.current && this.current.phase !== "ended") {
        const now = live.get(this.current.id);
        if (now && this.current.outgoing && now.status === "active" && this.current.phase === "ringing") {
          this.current.phase = "connecting";
          this.stopRing();
          this.emit();
        }
        if (!now || ["ended", "declined", "missed", "busy"].includes(now.status)) {
          const reason = !now || now.status === "ended" ? "Call ended" : now.status === "declined" ? "Call declined" : now.status === "busy" ? "Busy on another call" : "No answer";
          this.teardown(reason);
        }
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) this.stopped = true;
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private notify(peer: PublicUser, video: boolean) {
    if (document.visibilityState !== "hidden" || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const n = new Notification(`Incoming ${video ? "video" : "voice"} call`, { body: peer.displayName, tag: "vt-call", icon: "/icons/192", requireInteraction: true });
      n.onclick = () => window.focus();
    } catch {
      // ignore
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────
  async startCall(peer: PublicUser, conversationId: string | null, video: boolean) {
    if (this.current && this.current.phase !== "ended") throw new Error("You're already on a call.");
    const local = await getMedia(video);
    let call: WireCall;
    try {
      call = (await api<{ call: WireCall }>("/api/calls", { body: { calleeId: peer.id, conversationId, video } })).call;
    } catch (error) {
      local.getTracks().forEach((t) => t.stop());
      throw error;
    }
    this.current = blank(call, peer, local, "ringing");
    this.cameraTrack = local.getVideoTracks()[0] ?? null;
    await this.createPeer(call.id);
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    await this.signal("offer", JSON.stringify(offer));
    this.startRing("outgoing");
    this.emit();
    void this.poll();
  }

  async accept() {
    const inc = this.incoming;
    if (!inc) return;
    this.stopRing();
    this.incoming = null;
    this.seenIncoming.add(inc.call.id);
    let local: MediaStream;
    try {
      local = await getMedia(inc.call.video);
    } catch (error) {
      await api(`/api/calls/${inc.call.id}/decline`, { body: {} }).catch(() => undefined);
      this.emit();
      throw error;
    }
    await api(`/api/calls/${inc.call.id}/answer`, { body: {} });
    this.current = blank(inc.call, inc.peer, local, "connecting");
    this.cameraTrack = local.getVideoTracks()[0] ?? null;
    await this.createPeer(inc.call.id);
    for (const s of this.pending.get(inc.call.id) ?? []) await this.handleSignal(s);
    this.pending.delete(inc.call.id);
    this.emit();
    void this.poll();
  }

  async decline() {
    const inc = this.incoming;
    if (!inc) return;
    this.incoming = null;
    this.seenIncoming.add(inc.call.id);
    this.stopRing();
    this.emit();
    await api(`/api/calls/${inc.call.id}/decline`, { body: {} }).catch(() => undefined);
  }

  async hangup() {
    const call = this.current;
    if (!call) return;
    this.teardown(null);
    await api(`/api/calls/${call.id}/end`, { body: {} }).catch(() => undefined);
  }

  dismiss() {
    if (this.current?.phase === "ended") {
      this.current = null;
      this.emit();
    }
  }

  toggleMute() {
    const c = this.current;
    if (!c?.local) return;
    c.muted = !c.muted;
    c.local.getAudioTracks().forEach((t) => (t.enabled = !c.muted));
    this.emit();
  }

  toggleCamera() {
    const c = this.current;
    if (!c?.local) return;
    c.cameraOff = !c.cameraOff;
    c.local.getVideoTracks().forEach((t) => (t.enabled = !c.cameraOff));
    this.emit();
  }

  /** Swaps the outgoing camera track for a screen capture (and back). */
  async toggleScreenShare() {
    const c = this.current;
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    if (!c || !sender || !navigator.mediaDevices?.getDisplayMedia) return;
    if (c.sharing) {
      sender.track?.stop();
      await sender.replaceTrack(this.cameraTrack);
      c.sharing = false;
    } else {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = screen.getVideoTracks()[0];
      track.onended = () => {
        if (this.current?.sharing) void this.toggleScreenShare();
      };
      await sender.replaceTrack(track);
      c.sharing = true;
    }
    this.emit();
  }

  canShareScreen() {
    return Boolean(this.current?.video && typeof navigator !== "undefined" && navigator.mediaDevices?.getDisplayMedia);
  }

  // ── WebRTC plumbing ────────────────────────────────────────────────────────
  private async createPeer(callId: string) {
    if (!this.iceServers) {
      this.iceServers = (await api<{ iceServers: RTCIceServer[] }>("/api/calls/ice").catch(() => ({ iceServers: [] }))).iceServers;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.remoteReady = false;
    this.queuedIce = [];
    const remote = new MediaStream();
    this.current!.remote = remote;
    for (const track of this.current!.local?.getTracks() ?? []) pc.addTrack(track, this.current!.local!);
    pc.ontrack = (e) => {
      for (const t of e.streams[0]?.getTracks() ?? [e.track]) if (!remote.getTracks().includes(t)) remote.addTrack(t);
      this.emit();
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && this.current?.id === callId) void this.signal("ice", JSON.stringify(e.candidate.toJSON()));
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || !this.current) return;
      if (pc.connectionState === "connected" && this.current.phase !== "active") {
        this.current.phase = "active";
        this.current.connectedAt = Date.now();
        this.stopRing();
        this.emit();
      } else if (pc.connectionState === "failed") {
        void this.hangup().then(() => {
          if (this.current) this.current.endedReason = "Connection failed — the network may block calls. Try another network.";
          this.emit();
        });
      }
    };
  }

  private async handleSignal(s: Signal) {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (s.type === "offer") {
        await pc.setRemoteDescription(JSON.parse(s.payload));
        await this.flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.signal("answer", JSON.stringify(answer));
      } else if (s.type === "answer") {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(JSON.parse(s.payload));
          await this.flushIce();
        }
      } else if (s.type === "ice") {
        const candidate = JSON.parse(s.payload) as RTCIceCandidateInit;
        if (this.remoteReady) await pc.addIceCandidate(candidate);
        else this.queuedIce.push(candidate);
      }
    } catch (error) {
      console.warn("[call] signal failed", s.type, error);
    }
  }

  private async flushIce() {
    this.remoteReady = true;
    for (const c of this.queuedIce.splice(0)) await this.pc?.addIceCandidate(c).catch(() => undefined);
  }

  private async signal(type: Signal["type"], payload: string) {
    if (!this.current) return;
    await api(`/api/calls/${this.current.id}/signal`, { body: { type, payload } }).catch(() => undefined);
  }

  private teardown(reason: string | null) {
    this.stopRing();
    this.pc?.close();
    this.pc = null;
    const c = this.current;
    if (!c) return;
    c.local?.getTracks().forEach((t) => t.stop());
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    c.phase = "ended";
    c.endedReason = reason ?? "Call ended";
    this.pending.delete(c.id);
    this.emit();
    const id = c.id;
    setTimeout(() => {
      if (this.current?.id === id && this.current.phase === "ended") {
        this.current = null;
        this.emit();
      }
    }, 2500);
  }

  private startRing(kind: "incoming" | "outgoing") {
    this.stopRing();
    this.ringer = new Ringer(kind);
  }
  private stopRing() {
    this.ringer?.stop();
    this.ringer = null;
  }

  get me() {
    return this.meId;
  }
}

function blank(call: WireCall, peer: PublicUser, local: MediaStream, phase: ActiveCall["phase"]): ActiveCall {
  return {
    id: call.id, peer, video: call.video, outgoing: call.outgoing, conversationId: call.conversationId, phase,
    connectedAt: null, muted: false, cameraOff: false, sharing: false, local, remote: null, endedReason: null,
  };
}

async function getMedia(video: boolean) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Calls need a secure (https://) connection and a modern browser.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "NotAllowedError") throw new Error(`Allow ${video ? "camera and microphone" : "microphone"} access to make calls.`);
    if (name === "NotFoundError") throw new Error(video ? "No camera or microphone found." : "No microphone found.");
    throw error;
  }
}

/** Synthesised ring / ringback tones — no audio assets needed. */
class Ringer {
  private ctx: AudioContext | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  constructor(kind: "incoming" | "outgoing") {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      const play = () => {
        const ctx = this.ctx!;
        const tones = kind === "incoming" ? [[880, 0], [660, 0.18], [880, 0.36], [660, 0.54]] : [[425, 0], [425, 0.45]];
        for (const [freq, at] of tones) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
          gain.gain.exponentialRampToValueAtTime(kind === "incoming" ? 0.2 : 0.08, ctx.currentTime + at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + (kind === "incoming" ? 0.16 : 0.4));
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + at);
          osc.stop(ctx.currentTime + at + 0.45);
        }
      };
      play();
      this.interval = setInterval(play, kind === "incoming" ? 2000 : 3000);
      if (kind === "incoming") navigator.vibrate?.([400, 200, 400]);
    } catch {
      // Audio may be blocked until the user interacts with the page; the on-screen ring still shows.
    }
  }
  stop() {
    if (this.interval) clearInterval(this.interval);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
