# वार्तालाप (Vartalap)

Private chats, group chats, in-chat payments and a public feed in one app, with end-to-end encryption on by default.
It runs on the web, installs as an app on Android, iPhone and desktop, and the native Android/iOS shells live in [`mobile/`](mobile/).

| | |
|---|---|
| **Chats** | 1:1 and groups (up to 256), replies, reactions, edit (48 h), delete-for-everyone (erased server-side), pins, read receipts, polls, photos, files, voice notes |
| **Unique** | ⏳ **Time capsules** (messages that unlock at a future date), 💸 **pay & split bills inside chats**, 🫥 disappearing messages (5 min → 90 days), 🛡️ **Privacy Shield** (blurs the app when you switch away), 🔑 safety numbers + key-change warnings, 🪔 **Vichaar** feed with moods |
| **Wallet** | Double-entry ledger, atomic + idempotent transfers, payment requests and group splits, encrypted payment notes (test money until a gateway is connected) |
| **Platforms** | Responsive web app, installable PWA, Android APK and iOS project via Capacitor |

---

## How the privacy works

Everything private is encrypted **in the browser/app** before it is sent. The server stores and relays ciphertext only.

```
password ─PBKDF2-SHA256 (310k)─► auth key ──► server stores scrypt(auth key)   (password never leaves the device)
                              └► master key ─► encrypts your P-256 identity private key (stored on server, opaque)

conversation key (AES-256-GCM, random, per "key epoch")
   └─ wrapped separately for each member:  ephemeral ECDH(P-256) → HKDF-SHA256 → AES-GCM
messages / group names / polls / payment notes:  AES-256-GCM, bound to (conversation, epoch, sender, message id)
attachments: a fresh random AES-256 key per file, carried inside the encrypted message
```

* **Group membership changes rotate the key.** When someone is removed, the admin's device installs a new epoch they don't receive. When someone leaves, the group is flagged and the next remaining member's device rotates it before anyone can send. New members get only the new epoch, so they can't read earlier history.
* **Trust on first use.** Each device remembers contacts' identity keys and warns if one changes. Safety numbers let people verify each other in person.
* **Identity key on device.** It is stored as a *non-extractable* WebCrypto key in IndexedDB. Signing out wipes it.
* **Verified:** `npm run db:inspect` prints what the database actually holds: ciphertext, wrapped keys and hashes.

**Honest limits** (also shown on the website):
* The server necessarily sees **metadata**: who is in which conversation, and when messages are sent.
* Keys rotate on membership changes, not per message. There is no Signal-style double ratchet yet, so a stolen device key exposes that user's history.
* Vichaar posts are public by design.
* Wallet amounts live in the server ledger (only notes are encrypted).
* As with any web-delivered E2EE, you trust the code the server ships. The native shells load the same code.
* No independent security audit has been done yet. Get one before handling sensitive data at scale.

---

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000 — uses an embedded Postgres (PGlite) in .data/, zero setup
npm run test:e2e       # 13 end-to-end API checks with real crypto (server must be running; BASE_URL=… to change)
```

Requires Node 20.19+ (22+ to run the test scripts).

### Test on your phone (before deploying)
Encryption (WebCrypto) only works over **https://**, so `http://192.168.x.x:3000` won't work on a phone. Use a free tunnel:
```powershell
winget install --id Cloudflare.cloudflared      # once
npm run dev                                      # terminal 1
cloudflared tunnel --url http://localhost:3000   # terminal 2 → prints https://<random>.trycloudflare.com
```
Open that `https://…trycloudflare.com/app` URL on any phone. On iPhone you can then do Safari → Share → **Add to Home Screen**. The native test builds below also accept this URL on first launch.

