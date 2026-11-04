import { formatDateLong, formatMoney, type EvidenceValue, formatEvidence, TEMPLATE_NAMES, type TemplateKey } from "@ebo/core";

export const money = (amount: string | null | undefined, currency: string | null | undefined) => (amount == null || !currency ? "—" : formatMoney(amount, currency));
export const day = (d: string | null | undefined) => (d ? formatDateLong(d) : "—");

/** "Mon 2 Nov 2026, 09:00" in the workspace's time zone. */
export function clock(d: Date | null | undefined, timeZone = "Asia/Karachi") {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
}

export function ago(d: Date | null | undefined) {
  if (!d) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const duration = (a: Date | null | undefined, b: Date | null | undefined) => {
  if (!a || !b) return "—";
  const ms = b.getTime() - a.getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

export const evidenceText = (v: EvidenceValue) => formatEvidence(v);
export const templateName = (t: string | null | undefined) => (t ? (TEMPLATE_NAMES[t as TemplateKey] ?? t) : "Task");
export const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", finance: "Finance", accountant: "Accountant", viewer: "Viewer" };
