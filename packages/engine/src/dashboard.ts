import { daysBetween, dec, fixed2, MONTH_NAMES, ROUTE_LABELS, taxYearOf, type Decimal, type IsoDate, type Route } from "@ebo/core";
import { flagSnapshot, taxYearCredits, type Books } from "./books";
import type { WorkspaceContext } from "./context";

/**
 * The dashboard (main doc W26), from the same books and reference rates as the weekly run:
 * what clients owe by age, how long they take to pay, what getting paid costs by route and by
 * client (fees, plus conversion below the reference rate), and export proceeds by month.
 * Money received is valued in PKR at the reference rate of its value date; money still owed
 * at today's. Everything except "owed now" covers the tax year so far.
 */

export const AGE_BUCKETS = [
  { key: "current", label: "Not due yet", min: -Infinity, max: 0 },
  { key: "1-30", label: "1–30 days late", min: 1, max: 30 },
  { key: "31-60", label: "31–60 days late", min: 31, max: 60 },
  { key: "61-90", label: "61–90 days late", min: 61, max: 90 },
  { key: "90+", label: "Over 90 days late", min: 91, max: Infinity },
] as const;

export interface CostLine {
  key: string;
  label: string;
  payments: number;
  /** What the payments settled, in PKR at the reference rate. */
  valuePkr: string;
  /** Bank and intermediary charges taken off the payments. */
  feesPkr: string;
  /** PKR lost converting below the reference rate: at the bank, or when withdrawing from a wallet. */
  conversionPkr: string;
  costPkr: string;
  /** Cost as a share of value, in percent; null when nothing was received. */
  pct: string | null;
  /** Part of the conversion is estimated from the wallet's withdrawals (Payoneer). */
  estimated: boolean;
}

export interface ClientLine {
  clientId: string;
  name: string;
  owedPkr: string;
  overdueInvoices: number;
  paidInvoices: number;
  medianDaysToPay: number | null;
  medianDaysLate: number | null;
  termsDays: number;
  cost: CostLine | null;
}

export interface Dashboard {
  today: IsoDate;
  year: { start: IsoDate; end: IsoDate; label: string };
  owed: {
    totalPkr: string;
    overduePkr: string;
    open: number;
    overdue: number;
    buckets: Array<{ key: string; label: string; invoices: number; pkr: string; byCurrency: Array<{ currency: string; amount: string }> }>;
    mostOverdue: Array<{ id: string; number: string; client: string; balance: string; currency: string; daysLate: number }>;
    /** Currencies without a reference rate, left out of the PKR totals. */
    unpriced: string[];
  };
  daysToPay: { invoices: number; medianDays: number | null; medianLate: number | null };
  cost: { total: CostLine; byRoute: CostLine[] };
  proceeds: { totalPkr: string; months: Array<{ month: string; label: string; pkr: string; credits: number; future: boolean }>; sharePct: string | null };
  clients: ClientLine[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
};

const nextMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
};

interface CostAgg {
  payments: number;
  value: Decimal;
  fees: Decimal;
  conversion: Decimal;
  estimated: boolean;
}

const costLine = (key: string, label: string, a: CostAgg): CostLine => {
  const cost = a.fees.plus(a.conversion);
  return {
    key,
    label,
    payments: a.payments,
    valuePkr: fixed2(a.value),
    feesPkr: fixed2(a.fees),
    conversionPkr: fixed2(a.conversion),
    costPkr: fixed2(cost),
    pct: a.value.gt(0) ? cost.div(a.value).times(100).toFixed(2) : null,
    estimated: a.estimated,
  };
};

