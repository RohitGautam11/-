import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Apple, ArrowRight, BarChart3, Download, EyeOff, Fingerprint, Hourglass, IndianRupee, KeyRound, Lock, MessageCircle,
  Newspaper, Server, ShieldCheck, Smartphone, Timer, Users,
} from "lucide-react";
import Link from "next/link";
import { InstallButton } from "@/components/site/InstallButton";
import { APP_NAME } from "@/lib/brand";

const FEATURES = [
  { icon: Lock, title: "Truly end-to-end encrypted", text: "Messages, photos, voice notes, files, polls, group names and payment notes are sealed on your device. The server only ever stores ciphertext." },
  { icon: Hourglass, title: "Time capsules", text: "Write a message today that opens on a birthday, an anniversary or results day. Until then it stays a sealed envelope — even for the server." },
  { icon: IndianRupee, title: "Pay & split in chat", text: "Send money with a private note, request it back, or split the dinner bill across a group and watch it settle live." },
  { icon: Timer, title: "Disappearing messages", text: "Pick a timer from 5 minutes to 90 days. Expired messages are erased from the database, not just hidden." },
  { icon: Users, title: "Groups that re-key", text: "When someone leaves or is removed, the group switches to a fresh key automatically. New members never see old history." },
  { icon: Newspaper, title: "Vichaar feed", text: "A calm public feed for thoughts, gratitude, ideas and asks for help — with moods instead of algorithms." },
  { icon: Fingerprint, title: "Safety numbers", text: "Verify a contact in person, and get warned if anyone's security key ever changes unexpectedly." },
  { icon: EyeOff, title: "Privacy Shield", text: "Blur the whole app the instant you switch away — ideal for crowded trains and screen sharing." },
  { icon: BarChart3, title: "Polls, pins & reactions", text: "Decide where to eat, pin the plan, react with ❤️ — all of it encrypted, all of it fast." },
];

function apk() {
  const external = process.env.NEXT_PUBLIC_ANDROID_APK_URL;
  if (external) return { href: external, size: null as string | null };
  const file = join(process.cwd(), "public", "downloads", "vartalap.apk");
  if (existsSync(file)) return { href: "/downloads/vartalap.apk", size: `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB` };
  return null;
}

