import { createHash } from "node:crypto";
import { formatAmount, formatMoney, type IsoDate } from "@ebo/core";

/**
 * Simulated documents (data spec section 12). Layouts are invented and every document says
 * SIMULATED. The engine's offline readers parse exactly these layouts; the model-based
 * reader gets the same text, so both can be scored against the answer key.
 */

export const SIMULATED = "SIMULATED - NOT A REAL DOCUMENT";
const RULE = "-".repeat(62);

/** 2026-10-27 -> 27-10-2026, the order Pakistani banks print. */
export const pkDate = (d: IsoDate) => d.split("-").reverse().join("-");
const groupIban = (iban: string) => iban.replace(/(.{4})/g, "$1 ").trim();
const line = (label: string, value: string) => `${label.padEnd(24)}: ${value}`;

/** Deterministic UUID-shaped tracking number. */
export function fakeUetr(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const PURPOSE_TEXT: Record<string, string> = { "9186": "IT SERVICES EXPORT", "9471": "HOME REMITTANCE" };

export interface AdviceFields {
  bankName: string;
  adviceNumber: string;
  adviceDate: IsoDate;
  valueDate: IsoDate;
  beneficiary: string;
  iban: string;
  amount: string;
  currency: string;
  pkrAmount?: string | null;
  fxRate?: string | null;
  remitter: string;
  remitterBank: string;
  remitterSwift?: string | null;
  reference?: string | null;
  chargesCode?: "OUR" | "SHA" | "BEN" | null;
  chargesAmount?: string | null;
  purposeCode: string;
  uetr?: string | null;
  corrects?: IsoDate | null;
}

export function creditAdviceText(a: AdviceFields): string {
  const na = "N/A";
  return [
    a.bankName.toUpperCase(),
    "Trade Services - Inward Remittance Credit Advice",
    SIMULATED,
    ...(a.corrects ? [`CORRECTED ADVICE - supersedes the advice issued on ${pkDate(a.corrects)}`] : []),
    RULE,
    line("Advice No.", a.adviceNumber),
    line("Advice Date", pkDate(a.adviceDate)),
    line("Value Date", pkDate(a.valueDate)),
    line("Beneficiary", a.beneficiary.toUpperCase()),
    line("Beneficiary Account", groupIban(a.iban)),
    line("Amount Remitted", formatMoney(a.amount, a.currency)),
    line("Amount Credited (PKR)", a.pkrAmount ? formatMoney(a.pkrAmount, "PKR") : na),
    line("Exchange Rate", a.fxRate ?? na),
    line("Remitter", a.remitter),
    line("Remitter Bank", a.remitterBank),
    line("Remitter SWIFT", a.remitterSwift ?? na),
    line("Ordering Ref (F70)", a.reference ?? na),
    line("Charges (F71A)", a.chargesCode ?? na),
    line("Sender's Charges (F71F)", a.chargesAmount ? formatMoney(a.chargesAmount, a.currency) : na),
    line("Purpose of Payment", `${a.purposeCode} - ${PURPOSE_TEXT[a.purposeCode] ?? "OTHER"}`),
    line("UETR", a.uetr ?? na),
    RULE,
    "This advice is computer generated and does not require a signature.",
    "",
  ].join("\n");
}

export interface EprcFields {
  bankName: string;
  certificateNumber: string;
  issueDate: IsoDate;
  exporter: string;
  ntn?: string | null;
  psebRegNo?: string | null;
  adviceNumber: string;
  valueDate: IsoDate;
  amount: string;
  currency: string;
  pkrAmount?: string | null;
  purposeCode: string;
}

export function eprcText(e: EprcFields): string {
  return [
    e.bankName.toUpperCase(),
    "Electronic Proceeds Realization Certificate (ePRC)",
    SIMULATED,
    RULE,
    line("Certificate No.", e.certificateNumber),
    line("Issue Date", pkDate(e.issueDate)),
    line("Exporter", e.exporter.toUpperCase()),
    line("NTN", e.ntn ?? "N/A"),
    line("PSEB Registration", e.psebRegNo ?? "N/A"),
    line("Advice No.", e.adviceNumber),
    line("Value Date", pkDate(e.valueDate)),
    line("Amount", formatMoney(e.amount, e.currency)),
    line("Amount (PKR)", e.pkrAmount ? formatMoney(e.pkrAmount, "PKR") : "N/A"),
    line("Purpose Code", `${e.purposeCode} - ${PURPOSE_TEXT[e.purposeCode] ?? "OTHER"}`),
    RULE,
    "",
  ].join("\n");
}

/** Payoneer activity export (simulated layout): date, description, amount, currency, status, payer, transaction_id. */
export interface PayoneerRow {
  date: IsoDate;
  description: string;
  amount: string; // negative for money out
  currency: string;
  payer?: string | null;
  transactionId: string;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function payoneerCsv(rows: PayoneerRow[]): string {
  const head = "date,description,amount,currency,status,payer,transaction_id";
  return [head, ...rows.map((r) => [r.date, r.description, r.amount, r.currency, "Completed", r.payer ?? "", r.transactionId].map(csvCell).join(","))].join("\n") + "\n";
}

/** Marketplace earnings export (simulated layout): date, type, description, client, amount, currency, reference. */
export interface MarketplaceRow {
  date: IsoDate;
  type: "earning" | "fee" | "payout";
  description: string;
  client?: string | null;
  amount: string;
  currency: string;
  reference: string;
}

export function marketplaceCsv(rows: MarketplaceRow[]): string {
  const head = "date,type,description,client,amount,currency,reference";
  return [head, ...rows.map((r) => [r.date, r.type, r.description, r.client ?? "", r.amount, r.currency, r.reference].map(csvCell).join(","))].join("\n") + "\n";
}

/** A bank SMS as pasted into the app (data spec section 11). */
export function bankSms(s: { pkrAmount: string; accountTail: string; payer: string; via: string; date: IsoDate; purposeCode: string; bankName: string }): string {
  const purpose = s.purposeCode === "9471" ? "Home Remittance" : "IT Services Export";
  return `PKR ${formatAmount(s.pkrAmount)} received in A/C ****${s.accountTail} from ${s.payer} via ${s.via} on ${pkDate(s.date)}. Purpose: ${s.purposeCode} ${purpose}. -${s.bankName.replace(/ Ltd$/, "")}`;
}

/** A client's "transfer submitted" screenshot. Generic look, not any real bank's interface. */
export function transferScreenshotSvg(s: { amount: string; currency: string; beneficiary: string; accountTail: string; date: IsoDate; reference: string }): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const [y, m, d] = s.date.split("-");
  const shown = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${Number(d)}, ${y}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="640" viewBox="0 0 390 640" font-family="Helvetica, Arial, sans-serif">
  <rect width="390" height="640" fill="#f4f6f8"/>
  <rect width="390" height="64" fill="#2b3a55"/>
  <text x="20" y="40" fill="#ffffff" font-size="18">Online Banking</text>
  <circle cx="195" cy="132" r="34" fill="#3c9d6b"/>
  <path d="M178 132 l11 11 l22 -24" stroke="#ffffff" stroke-width="6" fill="none"/>
  <text x="195" y="200" text-anchor="middle" font-size="20" fill="#1d2433">Transfer submitted</text>
  <text x="195" y="248" text-anchor="middle" font-size="30" font-weight="bold" fill="#1d2433">${esc(s.currency)} ${esc(formatAmount(s.amount))}</text>
  <rect x="20" y="280" width="350" height="230" rx="10" fill="#ffffff"/>
  <text x="36" y="314" font-size="13" fill="#6b7280">To</text>
  <text x="36" y="334" font-size="15" fill="#1d2433">${esc(s.beneficiary)}</text>
  <text x="36" y="368" font-size="13" fill="#6b7280">Account</text>
  <text x="36" y="388" font-size="15" fill="#1d2433">ending ${esc(s.accountTail)}</text>
  <text x="36" y="422" font-size="13" fill="#6b7280">Date</text>
  <text x="36" y="442" font-size="15" fill="#1d2433">${esc(shown)}</text>
  <text x="36" y="476" font-size="13" fill="#6b7280">Reference</text>
  <text x="36" y="496" font-size="15" fill="#1d2433">${esc(s.reference)}</text>
  <text x="195" y="548" text-anchor="middle" font-size="12" fill="#6b7280">International transfers can take 1 to 5 business days.</text>
  <text x="195" y="620" text-anchor="middle" font-size="11" fill="#b42318">${SIMULATED}</text>
</svg>
`;
}

/** A copy of the client's SWIFT confirmation, as a client would forward it. */
export function mt103Text(m: { reference: string; valueDate: IsoDate; currency: string; amount: string; orderingCustomer: string; senderSwift: string; beneficiaryIban: string; beneficiary: string; remittanceInfo: string; uetr: string }): string {
  const yymmdd = m.valueDate.slice(2).replace(/-/g, "");
  return [
    "MT103 Single Customer Credit Transfer (copy)",
    SIMULATED,
    RULE,
    `Sender BIC: ${m.senderSwift}`,
    `:20:${m.reference}`,
    ":23B:CRED",
    `:32A:${yymmdd}${m.currency}${m.amount.replace(".", ",")}`,
    `:50K:${m.orderingCustomer}`,
    `:59:/${m.beneficiaryIban}`,
    m.beneficiary.toUpperCase(),
    `:70:${m.remittanceInfo}`,
    ":71A:OUR",
    `UETR: ${m.uetr}`,
    RULE,
    "",
  ].join("\n");
}
