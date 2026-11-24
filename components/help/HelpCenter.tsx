"use client";

import { ArrowLeft, BookOpen, CheckCircle2, Headset, PhoneCall, Search, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";

type Info = { workspace: { name: string; industry: string; intro: string; hours: string }; articles: { id: string; title: string; category: string; excerpt: string }[] };
type Article = { id: string; title: string; body: string; category: string; updatedAt: string };

/**
 * The customer-facing side of the helpdesk. Self-service first (search the answers),
 * then a ticket or a callback request, each with a private tracking link. No login.
 */
export function HelpCenter({ ws }: { ws: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [missing, setMissing] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ q: string; articles: Info["articles"] } | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [mode, setMode] = useState<"browse" | "issue" | "callback">("browse");
  const base = `/api/public/help/${ws}`;

  useEffect(() => {
    api<Info>(base).then(setInfo).catch(() => setMissing(true));
  }, [base]);

  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(() => void api<Info>(`${base}?q=${encodeURIComponent(q)}`).then((r) => setFound({ q, articles: r.articles })).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q, base]);

  if (missing) {
    return <main className="help"><div className="help-card center"><h1>Help centre not available</h1><p className="muted">This link may be wrong, or the business has turned its help centre off.</p></div></main>;
  }
  if (!info) return <main className="help"><div className="help-card center"><span className="spinner" /></div></main>;

  const results = q.trim() && found?.q === q ? found.articles : null;
  const list = results ?? info.articles;
  const byCat = list.reduce<Record<string, Info["articles"]>>((acc, a) => ((acc[a.category] ??= []).push(a), acc), {});

  return (
    <main className="help">
      <header className="help-hero">
        <span className="help-logo" aria-hidden="true">{info.workspace.name.slice(0, 1).toUpperCase()}</span>
        <h1>{info.workspace.name} · Help centre</h1>
        <p>{info.workspace.intro || "Search our answers, or tell us what's wrong and we'll get back to you."}</p>
        {info.workspace.hours && <small>Support hours: {info.workspace.hours}</small>}
        <label className="help-search"><Search size={18} /><input value={q} onChange={(e) => { setQ(e.target.value); setArticle(null); setMode("browse"); }} placeholder="Describe your problem, e.g. refund not received" aria-label="Search help articles" /></label>
      </header>

      <div className="help-actions">
        <button className={`help-action${mode === "issue" ? " on" : ""}`} onClick={() => { setMode("issue"); setArticle(null); }}>
          <Headset size={22} /><span><b>Raise a ticket</b><small>Get a reply with a tracking link</small></span>
        </button>
        <button className={`help-action${mode === "callback" ? " on" : ""}`} onClick={() => { setMode("callback"); setArticle(null); }}>
          <PhoneCall size={22} /><span><b>Request a callback</b><small>We&apos;ll call you at a time you choose</small></span>
        </button>
      </div>

      {mode !== "browse" && <TicketForm base={base} ws={ws} kind={mode} prefill={q} onCancel={() => setMode("browse")} />}

      {mode === "browse" && article && <ArticleView base={base} article={article} onBack={() => setArticle(null)} onNeedHelp={() => setMode("issue")} />}

      {mode === "browse" && !article && (
        <section className="help-card">
          <h2><BookOpen size={18} /> {results ? (results.length ? "Best matches" : "No matching answers") : "Popular answers"}</h2>
          {results && !results.length && <p className="muted">Couldn&apos;t find it? <button className="link" onClick={() => setMode("issue")}>Raise a ticket</button> and a person will help.</p>}
          {Object.entries(byCat).map(([category, items]) => (
            <div key={category} className="help-cat">
              <h3>{category}</h3>
              {items.map((a) => (
                <button key={a.id} className="help-article" onClick={() => void api<{ article: Article }>(`${base}/articles/${a.id}`).then((r) => setArticle(r.article))}>
                  <b>{a.title}</b><small>{a.excerpt}{a.excerpt.length >= 180 ? "…" : ""}</small>
                </button>
              ))}
            </div>
          ))}
        </section>
      )}

      <footer className="help-foot"><ShieldCheck size={14} /> Your details are shared only with {info.workspace.name}&apos;s support team · Powered by वार्तालाप</footer>
    </main>
  );
}

