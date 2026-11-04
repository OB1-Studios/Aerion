/**
 * Who has to look at a draft before it goes out.
 *
 * "supervised" (the current Decided rule): a person approves every outgoing message.
 * "autopilot" (Proposed 2026-11-03): routine messages go out on their own, some after
 * a delay in which anyone can cancel, and people only see the exceptions.
 * Either way, a draft that fails the numbers check is never sent.
 */

/** Email templates from the build kit (section 5). */
export type TemplateKey = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10" | "T11";

export const TEMPLATE_NAMES: Record<TemplateKey, string> = {
  T1: "Overdue reminder 1",
  T2: "Overdue reminder 2",
  T3: "Overdue reminder 3 (formal, from the director)",
  T4: "Ask for the wire confirmation (MT103 / UETR)",
  T5: "Short payment breakdown",
  T6: "Purpose code correction (to the bank)",
  T7: "ePRC with the wrong code (to the bank)",
  T8: "Missing ePRCs and certificates (to the bank)",
  T9: "Our bank details have not changed",
  T10: "Promise to pay missed",
  T11: "Invoice email",
};

export type SendMode = "auto" | "delay" | "approve";
export type PolicyMode = "supervised" | "autopilot";

export interface ApprovalPolicy {
  mode: PolicyMode;
  /** Minutes a "delay" draft waits before sending, so anyone can cancel it. */
  delayMinutes: number;
  /** Per-template choices that replace the defaults below. */
  overrides?: Partial<Record<TemplateKey, SendMode>>;
  /** Above this amount (USD equivalent) a person always approves. */
  maxAutoAmountUsd?: string | null;
}

export const DEFAULT_POLICY: ApprovalPolicy = { mode: "supervised", delayMinutes: 30 };

/** Proposed autopilot defaults: routine, factual messages go out; sensitive ones wait or need a person. */
export const AUTOPILOT_DEFAULTS: Record<TemplateKey, SendMode> = {
  T1: "auto",
  T2: "auto",
  T3: "delay",
  T4: "auto",
  T5: "delay",
  T6: "auto",
  T7: "approve",
  T8: "auto",
  T9: "auto",
  T10: "delay",
  T11: "approve",
};

export interface DraftFacts {
  template: TemplateKey;
  numbersCheckOk: boolean;
  /** Placeholders the template needs that the draft lost or that have no value. */
  missingPlaceholders: string[];
  /** The recipient is a contact on file (client contacts, the bank's trade services address). */
  recipientOnFile: boolean;
  clientHasOpenDispute: boolean;
  amountUsd?: string | null;
}

export interface SendDecision {
  mode: SendMode | "blocked";
  reasons: string[];
}

export function decideSend(d: DraftFacts, p: ApprovalPolicy = DEFAULT_POLICY): SendDecision {
  if (!d.numbersCheckOk) return { mode: "blocked", reasons: ["A number in the draft doesn't match the records. Fix it before it can be sent."] };
  if (d.missingPlaceholders.length) {
    return { mode: "blocked", reasons: [`The draft is missing: ${d.missingPlaceholders.join(", ")}.`] };
  }
  if (p.mode === "supervised") return { mode: "approve", reasons: ["This workspace approves every outgoing message."] };

  const reasons: string[] = [];
  if (!d.recipientOnFile) reasons.push("The recipient isn't a contact on file.");
  if (d.clientHasOpenDispute) reasons.push("The client has an open dispute.");
  if (p.maxAutoAmountUsd && d.amountUsd && Number(d.amountUsd) > Number(p.maxAutoAmountUsd)) {
    reasons.push(`The amount is above the USD ${p.maxAutoAmountUsd} autopilot limit.`);
  }
  if (reasons.length) return { mode: "approve", reasons };

  const mode = p.overrides?.[d.template] ?? AUTOPILOT_DEFAULTS[d.template];
  const why: Record<SendMode, string> = {
    auto: `${TEMPLATE_NAMES[d.template]} is routine: sent automatically after passing every check.`,
    delay: `${TEMPLATE_NAMES[d.template]} goes out in ${p.delayMinutes} minutes unless someone cancels it.`,
    approve: `${TEMPLATE_NAMES[d.template]} always needs a person.`,
  };
  return { mode, reasons: [why[mode]] };
}
