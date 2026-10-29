import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The native apps are thin, hardened shells around the deployed web app, so every deploy reaches
 * phones instantly and the same end-to-end encryption code runs everywhere.
 *
 *   VARTALAP_URL=https://your-app.vercel.app npx cap sync
 *
 * Without VARTALAP_URL the app opens a small launcher (www/index.html) that asks for the server
 * address once; it may point at any *.vercel.app deployment, a trycloudflare/ngrok tunnel to your
 * computer, or a host listed in VARTALAP_HOSTS.
 */
const url = process.env.VARTALAP_URL?.replace(/\/$/, "");
const extraHosts = (process.env.VARTALAP_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

const config: CapacitorConfig = {
  appId: "in.vartalap.app",
  appName: "वार्तालाप",
  webDir: "www",
  backgroundColor: "#0f0c14",
  server: {
    ...(url ? { url: `${url}/app` } : {}),
    androidScheme: "https",
    cleartext: false,
    // Tunnel domains let a test build talk to `npm run dev` on your computer.
    allowNavigation: [...(url ? [new URL(url).host] : []), "*.vercel.app", "*.trycloudflare.com", "*.ngrok-free.app", ...extraHosts],
    errorPath: "offline.html",
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
