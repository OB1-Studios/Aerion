import { addDays, formatDateLong, type IsoDate } from "./dates";
import type { Route } from "./matching";
import { Decimal, dec, formatMoney } from "./money";

/**
 * Setting up and invoicing (main doc W1, W3, W6). Pure: the route suggestion and the payment
 * instructions are built by code from the client and the workspace's accounts, never by a model.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountKind = "pkr_account" | "esfca" | "payoneer" | "wise_pkr" | "platform";

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  pkr_account: "PKR bank account",
  esfca: "Exporters' foreign currency account (ESFCA)",
  payoneer: "Payoneer",
  wise_pkr: "PKR account paid through Wise",
  platform: "Marketplace (Upwork, Fiverr…)",
};

export const compactIban = (s: string) => s.replace(/[\s-]+/g, "").toUpperCase();
export const formatIban = (s: string) => compactIban(s).replace(/(.{4})/g, "$1 ").trim();

/** ISO 13616 check: two letters, two check digits, the account; the mod-97 remainder must be 1. Null when valid. */
export function ibanProblem(input: string): string | null {
  const iban = compactIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return "doesn't look like an IBAN (two letters, two digits, then the account number)";
  if (iban.startsWith("PK") && iban.length !== 24) return "a Pakistani IBAN has 24 characters";
  const digits = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of digits) mod = (mod * 10 + Number(ch)) % 97;
  return mod === 1 ? null : "the check digits don't match, so there's probably a typo";
}

/** SWIFT/BIC: bank (4 letters), country (2), location (2), optional branch (3). */
export const swiftProblem = (s: string): string | null => (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s.trim().toUpperCase()) ? null : "a SWIFT code has 8 or 11 letters and digits, like ABCDPKKA");

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ROUTE_LABELS: Record<Route, string> = {
  swift_esfca: "Bank wire (SWIFT) to the ESFCA",
  swift_pkr: "Bank wire (SWIFT) to the PKR account",
  payoneer: "Payoneer receiving account",
  wise_pkr: "Wise, paid into the PKR account",
  platform: "Through the marketplace",
  other: "Other",
};

export interface RouteAccount {
  id: string;
  kind: AccountKind;
  label: string;
  /** The account's currency. */
  currency: string;
  /** Payoneer: the currencies it can receive. */
  currencies?: string[];
  bankName?: string | null;
  iban?: string | null;
  swift?: string | null;
  /** Free-text receiving details (Payoneer and other non-bank accounts). */
  instructions?: string | null;
  active: boolean;
}

export interface RouteClient {
  name: string;
  currency: string;
  preferredRoute?: Route | null;
  /** The last bank wire from this client that arrived short by a fee. */
  lastSwiftFee?: { amount: string; currency: string; on: IsoDate } | null;
}

export interface RouteOption {
  route: Route;
  accountId: string;
  label: string;
  reason: string;
  suggested: boolean;
}