export default function Home() {
  const android = apk();
  const ios = process.env.NEXT_PUBLIC_IOS_URL;
  return (
    <div className="site">
      <header className="site-nav">
        <Link href="/" className="site-brand"><span className="brand-mark">व</span><span>{APP_NAME}</span></Link>
        <nav>
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#download">Download</a>
        </nav>
        <Link href="/app" className="btn btn-primary sm">Open app <ArrowRight size={16} /></Link>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><ShieldCheck size={14} /> End-to-end encrypted by default</span>
          <h1><span className="deva">वार्तालाप</span><br />Talk. Pay. Share.<br /><em>Privately.</em></h1>
          <p>The best of Telegram-style groups and WhatsApp-style chats, with payments and a public feed built in — and nothing you say readable by anyone but the people you say it to.</p>
          <div className="hero-cta">
            <Link href="/app" className="btn btn-primary lg"><MessageCircle size={19} /> Open web app</Link>
            <a href="#download" className="btn btn-ghost lg"><Download size={19} /> Get the mobile app</a>
          </div>
          <ul className="hero-proof">
            <li>🔐 AES-256-GCM + P-256 ECDH</li>
            <li>📱 Android · iPhone · Desktop</li>
            <li>₹ Pay & split in chat</li>
          </ul>
        </div>
        <div className="hero-phone" aria-hidden="true">
          <div className="phone">
            <div className="phone-head"><span className="ph-avatar">🏏</span><div><b>Weekend gang</b><small>4 members · encrypted</small></div></div>
            <div className="phone-body">
              <div className="ph-msg them">Fort trail at 7? 🌄</div>
              <div className="ph-msg me">In! Bringing chai ☕</div>
              <div className="ph-card"><b>🧾 Split bill</b><span>Breakfast at Sharma ji&apos;s</span><div className="ph-bar"><i /></div><small>₹600 of ₹800 collected</small></div>
              <div className="ph-capsule">⏳ Time capsule from Ananya<br /><small>Opens in 2d 4h 12m</small></div>
              <div className="ph-msg them">📊 Poll: Lakeside or fort? <b>Fort 75%</b></div>
            </div>
            <div className="phone-input"><span>Message</span><i>➤</i></div>
          </div>
        </div>
      </section>

      <section id="features" className="section">
        <h2>Everything you need in one calm place</h2>
        <p className="section-lead">Built for families, friends, college groups and small teams — designed to feel fast and familiar, with privacy you don&apos;t have to think about.</p>
        <div className="feature-grid">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <article key={title} className="feature">
              <span className="feature-icon"><Icon size={22} /></span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="security" className="section security">
        <h2>How your privacy is protected</h2>
        <div className="flow">
          <div className="flow-step"><Smartphone size={26} /><b>Your device</b><span>Generates your identity key. Your password never leaves it.</span></div>
          <div className="flow-arrow">→ sealed →</div>
          <div className="flow-step server"><Server size={26} /><b>Our server</b><span>Stores ciphertext, routes it, and keeps the ledger. It cannot read messages.</span></div>
          <div className="flow-arrow">→ sealed →</div>
          <div className="flow-step"><Smartphone size={26} /><b>Their device</b><span>Unwraps the conversation key and decrypts locally.</span></div>
        </div>
        <div className="security-grid">
          <div><KeyRound size={18} /><p><b>Password-derived keys.</b> PBKDF2 (310k rounds) turns your password into an auth key and a separate master key. The server gets only a scrypt hash of the auth key.</p></div>
          <div><Lock size={18} /><p><b>Per-conversation keys.</b> Each chat has its own AES-256 key, wrapped individually for every member with ephemeral ECDH + HKDF.</p></div>
          <div><Users size={18} /><p><b>Membership changes rotate keys.</b> Leavers lose access to new messages; newcomers can&apos;t read old ones.</p></div>
          <div><ShieldCheck size={18} /><p><b>Honest limits.</b> The server still sees who talks to whom and when (metadata), and keys don&apos;t yet ratchet per message like Signal. Posts on Vichaar are public by design.</p></div>
        </div>
      </section>

      <section id="download" className="section download">
        <h2>Get {APP_NAME}</h2>
        <p className="section-lead">One account works everywhere. Your messages stay encrypted on every device.</p>
        <div className="download-grid">
          <article className="download-card">
            <span className="dl-icon android"><Smartphone size={26} /></span>
            <h3>Android</h3>
            {android ? (
              <>
                <p>Download the APK and open it to install. You may need to allow &quot;Install unknown apps&quot; for your browser.</p>
                <a className="btn btn-primary" href={android.href} download><Download size={18} /> Download APK{android.size ? ` · ${android.size}` : ""}</a>
              </>
            ) : (
              <>
                <p>Install directly from Chrome — it works like a native app, with its own icon and window.</p>
                <InstallButton className="btn btn-primary" label="Install on Android" />
                <small className="muted">The signed APK appears here once it&apos;s built (see README → Android).</small>
              </>
            )}
          </article>
          <article className="download-card">
            <span className="dl-icon ios"><Apple size={26} /></span>
            <h3>iPhone & iPad</h3>
            {ios ? (
              <>
                <p>Install the beta through TestFlight.</p>
                <a className="btn btn-primary" href={ios}><Download size={18} /> Get it on TestFlight</a>
              </>
            ) : (
              <p>Open <b>this site in Safari</b>, tap <b>Share</b> <span aria-hidden="true">⎋</span>, then <b>Add to Home Screen</b>. {APP_NAME} opens full-screen like any app.</p>
            )}
            <Link className="btn btn-ghost" href="/app">Open in Safari</Link>
          </article>
          <article className="download-card">
            <span className="dl-icon desktop"><MessageCircle size={26} /></span>
            <h3>Windows, Mac & Linux</h3>
            <p>Use it in any modern browser, or install it as a desktop app from Chrome or Edge.</p>
            <InstallButton className="btn btn-primary" label="Install desktop app" />
            <Link className="btn btn-ghost" href="/app">Open web app</Link>
          </article>
        </div>
        <div id="install-help" className="install-help">
          <h3>Install help</h3>
          <ul>
            <li><b>Android (Chrome):</b> menu ⋮ → <i>Install app</i> or <i>Add to Home screen</i>.</li>
            <li><b>iPhone (Safari):</b> Share → <i>Add to Home Screen</i>. Requires iOS 16.4+ for notifications.</li>
            <li><b>Desktop (Chrome/Edge):</b> click the install icon in the address bar.</li>
          </ul>
        </div>
      </section>

      <footer className="site-foot">
        <span className="site-brand"><span className="brand-mark">व</span><span>{APP_NAME}</span></span>
        <span className="muted">Private by design. Made in India 🇮🇳</span>
        <Link href="/app">Open app</Link>
      </footer>
    </div>
  );
}
