import { DEFAULT_RULES, type RuleKey } from "@ebo/core";

/**
 * Starting rule rows (data spec section 13). Every value starts "unverified": the app shows
 * the source next to each rule and a person marks it verified once checked.
 */
const MAIN_DOC = "Main doc section 10 (rules library)";

export const RULE_DESCRIPTIONS: Record<RuleKey, { description: string; sourceTitle: string }> = {
  "tolerance.abs": { description: "Differences up to this amount are rounding, not a short payment.", sourceTitle: "Data spec section 4" },
  "fee.max_unstated": { description: "Largest gap treated as a probable intermediary fee when the advice states no charges, per currency.", sourceTitle: "Data spec section 4" },
  "fx.spread_warn_pct": { description: "Report a conversion when the bank's rate is this far below the reference rate.", sourceTitle: "Data spec section 4" },
  "fx.window_pct": { description: "How far a PKR-only credit may sit from balance x reference rate and still be a full payment (Proposed).", sourceTitle: "Data spec section 4" },
  "esfca.retention": { description: "An ESFCA may keep the greater of this many USD a month or this percent of the month's export proceeds (verify, and verify how it is measured).", sourceTitle: `${MAIN_DOC}, rule 9; SBP FECL6 annex` },
  "purpose_code.it_services": { description: "Purpose codes that mark a remittance as payment for exported IT services.", sourceTitle: `${MAIN_DOC}; find the current SBP list` },
  "purpose_code.non_it": { description: "Purpose codes that should not appear on payments for our invoices (home remittance and similar).", sourceTitle: `${MAIN_DOC}; find the current SBP list` },
  "eprc.wait_days": { description: "Days after a credit before a missing ePRC is flagged (guess; open question 5).", sourceTitle: "Interview answers pending" },
  "wht.wait_days": { description: "Days after a credit before a missing withholding certificate is flagged (guess).", sourceTitle: "Interview answers pending" },
  "claim.wait_business_days": { description: "Business days to wait for a credit after a client says they paid, per route.", sourceTitle: "Data spec section 13" },
  "overdue.reminder_days": { description: "Business days past the due date at which reminders 1, 2, 3 and the final notice are due.", sourceTitle: "Data spec section 13" },
  "banking_share.min_pct": { description: "Minimum share of export proceeds that must come through Pakistani banks (verify how it is measured).", sourceTitle: MAIN_DOC },
  "banking_share.warn_pct": { description: "Warn below this banking-channel share.", sourceTitle: MAIN_DOC },
  "pseb.renew_notice_days": { description: "Days before PSEB registration expires to start the renewal.", sourceTitle: MAIN_DOC },
  "atl.recheck_days": { description: "Days between checks of FBR's Active Taxpayers List.", sourceTitle: MAIN_DOC },
  "tax.rate.pseb_final": { description: "Final tax rate on export proceeds for PSEB-registered exporters, percent (verify).", sourceTitle: MAIN_DOC },
  "tax.rate.default_final": { description: "Final tax rate on export proceeds without PSEB registration, percent (verify).", sourceTitle: MAIN_DOC },
  "fraud.lookalike_distance": { description: "Sender domains this close to ours (edit distance) are treated as impersonation.", sourceTitle: "Build kit section 3.7" },
  "short_payment.high_pct": { description: "A short payment above this share of the invoice is high severity (Proposed).", sourceTitle: "Data spec section 5" },
};

export function globalRuleRows() {
  return (Object.keys(DEFAULT_RULES) as RuleKey[]).map((key) => ({
    workspaceId: null,
    key,
    value: DEFAULT_RULES[key] as unknown,
    description: RULE_DESCRIPTIONS[key].description,
    sourceTitle: RULE_DESCRIPTIONS[key].sourceTitle,
    status: "unverified" as const,
  }));
}
