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

/** Defaults overlaid with whatever the workspace's rule rows say. Unknown keys are ignored. */
export function rulesFrom(overrides: Partial<Record<string, unknown>> = {}): Rules {
  const out = structuredClone(DEFAULT_RULES) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    if (k in out && v !== undefined && v !== null) out[k] = v;
  }
  return out as Rules;
}
