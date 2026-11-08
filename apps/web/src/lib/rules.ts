/**
 * The rules library in words: a name, a group and a readable value for each rule key. The key
 * itself stays visible beside them, because flags and the audit log cite rules by key.
 */
import { RULE_ABOUT, RULE_SOURCE } from "@ebo/core";

type Formatter = (v: unknown) => string;

const n = (v: unknown) => Number(v).toLocaleString("en", { maximumFractionDigits: 2 });
const days = (unit = "days"): Formatter => (v) => `${n(v)} ${Number(v) === 1 ? unit.replace(/s$/, "") : unit}`;
const pct: Formatter = (v) => `${n(v)}%`;
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const codes: Formatter = (v) => (Array.isArray(v) ? list(v.map(String)) : String(v));
const ROUTE: Record<string, string> = { swift: "SWIFT", wise: "Wise", payoneer: "Payoneer" };

export const RULE_GROUPS = ["Purpose codes", "Matching payments", "Certificates", "Banking channel and ESFCA", "Collections", "Registrations", "Tax", "Fraud"] as const;

export const RULES: Record<string, { name: string; group: (typeof RULE_GROUPS)[number]; format: Formatter }> = {
  "purpose_code.it_services": { name: "IT export purpose codes", group: "Purpose codes", format: codes },
  "purpose_code.non_it": { name: "Codes that mean the wrong purpose", group: "Purpose codes", format: codes },
  "tolerance.abs": { name: "Rounding tolerance", group: "Matching payments", format: (v) => `${n(v)} in the invoice currency` },
  "fee.max_unstated": {
    name: "Largest fee assumed when none is stated",
    group: "Matching payments",
    format: (v) =>
      Object.entries((v ?? {}) as Record<string, string>)
        .sort(([a], [b]) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)))
        .map(([c, x]) => `${c} ${n(x)}`)
        .join(" · "),
  },
  "fx.window_pct": { name: "Conversion window for PKR credits", group: "Matching payments", format: pct },
  "short_payment.high_pct": { name: "High-risk short payment", group: "Matching payments", format: (v) => `more than ${pct(v)} of the invoice` },
  "claim.wait_business_days": {
    name: "Wait after a client says they paid",
    group: "Matching payments",
    format: (v) =>
      `${Object.entries((v ?? {}) as Record<string, number>)
        .map(([k, x]) => `${ROUTE[k] ?? k} ${n(x)}`)
        .join(" · ")} business days`,
  },
  "fx.spread_warn_pct": { name: "Exchange-rate spread warning", group: "Matching payments", format: (v) => `${pct(v)} below the reference rate` },
  "eprc.wait_days": { name: "Wait for an ePRC after a credit", group: "Certificates", format: days() },
  "wht.wait_days": { name: "Wait for a withholding certificate", group: "Certificates", format: days() },
  "banking_share.min_pct": { name: "Minimum banking-channel share", group: "Banking channel and ESFCA", format: pct },
  "banking_share.warn_pct": { name: "Banking-channel share warning", group: "Banking channel and ESFCA", format: (v) => `below ${pct(v)}` },
  "esfca.retention": {
    name: "What an ESFCA may keep each month",
    group: "Banking channel and ESFCA",
    format: (v) => {
      const r = (v ?? {}) as { pct?: string; min_usd?: string };
      return `${n(r.pct)}% of the month's proceeds, or USD ${n(r.min_usd)} if that is more`;
    },
  },
  "overdue.reminder_days": { name: "Reminders after the due date", group: "Collections", format: (v) => (Array.isArray(v) ? `${list(v.map(String))} business days late` : String(v)) },
  "pseb.renew_notice_days": { name: "PSEB renewal reminder", group: "Registrations", format: (v) => `${days()(v)} before it lapses` },
  "atl.recheck_days": { name: "Active Taxpayers List re-check", group: "Registrations", format: (v) => `every ${days()(v)}` },
  "tax.rate.default_final": { name: "Final tax on export proceeds", group: "Tax", format: pct },
  "tax.rate.pseb_final": { name: "Final tax with PSEB registration", group: "Tax", format: pct },
  "fraud.lookalike_distance": { name: "Lookalike domain distance", group: "Fraud", format: (v) => `${n(v)} character${Number(v) === 1 ? "" : "s"} different` },
};

export const ruleName = (key: string) => RULES[key]?.name ?? key;
/** The current wording, so workspaces seeded with older text read the same. */
export const ruleAbout = (key: string, stored?: string | null) => (RULE_ABOUT as Record<string, string>)[key] ?? stored ?? "";
export const ruleSource = (key: string, stored?: string | null) => (RULE_SOURCE as Record<string, string>)[key] ?? stored ?? null;
export const ruleValue = (key: string, value: unknown) => {
  try {
    return RULES[key]?.format(value) ?? (typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return JSON.stringify(value);
  }
};