/** Currencies Wise can send to a Pakistani PKR account (main doc rules table, item 2; verify on Wise's pages). */
const WISE_CURRENCIES = new Set(["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "AED", "SEK", "NOK", "DKK", "CHF", "NZD"]);

/**
 * The ways this client can pay into the workspace's accounts, cheapest for the client first,
 * with the suggestion marked: their usual route if it still works, otherwise the first option.
 */
export function routeOptions(client: RouteClient, accounts: RouteAccount[]): RouteOption[] {
  const ccy = client.currency.toUpperCase();
  const active = accounts.filter((a) => a.active);
  const fee = client.lastSwiftFee ? ` ${client.name}'s last bank wire lost ${formatMoney(client.lastSwiftFee.amount, client.lastSwiftFee.currency)} to fees (${formatDateLong(client.lastSwiftFee.on)}).` : "";
  const out: Omit<RouteOption, "suggested">[] = [];
  for (const a of active.filter((x) => x.kind === "payoneer" && [x.currency, ...(x.currencies ?? [])].map((c) => c.toUpperCase()).includes(ccy))) {
    out.push({ route: "payoneer", accountId: a.id, label: `${ROUTE_LABELS.payoneer} (${ccy})`, reason: `The client pays ${ccy} by a local transfer, so there are no international wire or intermediary fees.${fee} Payoneer charges when you withdraw to your bank.` });
  }
  for (const a of active.filter((x) => x.kind === "esfca" && x.currency.toUpperCase() === ccy)) {
    out.push({ route: "swift_esfca", accountId: a.id, label: `${ROUTE_LABELS.swift_esfca} (${a.currency})`, reason: `You keep the ${a.currency} and convert when the rate suits you; the bank issues the ePRC. Intermediary banks may deduct fees unless the client pays them (OUR).` });
  }
  for (const a of active.filter((x) => x.kind === "wise_pkr")) {
    if (WISE_CURRENCIES.has(ccy)) out.push({ route: "wise_pkr", accountId: a.id, label: ROUTE_LABELS.wise_pkr, reason: `Wise converts ${ccy} close to the mid-market rate and pays your PKR account. Ask the bank to report it under the IT export purpose code.` });
  }
  for (const a of active.filter((x) => x.kind === "pkr_account")) {
    out.push({ route: "swift_pkr", accountId: a.id, label: ROUTE_LABELS.swift_pkr, reason: `The bank converts on arrival at its own rate and issues the ePRC. Intermediary banks may deduct fees unless the client pays them (OUR).` });
  }
  const usual = client.preferredRoute ? out.findIndex((o) => o.route === client.preferredRoute) : -1;
  const pick = usual >= 0 ? usual : 0;
  return out.map((o, i) => ({ ...o, suggested: i === pick, reason: i === pick && usual >= 0 ? `${client.name}'s usual route. ${o.reason}` : o.reason }));
}

/** Exact payment instructions for the invoice and the email, from the account's own fields. */
export function paymentInstructions(account: RouteAccount, route: Route, payee: string, invoiceNumber: string): string[] {
  const bank = account.iban
    ? [`Beneficiary: ${payee}`, ...(account.bankName ? [`Bank: ${account.bankName}`] : []), `IBAN: ${formatIban(account.iban)}`, ...(account.swift ? [`SWIFT/BIC: ${account.swift.toUpperCase()}`] : []), `Account currency: ${account.currency}`]
    : [];
  const ref = `Payment reference: ${invoiceNumber}`;
  switch (route) {
    case "swift_esfca":
    case "swift_pkr":
      return [...bank, ref, "Please send with charges OUR, so the full amount arrives."];
    case "wise_pkr":
      return ["Pay with Wise to our PKR account:", ...bank, ref];
    default:
      return [...(account.instructions ? account.instructions.split(/\r?\n/).filter(Boolean) : bank), ref];
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/** INV-2026-033: prefix, the year it was issued, a three-digit sequence. */
export const invoiceNumber = (prefix: string, issuedOn: IsoDate, seq: number) => `${prefix}-${issuedOn.slice(0, 4)}-${String(seq).padStart(3, "0")}`;

/** The highest sequence already used for this prefix and year (so a new number never collides). */
export function highestSequence(numbers: string[], prefix: string, year: string): number {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${year}-(\\d+)$`);
  return numbers.reduce((max, n) => Math.max(max, Number(re.exec(n)?.[1] ?? 0)), 0);
}

export interface InvoiceLineInput {
  description: string;
  quantity: string;
  unitPrice: string;
}

export const lineAmount = (quantity: Decimal.Value, unitPrice: Decimal.Value) => dec(quantity).times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const invoiceTotal = (lines: InvoiceLineInput[]) => lines.reduce((t, l) => t.plus(lineAmount(l.quantity, l.unitPrice)), dec(0)).toFixed(2);

export const dueDate = (issuedOn: IsoDate, termsDays: number) => addDays(issuedOn, termsDays);

/** Default purpose wording (main doc rules table item 5: purpose code 9186 for IT services exports; verify). */
export const DEFAULT_PURPOSE_WORDING = "Payment for computer software services (IT export)";
