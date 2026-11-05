import { businessDaysBetween, daysBetween, formatDateLong, type IsoDate } from "./dates";
import { ev, type Evidence } from "./evidence";
import type { InvoiceForMatching, Route } from "./matching";
import { Decimal, dec, formatMoney, pct2 } from "./money";
import { isLookalikeDomain } from "./normalize";
import type { RuleKey, Rules } from "./rules";
import type { BankingShare } from "./share";

/**
 * Flag rules (data spec section 5). Pure: given a snapshot of the workspace and the
 * clock, returns every flag whose condition holds right now. The worker upserts them
 * by `key`; open flags missing from a later run are closed by that run (the follow-up step).
 */

export type FlagKind =
  | "short_payment"
  | "wrong_purpose_code"
  | "eprc_wrong_code"
  | "unconfirmed_payment_claim"
  | "overdue"
  | "missing_eprc"
  | "missing_wht_certificate"
  | "bank_detail_change"
  | "duplicate_payment"
  | "banking_share_low"
  | "pseb_renewal"
  | "atl_status"
  | "fx_spread_high"
  | "promise_broken"
  | "pseb_savings_estimate";

export type Severity = "high" | "medium" | "info";
export type SubjectType = "invoice" | "transaction" | "claim" | "compliance_item" | "workspace" | "message" | "promise";

export interface FlagCandidate {
  /** Stable identity across runs, e.g. "short_payment:invoice:<id>". */
  key: string;
  kind: FlagKind;
  severity: Severity;
  subject: { type: SubjectType; id: string };
  summary: string;
  evidence: Evidence;
  ruleKeys: RuleKey[];
}

export interface FlagSnapshot {
  today: IsoDate;
  rules: Rules;
  workspace: {
    id: string;
    kind: "company" | "freelancer";
    name: string;
    emailDomain?: string | null;
    psebRegNo?: string | null;
    psebValidUntil?: IsoDate | null;
    atlStatus: "active" | "inactive" | "unknown";
    atlCheckedOn?: IsoDate | null;
  };
  clients: Array<{ id: string; name: string }>;
  invoices: InvoiceForMatching[];
  /** Settled allocations (one row per invoice per transaction). */
  matches: Array<{
    invoiceId: string;
    transactionId: string;
    cashAmount: string;
    feeAmount: string;
    unexplainedAmount: string;
    valueDate: IsoDate;
  }>;
  transactions: Array<{
    id: string;
    kind: string;
    /** Kind of receiving account the money landed in. */
    accountKind: "pkr_account" | "esfca" | "payoneer" | "wise_pkr" | "platform";
    bankName?: string | null;
    valueDate: IsoDate;
    amount: string;
    currency: string;
    pkrAmount?: string | null;
    fxRateApplied?: string | null;
    purposeCode?: string | null;
    payerName?: string | null;
    /** Reference rate for the transaction currency on its value date, when converted. */
    referenceRate?: string | null;
  }>;
  compliance: Array<{
    id: string;
    transactionId: string;
    kind: "eprc" | "wht_certificate";
    status: "missing" | "requested" | "on_file" | "wrong_code";
    purposeCodeOnDocument?: string | null;
  }>;
  claims: Array<{ id: string; clientId: string; invoiceId: string; claimedOn: IsoDate; claimedAmount?: string | null; currency?: string | null; status: "open" | "resolved" }>;
  promises: Array<{ id: string; invoiceId: string; promisedOn: IsoDate; amount?: string | null; status: "open" | "kept" | "broken" }>;
  /** Reminders already sent per invoice, highest stage first or in any order. */
  reminders: Array<{ invoiceId: string; stage: number; sentOn: IsoDate }>;
  inboundMessages: Array<{ id: string; from: string; fromDomain: string; receivedOn: IsoDate; intent?: string | null; clientId?: string | null }>;
  duplicates: Array<{ transactionId: string; invoiceId: string }>;
  bankingShare?: BankingShare | null;
  /** Bank-channel export proceeds this tax year in PKR (freelancer PSEB estimate). */
  taxYearProceedsPkr?: string | null;
}

