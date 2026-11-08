/**
 * Rule values the engine uses, with their starting values (data spec sections 4 and 13).
 * Every value is stored in the `rule` table with its source and verification status;
 * these defaults apply when a workspace has no row for a key. All start "unverified".
 */
export const DEFAULT_RULES = {
  "tolerance.abs": "1.00",
  "fee.max_unstated": { USD: "50", GBP: "40", EUR: "45" } as Record<string, string>,
  "fx.spread_warn_pct": "1.5",
  /** Rule 9: an ESFCA may keep the greater of this many USD a month or this share of the month's export proceeds. */
  "esfca.retention": { min_usd: "5000", pct: "50" } as { min_usd: string; pct: string },
  /** Proposed: how far a PKR-only credit may sit from balance x reference rate and still be a full payment. */
  "fx.window_pct": "3",
  "purpose_code.it_services": ["9186"] as string[],
  "purpose_code.non_it": ["9471"] as string[],
  "eprc.wait_days": 14,
  "wht.wait_days": 14,
  "claim.wait_business_days": { swift: 5, payoneer: 2, wise: 2 } as Record<string, number>,
  "overdue.reminder_days": [1, 7, 14, 30] as number[],
  "banking_share.min_pct": "80",
  "banking_share.warn_pct": "85",
  "pseb.renew_notice_days": 45,
  "atl.recheck_days": 30,
  "tax.rate.pseb_final": "0.25",
  "tax.rate.default_final": "1",
  "fraud.lookalike_distance": 2,
  /** Proposed: a short payment above this share of the invoice is high severity. */
  "short_payment.high_pct": "5",
} as const;

export type RuleKey = keyof typeof DEFAULT_RULES;

type Widen<T> = T extends string ? string : T extends number ? number : T;
export type Rules = { -readonly [K in RuleKey]: Widen<(typeof DEFAULT_RULES)[K]> };

export const RULE_KEYS = Object.keys(DEFAULT_RULES) as RuleKey[];

/** What each rule decides, in words a business owner can check against their bank or adviser. */
export const RULE_ABOUT: Record<RuleKey, string> = {
  "tolerance.abs": "Differences up to this amount are rounding, not a short payment.",
  "fee.max_unstated": "When a bank advice states no charges, a gap up to this size is treated as a likely intermediary fee.",
  "fx.spread_warn_pct": "A conversion is reported when the bank's rate is this far below the reference rate.",
  "esfca.retention": "An ESFCA may keep the greater of this share of the month's export proceeds or this many US dollars. Confirm the current limit with your bank.",
  "fx.window_pct": "How far a PKR credit may differ from the balance at the reference rate and still settle the invoice in full.",
  "purpose_code.it_services": "Purpose codes that mark a remittance as payment for exported IT services.",
  "purpose_code.non_it": "Codes that should not appear on payments for your invoices, such as home remittance.",
  "eprc.wait_days": "Days after a credit before a missing ePRC is flagged. A starting estimate: banks differ.",
  "wht.wait_days": "Days after a credit before a missing withholding certificate is flagged. A starting estimate: banks differ.",
  "claim.wait_business_days": "How long to wait for the money after a client says they've paid, by route, before asking for the wire confirmation.",
  "overdue.reminder_days": "Business days after the due date when reminders 1, 2 and 3 and the final notice are due.",
  "banking_share.min_pct": "Minimum share of export proceeds that must arrive through Pakistani banks. Confirm with your adviser how it is measured.",
  "banking_share.warn_pct": "Aerion warns when the banking-channel share drops below this.",
  "pseb.renew_notice_days": "Days before the PSEB registration expires to start the renewal.",
  "atl.recheck_days": "How often to re-check FBR's Active Taxpayers List.",
  "tax.rate.pseb_final": "Final tax rate on export proceeds for PSEB-registered exporters. Confirm with your tax adviser.",
  "tax.rate.default_final": "Final tax rate on export proceeds without PSEB registration. Confirm with your tax adviser.",
  "fraud.lookalike_distance": "Sender domains this close to yours (by edit distance) are treated as possible impersonation.",
  "short_payment.high_pct": "A short payment larger than this share of the invoice is raised as high severity.",
};

/** Where each starting value comes from. Product defaults are Aerion's own; the rest point at the law or the bank. */
const DEFAULT = "Aerion default";
export const RULE_SOURCE: Record<RuleKey, string> = {
  "tolerance.abs": DEFAULT,
  "fee.max_unstated": DEFAULT,
  "fx.spread_warn_pct": DEFAULT,
  "fx.window_pct": DEFAULT,
  "esfca.retention": "SBP foreign exchange rules for ESFCAs; confirm the current limit with your bank",
  "purpose_code.it_services": "SBP purpose codes; confirm the current list with your bank",
  "purpose_code.non_it": "SBP purpose codes; confirm the current list with your bank",
  "eprc.wait_days": `${DEFAULT} (an estimate)`,
  "wht.wait_days": `${DEFAULT} (an estimate)`,
  "claim.wait_business_days": DEFAULT,
  "overdue.reminder_days": DEFAULT,
  "banking_share.min_pct": "Pakistani tax rules for IT exports; confirm with your adviser",
  "banking_share.warn_pct": DEFAULT,
  "pseb.renew_notice_days": DEFAULT,
  "atl.recheck_days": DEFAULT,
  "tax.rate.pseb_final": "Pakistani income tax law; confirm the current rate with your adviser",
  "tax.rate.default_final": "Pakistani income tax law; confirm the current rate with your adviser",
  "fraud.lookalike_distance": DEFAULT,
  "short_payment.high_pct": DEFAULT,
};

/** Defaults overlaid with whatever the workspace's rule rows say. Unknown keys are ignored. */
export function rulesFrom(overrides: Partial<Record<string, unknown>> = {}): Rules {
  const out = structuredClone(DEFAULT_RULES) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    if (k in out && v !== undefined && v !== null) out[k] = v;
  }
  return out as Rules;
}
