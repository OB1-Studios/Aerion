import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

/** Self-hosted (SIL Open Font License, see src/fonts), so builds need no network. */
const manrope = localFont({ src: "../fonts/manrope-var.woff2", weight: "200 800", variable: "--font-manrope", display: "swap" });
const dmSerif = localFont({ src: "../fonts/dm-serif-display-400.woff2", weight: "400", variable: "--font-dm-serif", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Aerion", template: "%s · Aerion" },
  description: "Aerion runs the finance back office for Pakistani software houses and IT freelancers: export payments matched to invoices, ePRCs and certificates tracked, follow-ups drafted for your approval. It never moves money.",
  applicationName: "Aerion",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f8f5",
};

/** Light unless this browser chose dark: applied before the first paint, so the page never flashes. */
const THEME_SCRIPT = `try{if(localStorage.getItem("aerion-theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${dmSerif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
