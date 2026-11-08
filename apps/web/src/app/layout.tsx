import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

/** Self-hosted (SIL Open Font License, see src/fonts), so builds need no network. */
const plex = localFont({ src: "../fonts/plex-sans-var.woff2", weight: "100 700", variable: "--font-plex", display: "swap" });
const serif = localFont({ src: "../fonts/source-serif-4-var.woff2", weight: "200 900", variable: "--font-serif", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Aerion", template: "%s · Aerion" },
  description: "Aerion runs the finance back office for Pakistani software houses and IT freelancers: export payments matched to invoices, ePRCs and certificates tracked, follow-ups drafted for your approval. It never moves money.",
  applicationName: "Aerion",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1210" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plex.variable} ${serif.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
