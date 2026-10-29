"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { Engine } from "@/lib/client/engine";

export const EngineContext = createContext<Engine | null>(null);

/** Returns the engine and re-renders whenever its data changes. */
export function useEngine() {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useEngine must be used inside the app shell");
  useSyncExternalStore(engine.subscribe, engine.getVersion, engine.getVersion);
  return engine;
}

type Toast = { id: number; text: string; tone: "info" | "error" | "success" };
type ToastFn = (text: string, tone?: Toast["tone"]) => void;
const ToastContext = createContext<ToastFn>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<ToastFn>((text, tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 5000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Runs an async action, surfacing failures as an error toast. Returns [run, busy]. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      if (success) toast(success, "success");
      return result;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Something went wrong.", "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy] as const;
}

// ── preferences (per device) ───────────────────────────────────────────────

export type Prefs = {
  theme: "system" | "light" | "dark";
  accent: "saffron" | "peacock" | "lotus" | "indigo" | "emerald";
  shield: boolean;
  notify: boolean;
  previews: boolean;
  enterToSend: boolean;
};

const DEFAULT_PREFS: Prefs = { theme: "system", accent: "saffron", shield: false, notify: true, previews: true, enterToSend: true };
const PREFS_EVENT = "vt-prefs";

export function readPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("vt:prefs") ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

let cachedRaw: string | null = null;
let cachedPrefs: Prefs = DEFAULT_PREFS;
function prefsSnapshot() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("vt:prefs");
  } catch {
    // ignore
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = readPrefs();
  }
  return cachedPrefs;
}

export function usePrefs() {
  const prefs = useSyncExternalStore(
    (fn) => {
      window.addEventListener(PREFS_EVENT, fn);
      window.addEventListener("storage", fn);
      return () => {
        window.removeEventListener(PREFS_EVENT, fn);
        window.removeEventListener("storage", fn);
      };
    },
    prefsSnapshot,
    () => DEFAULT_PREFS,
  );
  const update = useCallback((patch: Partial<Prefs>) => {
    try {
      localStorage.setItem("vt:prefs", JSON.stringify({ ...readPrefs(), ...patch }));
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(PREFS_EVENT));
  }, []);
  return [prefs, update] as const;
}

export function useApplyTheme(prefs: Prefs) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.dataset.accent = prefs.accent;
  }, [prefs.theme, prefs.accent]);
}