const routeFamily = (route: Route): "swift" | "payoneer" | "wise" =>
  route === "payoneer" || route === "platform" ? "payoneer" : route === "wise_pkr" ? "wise" : "swift";

const BANK_ACCOUNTS = new Set(["pkr_account", "esfca"]);

/**
 * Where an ePRC stands, counting one on file with a non-IT purpose code (read off the
 * certificate) as the wrong code. The flags, the tax-year file and the tax pack all use this.
 */
export function eprcStatus(c: { status: FlagSnapshot["compliance"][number]["status"]; purposeCodeOnDocument?: string | null }, r: Pick<Rules, "purpose_code.non_it">): FlagSnapshot["compliance"][number]["status"] {
  return c.status === "on_file" && !!c.purposeCodeOnDocument && r["purpose_code.non_it"].includes(c.purposeCodeOnDocument) ? "wrong_code" : c.status;
}

export function evaluateFlags(s: FlagSnapshot): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  const r = s.rules;
  const tol = dec(r["tolerance.abs"]);
  const invoiceById = new Map(s.invoices.map((i) => [i.id, i]));
  const clientName = (id: string | null | undefined) => s.clients.find((c) => c.id === id)?.name ?? "unknown client";
  const txById = new Map(s.transactions.map((t) => [t.id, t]));
  const matchesByTx = new Map<string, FlagSnapshot["matches"]>();
  for (const m of s.matches) matchesByTx.set(m.transactionId, [...(matchesByTx.get(m.transactionId) ?? []), m]);
  const nonIt = new Set(r["purpose_code.non_it"]);
  const itCode = r["purpose_code.it_services"][0] ?? "";

  // short_payment: an unexplained gap that is still open on the invoice.
  for (const m of s.matches) {
    const inv = invoiceById.get(m.invoiceId);
    if (!inv) continue;
    const unexplained = dec(m.unexplainedAmount);
    if (unexplained.lte(tol) || dec(inv.balance).lte(tol)) continue;
    const share = unexplained.div(inv.amount).times(100);
    out.push({
      key: `short_payment:invoice:${inv.id}`,
      kind: "short_payment",
      severity: share.gt(r["short_payment.high_pct"]) ? "high" : "medium",
      subject: { type: "invoice", id: inv.id },
      summary: `${clientName(inv.clientId)} paid ${formatMoney(m.cashAmount, inv.currency)} against ${inv.number} for ${formatMoney(inv.amount, inv.currency)}; ${formatMoney(unexplained, inv.currency)} is unexplained (${pct2(share)}%).`,
      evidence: {
        "client.name": ev.text(clientName(inv.clientId)),
        "invoice.number": ev.text(inv.number),
        "invoice.amount": ev.money(inv.amount, inv.currency),
        received: ev.money(m.cashAmount, inv.currency),
        fees: ev.money(m.feeAmount, inv.currency),
        difference: ev.money(unexplained, inv.currency),
        "payment.date": ev.date(m.valueDate),
        "difference.pct": ev.pct(share),
      },
      ruleKeys: ["tolerance.abs", "short_payment.high_pct"],
    });
  }

  // wrong_purpose_code / eprc_wrong_code
  const complianceByTx = new Map<string, FlagSnapshot["compliance"]>();
  for (const c of s.compliance) complianceByTx.set(c.transactionId, [...(complianceByTx.get(c.transactionId) ?? []), c]);
  for (const t of s.transactions) {
    if (!BANK_ACCOUNTS.has(t.accountKind) || !t.purposeCode || !nonIt.has(t.purposeCode)) continue;
    const matched = matchesByTx.get(t.id) ?? [];
    if (!matched.length) continue; // only payments for our (IT services) invoices
    const eprc = (complianceByTx.get(t.id) ?? []).find((c) => c.kind === "eprc");
    if (eprc && (eprc.status === "on_file" || eprc.status === "wrong_code")) continue; // too late: eprc_wrong_code below
    const inv = invoiceById.get(matched[0]!.invoiceId);
    out.push({
      key: `wrong_purpose_code:transaction:${t.id}`,
      kind: "wrong_purpose_code",
      severity: "high",
      subject: { type: "transaction", id: t.id },
      summary: `${clientName(inv?.clientId)}'s ${formatMoney(t.amount, t.currency)} payment for ${inv?.number ?? "an invoice"} arrived with purpose code ${t.purposeCode} instead of ${itCode}. No ePRC has been issued yet, so the bank can still correct it.`,
      evidence: {
        "client.name": ev.text(clientName(inv?.clientId)),
        "invoice.number": ev.text(inv?.number ?? ""),
        "payment.amount": ev.money(t.amount, t.currency),
        ...(t.pkrAmount ? { "payment.pkr": ev.money(t.pkrAmount, "PKR") } : {}),
        "payment.date": ev.date(t.valueDate),
        "payment.payer": ev.text(t.payerName ?? ""),
        "code.received": ev.text(t.purposeCode),
        "code.expected": ev.text(itCode),
        "bank.name": ev.text(t.bankName ?? ""),
      },
      ruleKeys: ["purpose_code.it_services", "purpose_code.non_it"],
    });
  }
  for (const c of s.compliance) {
    if (c.kind !== "eprc") continue;
    if (eprcStatus(c, r) !== "wrong_code") continue;
    const t = txById.get(c.transactionId);
    const inv = invoiceById.get((matchesByTx.get(c.transactionId) ?? [])[0]?.invoiceId ?? "");
    out.push({
      key: `eprc_wrong_code:compliance_item:${c.id}`,
      kind: "eprc_wrong_code",
      severity: "medium",
      subject: { type: "compliance_item", id: c.id },
      summary: `The ePRC for ${inv?.number ?? "a payment"} was issued with code ${c.purposeCodeOnDocument ?? "?"} instead of ${itCode}. Ask the bank whether it can be reissued.`,
      evidence: {
        "invoice.number": ev.text(inv?.number ?? ""),
        "payment.date": ev.date(t?.valueDate ?? s.today),
        ...(t ? { "payment.amount": ev.money(t.amount, t.currency) } : {}),
        "code.received": ev.text(c.purposeCodeOnDocument ?? ""),
        "code.expected": ev.text(itCode),
        "bank.name": ev.text(t?.bankName ?? ""),
      },
      ruleKeys: ["purpose_code.it_services", "purpose_code.non_it"],
    });
  }

  // unconfirmed_payment_claim: the client says "paid" but no credit arrived in time.
  for (const c of s.claims) {
    if (c.status !== "open") continue;
    const inv = invoiceById.get(c.invoiceId);
    if (!inv) continue;
    const paidSince = s.matches.some((m) => m.invoiceId === inv.id && m.valueDate >= c.claimedOn);
    if (paidSince || dec(inv.balance).lte(tol)) continue;
    const family = routeFamily(inv.route);
    const wait = r["claim.wait_business_days"][family] ?? 5;
    const waited = businessDaysBetween(c.claimedOn, s.today);
    if (waited < wait) continue;
    out.push({
      key: `unconfirmed_payment_claim:claim:${c.id}`,
      kind: "unconfirmed_payment_claim",
      severity: "high",
      subject: { type: "claim", id: c.id },
      summary: `${clientName(c.clientId)} said ${inv.number} was paid on ${formatDateLong(c.claimedOn)}, but no matching credit has arrived after ${waited} business days (we wait ${wait} for ${family}).`,
      evidence: {
        "client.name": ev.text(clientName(c.clientId)),
        "invoice.number": ev.text(inv.number),
        "invoice.amount": ev.money(inv.amount, inv.currency),
        "claim.date": ev.date(c.claimedOn),
        ...(c.claimedAmount ? { "claim.amount": ev.money(c.claimedAmount, c.currency ?? inv.currency) } : {}),
        "days.waited": ev.int(waited),
        "days.expected": ev.int(wait),
      },
      ruleKeys: ["claim.wait_business_days"],
    });
  }

  // overdue
  const thresholds = [...r["overdue.reminder_days"]].sort((a, b) => a - b);
  for (const inv of s.invoices) {
    if (!(inv.status === "sent" || inv.status === "part_paid") || dec(inv.balance).lte(tol) || s.today <= inv.dueOn) continue;
    const days = businessDaysBetween(inv.dueOn, s.today);
    if (days < (thresholds[0] ?? 1)) continue;
    const stage = thresholds.filter((t) => t <= days).length;
    const lastSent = Math.max(0, ...s.reminders.filter((x) => x.invoiceId === inv.id).map((x) => x.stage));
    out.push({
      key: `overdue:invoice:${inv.id}`,
      kind: "overdue",
      severity: days >= 30 ? "high" : "medium",
      subject: { type: "invoice", id: inv.id },
      summary: `${inv.number} (${clientName(inv.clientId)}) is ${days} business days overdue; ${lastSent >= stage ? `reminder ${lastSent} has been sent` : `reminder ${stage} is due${lastSent ? ` (reminder ${lastSent} was sent)` : ""}`}.`,
      evidence: {
        "client.name": ev.text(clientName(inv.clientId)),
        "invoice.number": ev.text(inv.number),
        "invoice.amount": ev.money(inv.amount, inv.currency),
        "invoice.balance": ev.money(inv.balance, inv.currency),
        "invoice.issued_on": ev.date(inv.issuedOn),
        "invoice.due_on": ev.date(inv.dueOn),
        "days.overdue": ev.int(days),
        "reminder.stage": ev.int(stage),
        "reminder.last_sent_stage": ev.int(lastSent),
      },
      ruleKeys: ["overdue.reminder_days"],
    });
  }

  // missing_eprc / missing_wht_certificate
  for (const c of s.compliance) {
    if (c.status !== "missing" && c.status !== "requested") continue;
    const t = txById.get(c.transactionId);
    if (!t) continue;
    const wait = c.kind === "eprc" ? r["eprc.wait_days"] : r["wht.wait_days"];
    const since = daysBetween(t.valueDate, s.today);
    if (since <= wait) continue;
    const inv = invoiceById.get((matchesByTx.get(t.id) ?? [])[0]?.invoiceId ?? "");
    const kind = c.kind === "eprc" ? "missing_eprc" : "missing_wht_certificate";
    const what = c.kind === "eprc" ? "ePRC" : "withholding tax certificate";
    out.push({
      key: `${kind}:compliance_item:${c.id}`,
      kind,
      severity: "medium",
      subject: { type: "compliance_item", id: c.id },
      summary: `No ${what} on file for the ${formatMoney(t.amount, t.currency)} credit of ${formatDateLong(t.valueDate)}${inv ? ` (${inv.number})` : ""}, ${since} days later${c.status === "requested" ? "; already requested" : ""}.`,
      evidence: {
        "invoice.number": ev.text(inv?.number ?? ""),
        "payment.amount": ev.money(t.amount, t.currency),
        "payment.date": ev.date(t.valueDate),
        "payment.payer": ev.text(t.payerName ?? ""),
        "bank.name": ev.text(t.bankName ?? ""),
        "days.since": ev.int(since),
        "days.expected": ev.int(wait),
      },
      ruleKeys: [c.kind === "eprc" ? "eprc.wait_days" : "wht.wait_days"],
    });
  }

  // bank_detail_change: classified intent, or a sender domain that imitates ours.
  for (const m of s.inboundMessages) {
    const lookalike = isLookalikeDomain(m.fromDomain, s.workspace.emailDomain, r["fraud.lookalike_distance"]);
    if (m.intent !== "bank_detail_change" && !lookalike) continue;
    out.push({
      key: `bank_detail_change:message:${m.id}`,
      kind: "bank_detail_change",
      severity: "high",
      subject: { type: "message", id: m.id },
      summary: lookalike
        ? `A message from ${m.from} uses a domain that imitates ${s.workspace.emailDomain}. Possible invoice fraud: our bank details have not changed.`
        : `A message from ${m.from} talks about new bank details. Our bank details have not changed; confirm with the client by phone.`,
      evidence: {
        "message.from": ev.text(m.from),
        "message.date": ev.date(m.receivedOn),
        "client.name": ev.text(clientName(m.clientId)),
        "workspace.domain": ev.text(s.workspace.emailDomain ?? ""),
      },
      ruleKeys: ["fraud.lookalike_distance"],
    });
  }

  // duplicate_payment
  for (const d of s.duplicates) {
    const t = txById.get(d.transactionId);
    const inv = invoiceById.get(d.invoiceId);
    if (!t || !inv) continue;
    out.push({
      key: `duplicate_payment:transaction:${t.id}`,
      kind: "duplicate_payment",
      severity: "medium",
      subject: { type: "transaction", id: t.id },
      summary: `${formatMoney(t.amount, t.currency)} from ${t.payerName ?? "a payer"} names ${inv.number}, which is already paid. Refund it or issue a credit note.`,
      evidence: {
        "invoice.number": ev.text(inv.number),
        "payment.amount": ev.money(t.amount, t.currency),
        "payment.date": ev.date(t.valueDate),
      },
      ruleKeys: [],
    });
  }

  // banking_share_low
  if (s.bankingShare && s.bankingShare.denominatorUsd !== "0.00") {
    const share = dec(s.bankingShare.sharePct);
    if (share.lt(r["banking_share.warn_pct"])) {
      out.push({
        key: `banking_share_low:workspace:${s.workspace.id}`,
        kind: "banking_share_low",
        severity: "high",
        subject: { type: "workspace", id: s.workspace.id },
        summary: `Only ${s.bankingShare.sharePct}% of export proceeds this tax year came through Pakistani banks (minimum ${r["banking_share.min_pct"]}%, warning below ${r["banking_share.warn_pct"]}%).`,
        evidence: {
          "share.pct": ev.pct(s.bankingShare.sharePct),
          "share.min_pct": ev.pct(r["banking_share.min_pct"]),
          "share.warn_pct": ev.pct(r["banking_share.warn_pct"]),
        },
        ruleKeys: ["banking_share.min_pct", "banking_share.warn_pct"],
      });
    }
  }

  // pseb_renewal
  if (s.workspace.psebValidUntil) {
    const left = daysBetween(s.today, s.workspace.psebValidUntil);
    if (left <= r["pseb.renew_notice_days"]) {
      out.push({
        key: `pseb_renewal:workspace:${s.workspace.id}`,
        kind: "pseb_renewal",
        severity: left < 0 ? "high" : "medium",
        subject: { type: "workspace", id: s.workspace.id },
        summary:
          left < 0
            ? `PSEB registration expired on ${formatDateLong(s.workspace.psebValidUntil)}.`
            : `PSEB registration expires on ${formatDateLong(s.workspace.psebValidUntil)}, in ${left} days. Start the renewal.`,
        evidence: { "pseb.valid_until": ev.date(s.workspace.psebValidUntil), "days.left": ev.int(left) },
        ruleKeys: ["pseb.renew_notice_days"],
      });
    }
  }

  // atl_status
  {
    const checked = s.workspace.atlCheckedOn;
    const age = checked ? daysBetween(checked, s.today) : null;
    const inactive = s.workspace.atlStatus === "inactive";
    if (inactive || age === null || age > r["atl.recheck_days"]) {
      out.push({
        key: `atl_status:workspace:${s.workspace.id}`,
        kind: "atl_status",
        severity: inactive ? "high" : "medium",
        subject: { type: "workspace", id: s.workspace.id },
        summary: inactive
          ? "The workspace is recorded as not on FBR's Active Taxpayers List."
          : age === null
            ? "ATL status has never been checked. Check it on FBR's website and record the result."
            : `ATL status was last checked ${age} days ago. Check it on FBR's website and record the result.`,
        evidence: {
          ...(checked ? { "atl.checked_on": ev.date(checked) } : {}),
          ...(age !== null ? { "days.since": ev.int(age) } : {}),
        },
        ruleKeys: ["atl.recheck_days"],
      });
    }
  }

  // fx_spread_high (info)
  for (const t of s.transactions) {
    if (!t.fxRateApplied || !t.referenceRate) continue;
    const ref = dec(t.referenceRate);
    if (ref.lte(0)) continue;
    const spread = ref.minus(t.fxRateApplied).div(ref).times(100);
    if (spread.lte(r["fx.spread_warn_pct"])) continue;
    out.push({
      key: `fx_spread_high:transaction:${t.id}`,
      kind: "fx_spread_high",
      severity: "info",
      subject: { type: "transaction", id: t.id },
      summary: `The bank converted ${formatMoney(t.amount, t.currency)} at ${t.fxRateApplied}, ${pct2(spread)}% below the reference ${t.referenceRate}.`,
      evidence: {
        "payment.amount": ev.money(t.amount, t.currency),
        "rate.bank": ev.rate(t.fxRateApplied),
        "rate.reference": ev.rate(t.referenceRate),
        "spread.pct": ev.pct(spread),
      },
      ruleKeys: ["fx.spread_warn_pct"],
    });
  }

  // promise_broken
  for (const p of s.promises) {
    if (p.status !== "open" || p.promisedOn >= s.today) continue;
    const inv = invoiceById.get(p.invoiceId);
    if (!inv || dec(inv.balance).lte(tol)) continue;
    out.push({
      key: `promise_broken:promise:${p.id}`,
      kind: "promise_broken",
      severity: "medium",
      subject: { type: "promise", id: p.id },
      summary: `${clientName(inv.clientId)} promised to pay ${inv.number} by ${formatDateLong(p.promisedOn)}; nothing has arrived.`,
      evidence: {
        "client.name": ev.text(clientName(inv.clientId)),
        "invoice.number": ev.text(inv.number),
        "invoice.balance": ev.money(inv.balance, inv.currency),
        "promise.date": ev.date(p.promisedOn),
      },
      ruleKeys: ["overdue.reminder_days"],
    });
  }

  // pseb_savings_estimate (freelancers not registered with PSEB)
  if (s.workspace.kind === "freelancer" && !s.workspace.psebRegNo && s.taxYearProceedsPkr && dec(s.taxYearProceedsPkr).gt(0)) {
    const proceeds = dec(s.taxYearProceedsPkr);
    const diffPct = dec(r["tax.rate.default_final"]).minus(r["tax.rate.pseb_final"]);
    const saving = proceeds.times(diffPct).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    out.push({
      key: `pseb_savings_estimate:workspace:${s.workspace.id}`,
      kind: "pseb_savings_estimate",
      severity: "info",
      subject: { type: "workspace", id: s.workspace.id },
      summary: `Registering with PSEB could have saved about ${formatMoney(saving, "PKR", { decimals: 0 })} this tax year (${pct2(diffPct)}% of ${formatMoney(proceeds, "PKR", { decimals: 0 })}), using rates that are not yet verified.`,
      evidence: {
        "proceeds.pkr": ev.money(proceeds, "PKR"),
        "saving.pkr": ev.money(saving, "PKR"),
        "rate.default": ev.pct(r["tax.rate.default_final"]),
        "rate.pseb": ev.pct(r["tax.rate.pseb_final"]),
      },
      ruleKeys: ["tax.rate.pseb_final", "tax.rate.default_final"],
    });
  }

  return out;
}
