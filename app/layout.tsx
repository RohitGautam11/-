import type { Metadata, Viewport } from "next";
import { Mukta, Plus_Jakarta_Sans } from "next/font/google";
import { APP_NAME, TAGLINE } from "@/lib/brand";
import "./globals.css";

const sans = Plus_Jakarta_Sans({ variable: "--font-sans", subsets: ["latin"], display: "swap" });
const deva = Mukta({ variable: "--font-deva", subsets: ["devanagari", "latin"], weight: ["400", "600", "800"], display: "swap" });

export const metadata: Metadata = {
  title: { default: `${APP_NAME} — Private chats, payments & posts`, template: `%s · ${APP_NAME}` },
  description: TAGLINE,
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/192", apple: "/icons/180" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff8f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0c14" },
  ],
};

// Applies the saved theme before first paint so there is no light/dark flash.
const themeScript = `try{var p=JSON.parse(localStorage.getItem("vt:prefs")||"{}");var d=document.documentElement;d.dataset.theme=p.theme||"system";d.dataset.accent=p.accent||"saffron"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${deva.variable}`} data-theme="system" data-accent="saffron" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
