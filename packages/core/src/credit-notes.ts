import { dec, formatMoney } from "./money";
import type { InvoiceStatus } from "./matching";

/**
 * Credit notes, write-offs and voids (main doc W9). Each takes money off what a client owes,
 * with a reason a person gives:
 * - a credit note is agreed with the client (a discount, a disputed hour, a mistake)
 * - a write-off is money we've stopped expecting (bad debt, bank charges the client won't cover)
 * - a void cancels an invoice that should never have stood, before any money came in
 *
 * The balance is always amount − money received − these. As in most accounting packages, an
 * invoice whose balance reaches zero this way counts as paid; only a void makes it void.
 */

export type CreditKind = "credit" | "write_off" | "void";

export const CREDIT_KINDS: CreditKind[] = ["credit", "write_off", "void"];

export const CREDIT_KIND_LABELS: Record<CreditKind, string> = { credit: "Credit note", write_off: "Write-off", void: "Void" };

/** Numbered per kind and year: CN-2026-001, WO-2026-001, VD-2026-001. */
export const CREDIT_PREFIX: Record<CreditKind, string> = { credit: "CN", write_off: "WO", void: "VD" };

export interface CreditInput {
  kind: string;
  amount: string;
  reason: string;
}

/** The invoice as it stands now. */
export interface CreditTarget {
  number: string;
  status: InvoiceStatus;
  currency: string;
  /** Money received against it so far. */
  applied: string;
  /** What's still owed: amount − received − earlier credit notes. */
  balance: string;
}

export interface CreditValue {
  kind: CreditKind;
  amount: string;
  reason: string;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** Which of the three an invoice in this state allows. */
export function creditKindsAllowed(t: Pick<CreditTarget, "status" | "applied" | "balance">): CreditKind[] {
  const owed = dec(t.balance).gt(0);
  const received = dec(t.applied).gt(0);
  if (t.status === "draft") return ["void"];
  if ((t.status === "sent" || t.status === "part_paid") && owed) return received ? ["credit", "write_off"] : ["credit", "write_off", "void"];
  return [];
}

/** Checks a credit note, write-off or void against the invoice, and returns it cleaned or what's wrong in plain words. */
export function checkCredit(input: CreditInput, t: CreditTarget): { problems: string[]; value: CreditValue | null } {
  const problems: string[] = [];
  const kind = input.kind.trim() as CreditKind;
  const reason = input.reason.trim().replace(/\s+/g, " ");
  const amount = input.amount.trim().replace(/,/g, "");
  const allowed = creditKindsAllowed(t);
  const owed = formatMoney(t.balance, t.currency);

  if (!CREDIT_KINDS.includes(kind)) problems.push("Choose a credit note, a write-off or a void.");
  else if (!allowed.includes(kind)) {
    if (t.status === "void") problems.push(`${t.number} is already void.`);
    else if (t.status === "draft") problems.push(`${t.number} hasn't been sent, so there's nothing to credit or write off. Edit it, or void it.`);
    else if (!dec(t.balance).gt(0)) problems.push(`Nothing is owed on ${t.number}.`);
    else if (kind === "void") problems.push(`Money has come in against ${t.number}, so it can't be voided. Credit or write off what's left instead.`);
    else problems.push(`${CREDIT_KIND_LABELS[kind]}s can't be made on ${t.number} as it stands.`);
  }
  if (!reason) problems.push("Say why, in a few words. It's kept with the invoice and shown to the accountant.");
  else if (reason.length > 300) problems.push("The reason is too long (300 characters at most).");

  // A void takes off everything still owed; the others take what the person says, up to that.
  let value = t.balance;
  if (kind !== "void" && allowed.includes(kind)) {
    if (!AMOUNT_RE.test(amount) || dec(amount).lte(0)) problems.push(`The amount should be more than zero, like 400 or 400.00 (in ${t.currency}).`);
    else if (dec(amount).gt(t.balance)) problems.push(`That's more than the ${owed} still owed.`);
    else value = dec(amount).toFixed(2);
  }
  if (problems.length) return { problems, value: null };
  return { problems, value: { kind, amount: value, reason } };
}

/** The invoice's status once the credit is applied. */
export function statusAfterCredit(kind: CreditKind, t: Pick<CreditTarget, "status" | "applied" | "balance">, amount: string): InvoiceStatus {
  if (kind === "void") return "void";
  if (dec(t.balance).minus(amount).lte(0)) return "paid";
  return t.status;
}

/** The next number for this kind in this year, after the ones already used. */
export function nextCreditNumber(kind: CreditKind, year: number, used: string[]): string {
  const prefix = `${CREDIT_PREFIX[kind]}-${year}-`;
  const last = used.filter((n) => n.startsWith(prefix)).reduce((max, n) => Math.max(max, Number(n.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}
