"use client";

import { Mic, MicOff, MonitorUp, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CallManager } from "@/lib/client/calls";
import { useToast } from "./context";
import { Avatar } from "./ui";

export const CallContext = createContext<CallManager | null>(null);

/** Returns the call manager and re-renders whenever call state changes. */
export function useCalls() {
  const calls = useContext(CallContext);
  if (!calls) throw new Error("useCalls must be used inside the app shell");
  useSyncExternalStore(calls.subscribe, calls.getVersion, calls.getVersion);
  return calls;
}

/** Overlay that shows incoming rings and the in-call screen, wherever you are in the app. */
export function CallLayer() {
  const calls = useCalls();
  const toast = useToast();
  const inc = calls.incoming;
  const cur = calls.current;

  if (inc && !cur) {
    return (
      <div className="call-ring" role="alertdialog" aria-label={`Incoming call from ${inc.peer.displayName}`}>
        <div className="call-ring-pulse"><Avatar name={inc.peer.displayName} hue={inc.peer.avatarHue} size={64} /></div>
        <div className="grow">
          <strong>{inc.peer.displayName}</strong>
          <small>{inc.call.video ? "📹 Incoming video call" : "📞 Incoming voice call"} · end-to-end encrypted</small>
        </div>
        <button className="call-btn decline" onClick={() => void calls.decline()} aria-label="Decline"><PhoneOff size={22} /></button>
        <button className="call-btn accept" onClick={() => void calls.accept().catch((e: Error) => toast(e.message, "error"))} aria-label="Accept">
          {inc.call.video ? <Video size={22} /> : <Phone size={22} />}
        </button>
      </div>
    );
  }
  if (!cur) return null;
  return <InCall />;
}

function InCall() {
  const calls = useCalls();
  const toast = useToast();
  const c = calls.current!;
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (remoteVideo.current && remoteVideo.current.srcObject !== c.remote) remoteVideo.current.srcObject = c.remote;
    if (remoteAudio.current && remoteAudio.current.srcObject !== c.remote) remoteAudio.current.srcObject = c.remote;
    if (localVideo.current && localVideo.current.srcObject !== c.local) localVideo.current.srcObject = c.local;
  });

  const hasRemoteVideo = Boolean(c.remote?.getVideoTracks().some((t) => t.readyState === "live"));
  const elapsed = c.connectedAt ? Math.floor((now - c.connectedAt) / 1000) : 0;
  const status = c.phase === "ended"
    ? c.endedReason ?? "Call ended"
    : c.phase === "ringing" ? "Ringing…"
    : c.phase === "connecting" ? "Connecting…"
    : `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className={`call-screen${c.video ? " is-video" : ""}`} role="dialog" aria-label={`Call with ${c.peer.displayName}`}>
      {c.video && <video ref={remoteVideo} className={`call-remote${hasRemoteVideo ? "" : " hidden"}`} autoPlay playsInline />}
      {!c.video && <audio ref={remoteAudio} autoPlay />}
      {(!c.video || !hasRemoteVideo) && (
        <div className="call-center">
          <div className={c.phase === "active" ? "" : "call-ring-pulse"}><Avatar name={c.peer.displayName} hue={c.peer.avatarHue} size={112} /></div>
          <h2>{c.peer.displayName}</h2>
          <p>{status}</p>
        </div>
      )}
      {c.video && hasRemoteVideo && <div className="call-top"><strong>{c.peer.displayName}</strong><span>{status}</span></div>}
      {c.video && <video ref={localVideo} className={`call-local${c.cameraOff ? " off" : ""}`} autoPlay playsInline muted />}
      <p className="call-e2e">🔒 Peer-to-peer · encrypted (DTLS-SRTP)</p>
      <div className="call-controls">
        {c.phase !== "ended" ? (
          <>
            <button className={`call-btn soft${c.muted ? " on" : ""}`} onClick={() => calls.toggleMute()} aria-label={c.muted ? "Unmute" : "Mute"}>
              {c.muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            {c.video && (
              <button className={`call-btn soft${c.cameraOff ? " on" : ""}`} onClick={() => calls.toggleCamera()} aria-label={c.cameraOff ? "Camera on" : "Camera off"}>
                {c.cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}
            {calls.canShareScreen() && c.phase === "active" && (
              <button className={`call-btn soft${c.sharing ? " on" : ""}`} onClick={() => void calls.toggleScreenShare().catch((e: Error) => toast(e.message, "error"))} aria-label="Share screen">
                <MonitorUp size={22} />
              </button>
            )}
            <button className="call-btn decline" onClick={() => void calls.hangup()} aria-label="Hang up"><PhoneOff size={24} /></button>
          </>
        ) : (
          <button className="btn btn-light" onClick={() => calls.dismiss()}>Close</button>
        )}
      </div>
    </div>
  );
}
