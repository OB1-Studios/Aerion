// Demo data from the data spec (sections 7 and 9): Ravi Code Works and its clients.
// All names, numbers and domains are fictional.
import type { ClientIdentity, InvoiceForMatching, MatchContext, RefRate, Route } from "../src/matching";
import { rulesFrom } from "../src/rules";

export const rules = rulesFrom();

/** Simulated reference rates (PKR per unit) from data spec section 7. */
export const RATES: Record<string, string> = { USD: "281.40", GBP: "375.10", EUR: "327.60", CAD: "203.20", AUD: "184.90" };
export const refRate: RefRate = (ccy) => RATES[ccy] ?? null;

export const clients: ClientIdentity[] = [
  { clientId: "C1", name: "Northwind Analytics Inc", aliases: ["NORTHWIND ANALYTICS INC"] },
  { clientId: "C2", name: "Kestrel Mobility GmbH", aliases: [] },
  { clientId: "C3", name: "Wattle Digital Pty Ltd", aliases: [] },
  { clientId: "C4", name: "Thames Ledger Ltd", aliases: [] },
  { clientId: "C5", name: "Maplecroft Studio Inc", aliases: [] },
  { clientId: "C6", name: "Al Noor Trading FZ-LLC", aliases: [] },
  { clientId: "C7", name: "Dr. Elena Varga", aliases: [] },
  { clientId: "C8", name: "Brightlane Health LLC", aliases: [] },
  { clientId: "F-C2", name: "Tobias Lindqvist", aliases: [] },
];

const inv = (
  id: string,
  clientId: string,
  currency: string,
  amount: string,
  route: Route,
  issuedOn: string,
  dueOn: string,
): InvoiceForMatching => ({ id, number: id, clientId, currency, amount, balance: amount, route, issuedOn, dueOn, status: "sent" });

/** October invoices, all open before the demo week (data spec section 9). */
export function octoberInvoices(): InvoiceForMatching[] {
  return [
    inv("INV-2026-024", "C4", "USD", "2900.00", "swift_esfca", "2026-09-21", "2026-10-21"),
    inv("INV-2026-025", "C1", "USD", "6400.00", "swift_esfca", "2026-10-01", "2026-10-31"),
    inv("INV-2026-026", "C2", "EUR", "4250.00", "payoneer", "2026-10-01", "2026-10-31"),
    inv("INV-2026-027", "C3", "AUD", "5200.00", "payoneer", "2026-10-03", "2026-11-02"),
    inv("INV-2026-028", "C4", "USD", "3800.00", "swift_esfca", "2026-10-06", "2026-11-05"),
    inv("INV-2026-029", "C6", "USD", "7500.00", "swift_esfca", "2026-10-08", "2026-11-07"),
    inv("INV-2026-030", "C5", "CAD", "9000.00", "swift_pkr", "2026-10-10", "2026-11-09"),
    inv("INV-2026-031", "C7", "EUR", "1200.00", "wise_pkr", "2026-10-12", "2026-10-26"),
    inv("INV-2026-032", "C8", "USD", "5500.00", "swift_esfca", "2026-10-15", "2026-11-14"),
    inv("INV-AS-2026-018", "F-C2", "EUR", "600.00", "wise_pkr", "2026-10-12", "2026-10-26"),
  ];
}

export function ctx(invoices = octoberInvoices()): MatchContext {
  return { invoices, clients, rules, refRate };
}
