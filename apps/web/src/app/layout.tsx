import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "IT Export Back Office", template: "%s · IT Export Back Office" },
  description: "Finance back office for Pakistani IT exporters and freelancers: payments matched, compliance tracked, follow-ups drafted. Runs on Vultr.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
