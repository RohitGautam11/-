"use client";

import { MonitorDown } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** Offers the browser's native "Install app" prompt where supported (Chrome, Edge, Android). */
export function InstallButton({ className = "btn btn-ghost", label = "Install web app" }: { className?: string; label?: string }) {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [justInstalled, setInstalled] = useState(false);
  const standalone = useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia("(display-mode: standalone)");
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia("(display-mode: standalone)").matches,
    () => false,
  );
  const installed = justInstalled || standalone;

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return <span className={`${className} is-done`}>✓ Installed</span>;
  return (
    <button
      className={className}
      onClick={async () => {
        if (!prompt) {
          document.getElementById("install-help")?.scrollIntoView({ behavior: "smooth" });
          return;
        }
        await prompt.prompt();
        await prompt.userChoice;
        setPrompt(null);
      }}
    >
      <MonitorDown size={18} /> {label}
    </button>
  );
}
