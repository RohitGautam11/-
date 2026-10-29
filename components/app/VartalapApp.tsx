"use client";

import { MessageCircle, Newspaper, Settings, WalletCards, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Engine } from "@/lib/client/engine";
import { previewText, titleOf } from "@/lib/client/selectors";
import { logout, restore } from "@/lib/client/session";
import type { Me } from "@/lib/client/types";
import { AuthScreen } from "./AuthScreen";
import { ChatList } from "./ChatList";
import { ChatView } from "./ChatView";
import { EngineContext, ToastProvider, useApplyTheme, useEngine, usePrefs, useToast } from "./context";
import { FeedView } from "./FeedView";
import { ProfileSheet } from "./ProfileSheet";
import { SettingsView } from "./SettingsView";
import { Avatar, Spinner } from "./ui";
import { WalletView } from "./WalletView";

type Boot =
  | { state: "loading" }
  | { state: "auth"; reason?: string; username?: string }
  | { state: "ready"; user: Me; identity: CryptoKey };

export type Tab = "chats" | "feed" | "wallet" | "settings";

export default function VartalapApp() {
  const [prefs] = usePrefs();
  useApplyTheme(prefs);
  const [boot, setBoot] = useState<Boot>({ state: "loading" });

  useEffect(() => {
    // WebCrypto only exists on https:// (or localhost), e.g. not on http://192.168.x.x from a phone.
    const secure = window.isSecureContext && Boolean(globalThis.crypto?.subtle);
    (secure ? restore() : Promise.reject(new Error("insecure")))
      .then((session) => {
        if (!session) setBoot({ state: "auth" });
        else if (!session.identity) setBoot({ state: "auth", reason: "Sign in on this device to unlock your encryption keys.", username: session.user.username });
        else setBoot({ state: "ready", user: session.user, identity: session.identity });
      })
      .catch((error: Error) => setBoot({
        state: "auth",
        reason: error.message === "insecure"
          ? "Encryption needs a secure (https://) connection. On a phone, open the app through an HTTPS tunnel or your Vercel URL — not http://192.168…"
          : "Could not reach the server. Check your connection.",
      }));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  return (
    <ToastProvider>
      {boot.state === "loading" && <div className="boot"><span className="brand-mark big">व</span><Spinner size={22} /></div>}
      {boot.state === "auth" && (
        <AuthScreen
          reason={boot.reason}
          presetUsername={boot.username}
          onAuthed={(user, identity) => setBoot({ state: "ready", user, identity })}
        />
      )}
      {boot.state === "ready" && (
        <Session
          key={boot.user.id}
          user={boot.user}
          identity={boot.identity}
          onSignedOut={(reason) => setBoot({ state: "auth", reason })}
        />
      )}
    </ToastProvider>
  );
}

function Session({ user, identity, onSignedOut }: { user: Me; identity: CryptoKey; onSignedOut: (reason?: string) => void }) {
  const engine = useMemo(
    () => new Engine(user, identity, () => onSignedOut("Your session ended. Please sign in again.")),
    // The engine lives exactly as long as this signed-in session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user.id],
  );
  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  const signOut = useCallback(async () => {
    engine.stop();
    await logout();
    onSignedOut();
  }, [engine, onSignedOut]);

  return (
    <EngineContext.Provider value={engine}>
      <Shell onSignOut={signOut} />
    </EngineContext.Provider>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [prefs] = usePrefs();
  const [tab, setTab] = useState<Tab>("chats");
  const [openId, setOpenId] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [shielded, setShielded] = useState(false);

  const openChat = useCallback((id: string | null) => {
    setOpenId(id);
    engine.setActiveConversation(id);
    if (id) {
      setTab("chats");
      // Lets the Android back button / browser back close the chat on small screens.
      if (window.matchMedia("(max-width: 860px)").matches) history.pushState({ vtChat: id }, "");
    }
  }, [engine]);

  useEffect(() => {
    const onPop = () => {
      setOpenId(null);
      engine.setActiveConversation(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [engine]);

  // Notifications for messages that arrive while you're elsewhere.
  useEffect(() => engine.onIncoming(({ conversation, message }) => {
    const title = titleOf(conversation, engine.me.id);
    const text = prefs.previews ? previewText(message, conversation, engine.me.id) : "New encrypted message";
    const hidden = document.visibilityState === "hidden";
    if (!hidden && conversation.id === openId) return;
    if (hidden && prefs.notify && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body: text, tag: conversation.id, icon: "/icons/192" });
      n.onclick = () => {
        window.focus();
        openChat(conversation.id);
      };
    } else if (!hidden) {
      toast(`${title}: ${text}`.slice(0, 120));
    }
  }), [engine, openId, prefs.notify, prefs.previews, toast, openChat]);

  // Privacy Shield: blur everything the moment the app loses focus (app switcher, screen share).
  useEffect(() => {
    if (!prefs.shield) return;
    const hide = () => setShielded(true);
    const show = () => setShielded(document.visibilityState === "hidden");
    window.addEventListener("blur", hide);
    window.addEventListener("focus", show);
    document.addEventListener("visibilitychange", show);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", show);
      document.removeEventListener("visibilitychange", show);
    };
  }, [prefs.shield]);

  // Unread badge in the tab title.
  let unread = 0;
  for (const conv of engine.conversations.values()) {
    const mine = conv.members.find((m) => m.id === engine.me.id);
    for (const m of conv.messages.values()) if (m.senderId !== engine.me.id && m.kind !== "system" && !m.status && m.seq > (mine?.lastReadSeq ?? 0)) unread++;
  }
  useEffect(() => {
    document.title = unread ? `(${unread}) वार्तालाप` : "वार्तालाप";
  }, [unread]);

  const tabs: { id: Tab; label: string; icon: typeof MessageCircle; badge?: number }[] = [
    { id: "chats", label: "Chats", icon: MessageCircle, badge: unread },
    { id: "feed", label: "Vichaar", icon: Newspaper },
    { id: "wallet", label: "Wallet", icon: WalletCards },
    { id: "settings", label: "You", icon: Settings },
  ];

  return (
    <div className={`shell tab-${tab}${openId ? " chat-open" : ""}${prefs.shield && shielded ? " shielded" : ""}`}>
      <nav className="rail" aria-label="Main">
        <button className="brand-mark" onClick={() => { setTab("chats"); }} aria-label="वार्तालाप">व</button>
        <div className="rail-tabs">
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button key={id} className={`rail-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)} aria-label={label} title={label}>
              <Icon size={22} strokeWidth={1.9} />
              {badge ? <span className="badge">{badge > 99 ? "99+" : badge}</span> : null}
            </button>
          ))}
        </div>
        <button className="rail-me" onClick={() => setTab("settings")} aria-label="Your profile">
          <Avatar name={engine.me.displayName} hue={engine.me.avatarHue} size={38} />
        </button>
      </nav>

      {tab === "chats" && (
        <>
          <section className="pane-list"><ChatList selectedId={openId} onSelect={openChat} onOpenProfile={setProfile} /></section>
          <main className="pane-main">
            {openId && engine.conversations.has(openId)
              ? <ChatView key={openId} conversationId={openId} onBack={() => history.state?.vtChat ? history.back() : openChat(null)} onOpenProfile={setProfile} />
              : <Welcome />}
          </main>
        </>
      )}
      {tab === "feed" && <main className="pane-wide"><FeedView onOpenProfile={setProfile} /></main>}
      {tab === "wallet" && <main className="pane-wide"><WalletView onOpenChat={openChat} /></main>}
      {tab === "settings" && <main className="pane-wide"><SettingsView onSignOut={onSignOut} onOpenProfile={setProfile} /></main>}

      <nav className="tabbar" aria-label="Main">
        {tabs.map(({ id, label, icon: Icon, badge }) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <span className="tabbar-icon"><Icon size={22} strokeWidth={1.9} />{badge ? <span className="badge">{badge > 99 ? "99+" : badge}</span> : null}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {!engine.online && <div className="offline-pill"><WifiOff size={14} /> Reconnecting…</div>}
      {profile && <ProfileSheet username={profile} onClose={() => setProfile(null)} onMessage={(id) => { setProfile(null); openChat(id); }} />}
      {prefs.shield && shielded && <div className="shield-overlay"><span className="brand-mark big">व</span><p>Privacy Shield is on</p></div>}
    </div>
  );
}

function Welcome() {
  const engine = useEngine();
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Suprabhat" : hour < 17 ? "Namaste" : "Shubh sandhya";
  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden="true"><span>व</span></div>
      <h2>{greet}, {engine.me.displayName.split(" ")[0]} 🙏</h2>
      <p>Pick a conversation, or start a new one. Everything you send is sealed on this device before it leaves.</p>
      <div className="welcome-chips">
        <span>🔐 End-to-end encrypted</span>
        <span>⏳ Time capsules</span>
        <span>💸 Pay & split in chat</span>
        <span>🫥 Disappearing messages</span>
      </div>
    </div>
  );
}