export function dashboard(b: Books, w: WorkspaceContext): Dashboard {
  const { today, refRate } = w;
  const year = taxYearOf(today, w.ws.fiscalYearStartMonth);
  const inYear = (d: string) => d >= year.start && d <= today;
  const clientById = new Map(b.clients.map((c) => [c.id, c]));
  const txById = new Map(b.transactions.map((t) => [t.id, t]));
  const invoiceById = new Map(b.invoices.map((i) => [i.id, i]));
  const toPkr = (amount: Decimal.Value, currency: string, date: IsoDate): Decimal | null => {
    const r = refRate(currency, date);
    return r == null ? null : dec(amount).times(r);
  };

  // What clients owe now, by how late it is (today's reference rates).
  const buckets = AGE_BUCKETS.map((k) => ({ ...k, invoices: 0, pkr: dec(0), byCurrency: new Map<string, Decimal>() }));
  const unpriced = new Set<string>();
  const owedByClient = new Map<string, Decimal>();
  const overdueByClient = new Map<string, number>();
  const overdue: Dashboard["owed"]["mostOverdue"] = [];
  const open = b.invoices.filter((i) => (i.status === "sent" || i.status === "part_paid") && dec(i.balance).gt(0));
  for (const i of open) {
    const late = daysBetween(i.dueOn, today);
    const bucket = buckets.find((k) => late >= k.min && late <= k.max)!;
    bucket.invoices++;
    bucket.byCurrency.set(i.currency, (bucket.byCurrency.get(i.currency) ?? dec(0)).plus(i.balance));
    const pkr = toPkr(i.balance, i.currency, today);
    if (pkr) {
      bucket.pkr = bucket.pkr.plus(pkr);
      owedByClient.set(i.clientId, (owedByClient.get(i.clientId) ?? dec(0)).plus(pkr));
    } else unpriced.add(i.currency);
    if (late > 0) {
      overdue.push({ id: i.id, number: i.number, client: clientById.get(i.clientId)?.name ?? "", balance: i.balance, currency: i.currency, daysLate: late });
      overdueByClient.set(i.clientId, (overdueByClient.get(i.clientId) ?? 0) + 1);
    }
  }
  const total = buckets.reduce((s, k) => s.plus(k.pkr), dec(0));

  // How long invoices took to get paid: those whose last payment arrived this tax year.
  const paidOn = new Map<string, IsoDate>();
  for (const m of b.matches) {
    const t = txById.get(m.transactionId);
    if (!t) continue;
    const prev = paidOn.get(m.invoiceId);
    if (!prev || t.valueDate > prev) paidOn.set(m.invoiceId, t.valueDate);
  }
  const paid = b.invoices.flatMap((i) => {
    const on = paidOn.get(i.id);
    return i.status === "paid" && on && inYear(on) ? [{ clientId: i.clientId, days: daysBetween(i.issuedOn, on), late: daysBetween(i.dueOn, on) }] : [];
  });

  // What getting paid cost. Wallet withdrawals first: the conversion rate lost per currency,
  // which is then charged to the wallet receipts in that currency (an estimate, since the
  // wallet pools money from several payers before it's withdrawn).
  const withdrawn = new Map<string, { value: Decimal; loss: Decimal }>();
  for (const t of b.transactions) {
    if (t.kind !== "payoneer_withdrawal" || !t.pkrAmount || !inYear(t.valueDate)) continue;
    const value = toPkr(t.amount, t.currency, t.valueDate);
    if (!value) continue;
    const s = withdrawn.get(t.currency) ?? { value: dec(0), loss: dec(0) };
    withdrawn.set(t.currency, { value: s.value.plus(value), loss: s.loss.plus(value.minus(t.pkrAmount)) });
  }
  const lossRate = (currency: string) => {
    const s = withdrawn.get(currency);
    return s && s.value.gt(0) ? s.loss.div(s.value) : null;
  };
  const empty = (): CostAgg => ({ payments: 0, value: dec(0), fees: dec(0), conversion: dec(0), estimated: false });
  const byRoute = new Map<Route, CostAgg>();
  const byClient = new Map<string, CostAgg>();
  const all = empty();
  for (const m of b.matches) {
    const t = txById.get(m.transactionId);
    const i = invoiceById.get(m.invoiceId);
    if (!t || !i || !inYear(t.valueDate)) continue;
    const rate = refRate(i.currency, t.valueDate);
    if (rate == null) {
      unpriced.add(i.currency);
      continue;
    }
    const value = dec(m.appliedAmount).times(rate);
    const fees = dec(m.feeAmount).times(rate);
    let conversion = m.fxDifference != null ? dec(m.fxDifference).neg() : dec(0);
    let estimated = false;
    const walletLoss = t.kind === "payoneer_receipt" ? lossRate(t.currency) : null;
    if (walletLoss) {
      conversion = conversion.plus(dec(m.cashAmount).times(rate).times(walletLoss));
      estimated = true;
    }
    for (const agg of [all, byRoute.get(i.route) ?? byRoute.set(i.route, empty()).get(i.route)!, byClient.get(i.clientId) ?? byClient.set(i.clientId, empty()).get(i.clientId)!]) {
      agg.payments++;
      agg.value = agg.value.plus(value);
      agg.fees = agg.fees.plus(fees);
      agg.conversion = agg.conversion.plus(conversion);
      agg.estimated ||= estimated;
    }
  }
  const routes = [...byRoute].map(([r, a]) => costLine(r, ROUTE_LABELS[r], a)).sort((x, y) => Number(y.pct ?? 0) - Number(x.pct ?? 0) || x.label.localeCompare(y.label));

  // Export proceeds by month, the same credits the PSEB estimate and the share use.
  const months: Dashboard["proceeds"]["months"] = [];
  for (let m = year.start.slice(0, 7); m <= year.end.slice(0, 7); m = nextMonth(m)) {
    months.push({ month: m, label: MONTH_NAMES[Number(m.slice(5, 7)) - 1]!.slice(0, 3), pkr: "0.00", credits: 0, future: `${m}-01` > today });
  }
  let proceeds = dec(0);
  for (const { t, pkr } of taxYearCredits(b, w)) {
    const month = months.find((x) => x.month === t.valueDate.slice(0, 7));
    if (!month) continue;
    month.pkr = fixed2(dec(month.pkr).plus(pkr));
    month.credits++;
    proceeds = proceeds.plus(pkr);
  }
  const share = flagSnapshot(b, w).bankingShare;

  const clientIds = new Set([...owedByClient.keys(), ...byClient.keys(), ...paid.map((p) => p.clientId), ...overdueByClient.keys()]);
  const clients: ClientLine[] = [...clientIds].flatMap((id) => {
    const c = clientById.get(id);
    if (!c) return [];
    const theirs = paid.filter((p) => p.clientId === id);
    const agg = byClient.get(id);
    return [
      {
        clientId: id,
        name: c.name,
        owedPkr: fixed2(owedByClient.get(id) ?? 0),
        overdueInvoices: overdueByClient.get(id) ?? 0,
        paidInvoices: theirs.length,
        medianDaysToPay: median(theirs.map((p) => p.days)),
        medianDaysLate: median(theirs.map((p) => p.late)),
        termsDays: c.paymentTermsDays,
        cost: agg ? costLine(id, c.name, agg) : null,
      },
    ];
  });
  clients.sort((x, y) => Number(y.owedPkr) - Number(x.owedPkr) || x.name.localeCompare(y.name));

  return {
    today,
    year,
    owed: {
      totalPkr: fixed2(total),
      overduePkr: fixed2(total.minus(buckets[0]!.pkr)),
      open: open.length,
      overdue: overdue.length,
      buckets: buckets.map((k) => ({ key: k.key, label: k.label, invoices: k.invoices, pkr: fixed2(k.pkr), byCurrency: [...k.byCurrency].sort().map(([currency, amount]) => ({ currency, amount: fixed2(amount) })) })),
      mostOverdue: overdue.sort((x, y) => y.daysLate - x.daysLate).slice(0, 5),
      unpriced: [...unpriced].sort(),
    },
    daysToPay: { invoices: paid.length, medianDays: median(paid.map((p) => p.days)), medianLate: median(paid.map((p) => p.late)) },
    cost: { total: costLine("all", "All payments", all), byRoute: routes },
    proceeds: { totalPkr: fixed2(proceeds), months, sharePct: share?.sharePct ?? null },
    clients,
  };
}