function ArticleView({ base, article, onBack, onNeedHelp }: { base: string; article: Article; onBack: () => void; onNeedHelp: () => void }) {
  const [voted, setVoted] = useState<boolean | null>(null);
  const vote = (helpful: boolean) => {
    setVoted(helpful);
    void api(`${base}/articles/${article.id}/vote`, { body: { helpful } }).catch(() => undefined);
  };
  return (
    <article className="help-card">
      <button className="link" onClick={onBack}><ArrowLeft size={15} /> All answers</button>
      <small className="muted block">{article.category}</small>
      <h2>{article.title}</h2>
      <div className="help-body">{article.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
      <div className="help-vote">
        {voted === null ? (
          <>
            <span>Did this answer your question?</span>
            <button className="btn btn-ghost sm" onClick={() => vote(true)}><ThumbsUp size={15} /> Yes</button>
            <button className="btn btn-ghost sm" onClick={() => vote(false)}><ThumbsDown size={15} /> No</button>
          </>
        ) : voted ? <span>Glad it helped! 🙏</span> : <span>Sorry about that. <button className="link" onClick={onNeedHelp}>Raise a ticket</button> and a person will help.</span>}
      </div>
    </article>
  );
}

function TicketForm({ base, ws, kind, prefill, onCancel }: { base: string; ws: string; kind: "issue" | "callback"; prefill: string; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState(prefill);
  const [description, setDescription] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ number: number; token: string } | null>(null);

  if (done) {
    const link = `/help/${ws}/t/${done.token}`;
    return (
      <section className="help-card help-done">
        <CheckCircle2 size={36} />
        <h2>{kind === "callback" ? "Callback requested" : `Ticket #${done.number} received`}</h2>
        <p>{kind === "callback" ? "Our team will call you back" + (preferredTime ? ` around ${preferredTime}` : " soon") + "." : "Our team will reply soon."} Keep this private link to check progress and reply:</p>
        <a className="btn btn-primary" href={link}>Track my request</a>
        <button className="btn btn-ghost sm" onClick={() => void navigator.clipboard?.writeText(location.origin + link)}>Copy link</button>
        <p className="muted small">Anyone with this link can see the ticket, so don&apos;t share it.</p>
      </section>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ number: number; token: string }>(`${base}/tickets`, {
        body: {
          kind, name: name.trim(), phone: phone.trim(), email: email.trim(), website,
          subject: (subject.trim() || (kind === "callback" ? `Callback request from ${name.trim()}` : "")).slice(0, 160),
          description: description.trim(), preferredTime: preferredTime.trim(),
        },
      });
      setDone(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const valid = name.trim().length >= 2 && (kind === "callback" ? phone.trim().length >= 6 : (phone.trim() || email.trim()) && subject.trim().length >= 3);

  return (
    <section className="help-card">
      <h2>{kind === "callback" ? <><PhoneCall size={18} /> Request a callback</> : <><Headset size={18} /> Raise a ticket</>}</h2>
      <div className="two-col">
        <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" /></label>
        <label className="field"><span>Phone{kind === "issue" ? " (or email)" : ""}</span><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" /></label>
      </div>
      {kind === "issue" && <label className="field"><span>Email (optional)</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} autoComplete="email" /></label>}
      <label className="field"><span>{kind === "callback" ? "What is it about? (optional)" : "Subject"}</span><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} /></label>
      {kind === "callback"
        ? <label className="field"><span>Best time to call</span><input value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} maxLength={80} placeholder="e.g. today after 6 pm" /></label>
        : <label className="field"><span>Tell us more</span><textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} placeholder="Booking or order number, what happened, what you'd like us to do" /></label>}
      {/* Hidden from people; bots fill it in and get silently ignored. */}
      <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="row gap-xs">
        <button className="btn btn-primary" disabled={busy || !valid} onClick={() => void submit()}>{busy ? "Sending…" : kind === "callback" ? "Request callback" : "Submit ticket"}</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