### iPhone test build (no paid Apple account)
iPhones can't install APKs (those are Android only), and Windows can't compile iOS apps. So:
1. Push the repo to GitHub, then go to **Actions → iOS IPA → Run workflow**. Leave the URL empty so the app asks for it on launch. It builds on a free macOS runner.
2. Download the `vartalap-ios-unsigned` artifact and unzip it to get `vartalap-unsigned.ipa`.
3. On Windows, install **iTunes** (from apple.com, not the Store version) and **[Sideloadly](https://sideloadly.io)**. Plug in the iPhone and tap *Trust This Computer*.
4. In Sideloadly, drag in the `.ipa`, enter your normal (free) Apple ID, and press **Start**. Sideloadly signs and installs it.
5. On the iPhone:
   * Go to **Settings → General → VPN & Device Management**, open your Apple ID, then tap **Trust**.
   * Then go to **Settings → Privacy & Security → Developer Mode**, turn it **On**, and restart.
6. Open वार्तालाप and enter your tunnel or Vercel URL.

Free-Apple-ID installs expire after **7 days**. Re-run Sideloadly to refresh. A paid developer account removes this limit.

## Deploy to Vercel (web + API)

1. Push this folder (`vartalap/`) to a GitHub repo and **Import** it in Vercel. Framework: Next.js; root: the repo root.
2. **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL`/`POSTGRES_URL`.
3. **Settings → Environment Variables:**
   * `APP_SECRET`: 32+ random chars (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   * `CRON_SECRET`: any random string (protects the daily cleanup cron in `vercel.json`)
   * optional: see [`.env.example`](.env.example)
4. Deploy. The schema migrates itself on the first request (idempotent, lock-protected). Check `https://<app>.vercel.app/api/health`.

## Mobile apps

### Android APK
The APK is a hardened Capacitor shell that loads your deployed app, so web deploys update phones instantly.

**Option A: GitHub Actions (no local Android SDK needed)**
1. Push to GitHub, then go to **Actions → Android APK → Run workflow**. Enter your Vercel URL, or leave it blank so the app asks for the server on first launch.
2. Download the `vartalap-apk` artifact. Pushing a tag such as `v1.0.0` also publishes it as a GitHub Release.
3. To offer it on the website, either commit it as `public/downloads/vartalap.apk`, or set
   `NEXT_PUBLIC_ANDROID_APK_URL=https://github.com/<you>/<repo>/releases/latest/download/vartalap.apk`.
4. For a release-signed APK, add the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Without them, CI builds a debug-signed APK, which is fine for testing.

**Option B: locally.** Install Android Studio (SDK + JDK 21), then:
```powershell
cd mobile; .\build-android.ps1 -Url https://your-app.vercel.app   # → public/downloads/vartalap.apk
```

### iPhone / iPad
* **Today, free:** open the site in Safari → Share → **Add to Home Screen**. It runs full-screen like an app.
* **Native app:** `mobile/ios` is a ready Capacitor project. Building an installable `.ipa` needs a Mac with Xcode and an Apple Developer account ($99/yr): `cd mobile && VARTALAP_URL=https://… npm run ios:open`, then Archive → TestFlight. Set `NEXT_PUBLIC_IOS_URL` to the TestFlight link to show it on the website.

---

## Architecture & scaling

* **Next.js 16 App Router** serves the marketing site (`/`), the app (`/app`) and the REST API (`/api/*`, route handlers).
* **Postgres** stores everything. Driver: `pg` with a small per-instance pool (use Neon's *pooled* URL). PGlite is used only for local development.
* **Sync:** a single global `change_seq` sequence gives every message and conversation change a cursor. Clients poll `/api/sync?cursor=` adaptively: 2 s in an open chat, 4 s otherwise, 20 s in the background. Rows from the last 2.5 s are re-delivered to cover late-committing transactions, and clients de-duplicate. This works on Vercel without WebSockets.
* **Stateless API:** sessions are random tokens (SHA-256-hashed in the DB) in `HttpOnly; SameSite=Lax` cookies, plus Origin checks. Rate limits are stored in Postgres, so they hold across instances.
* **Money:** the `wallets.balance_paise >= 0` constraint, row locks taken in a consistent order, per-sender idempotency keys and an append-only `ledger_entries` table.

When you outgrow polling, the next steps are:
* Push sync events through a realtime service (Ably/Pusher/Supabase Realtime) and keep `/api/sync` as the catch-up path.
* Move attachments from Postgres `bytea` to Vercel Blob/S3, and add Web Push for background notifications.
* Add read replicas, and partition `messages` by conversation hash.
* Add WebRTC calls with a TURN service.
* Adopt a ratcheting protocol (e.g. MLS for groups).
* Connect a licensed payment gateway (Razorpay/UPI) behind the existing ledger, then set `WALLET_TEST_MODE=off`.

## Project layout

```
app/                  pages (/, /app), API route handlers, manifest, icons
components/app/       the chat app UI (engine-driven, client side)
components/site/      marketing-site widgets
lib/crypto.ts         all end-to-end cryptography (WebCrypto only)
lib/client/           sync engine, API client, key storage, selectors
lib/server/           db + migrations, auth, validation, rate limits, wallet, conversations
mobile/               Capacitor Android + iOS shells, icons, build script
scripts/              e2e test suite, database inspector
```
