"use client";

import { Check, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { PublicUser } from "@/lib/client/types";
import { Avatar, Spinner } from "./ui";

/** Searches people by username or name. Calls `onPick` per person; shows ticks for `selected`. */
export function PeoplePicker({
  onPick, selected, exclude = [], autoFocus = true,
}: { onPick: (u: PublicUser) => void; selected?: PublicUser[]; exclude?: string[]; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);

  const term = q.trim();
  const searchable = term.replace(/^@/, "").length >= 2;
  useEffect(() => {
    if (!searchable) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api<{ users: PublicUser[] }>(`/api/users/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => setResults(r.users))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [term, searchable]);

  const shown = searchable ? results.filter((u) => !exclude.includes(u.id)) : [];
  return (
    <div className="picker">
      <label className="search">
        <Search size={17} />
        <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search @username or name" autoCapitalize="none" spellCheck={false} />
        {loading && <Spinner size={16} />}
      </label>
      {selected && selected.length > 0 && (
        <div className="chips">
          {selected.map((u) => <button key={u.id} className="chip" onClick={() => onPick(u)}>{u.displayName} ✕</button>)}
        </div>
      )}
      <div className="picker-list">
        {q.trim().length >= 2 && !loading && shown.length === 0 && <p className="muted pad">No one found. Ask them for their @username.</p>}
        {q.trim().length < 2 && <p className="muted pad">Type at least two letters to find people.</p>}
        {shown.map((u) => {
          const on = selected?.some((s) => s.id === u.id);
          return (
            <button key={u.id} className={`person-row${on ? " on" : ""}`} onClick={() => onPick(u)}>
              <Avatar name={u.displayName} hue={u.avatarHue} size={40} />
              <span className="person-copy"><strong>{u.displayName}</strong><small>@{u.username}</small></span>
              {selected && <span className={`tick${on ? " on" : ""}`}>{on && <Check size={14} />}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
