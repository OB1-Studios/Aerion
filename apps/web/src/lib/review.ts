import type { DocumentKind } from "@ebo/db";

/** Kinds whose fields a person can check and confirm by hand; anything else is set aside or re-uploaded. */
export const REVIEW_KINDS: DocumentKind[] = ["credit_advice", "pasted_text", "eprc"];

/** The confirm form's state: what the person typed, and why it can't be applied yet. */
export interface ReviewState {
  problems: string[];
  values: Record<string, string> | null;
}

export const REVIEW_START: ReviewState = { problems: [], values: null };

const LABELS: Record<string, string> = {
  advice_number: "Advice number",
  value_date: "Value date",
  beneficiary_iban: "Credited to (IBAN)",
  beneficiary_name: "Beneficiary",
  amount: "Amount",
  currency: "Currency",
  pkr_amount: "PKR credited",
  fx_rate_applied: "Exchange rate",
  remitter_name: "Remitter (payer)",
  remitter_bank: "Remitter's bank",
  remitter_swift: "Remitter's SWIFT",
  ordering_reference: "Payment reference (F70)",
  charges_code: "Charges (OUR, SHA or BEN)",
  charges_amount: "Charges amount",
  charges_currency: "Charges currency",
  purpose_code: "Purpose code",
  purpose_description: "Purpose",
  uetr: "UETR",
  corrects_advice_of: "Corrects the advice of (value date)",
  via: "Via",
  certificate_number: "Certificate number",
  issue_date: "Issue date",
  exporter_name: "Exporter",
  pseb_number: "PSEB number",
};

export const fieldLabel = (name: string) => LABELS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const TYPE_WORDS: Record<string, string> = {
  money: "amount (like 6400.00)",
  date: "date (like 2026-10-27)",
  ccy: "currency code (like USD)",
  charges: "charges code (OUR, SHA or BEN)",
  purpose: "purpose code (4 digits)",
  iban: "account number",
  string: "value",
};

/** `amount: "abc" is not a valid money` -> `Amount: "abc" isn't a valid amount (like 6400.00).` */
export function humanProblem(p: string): string {
  const m = /^(\w+): "(.*)" is not a valid (\w+)$/.exec(p);
  return m ? `${fieldLabel(m[1]!)}: "${m[2]}" isn't a valid ${TYPE_WORDS[m[3]!] ?? m[3]}.` : p;
}
