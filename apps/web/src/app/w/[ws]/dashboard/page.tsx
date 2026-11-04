import { formatAmount, formatMoney, periodLabel, type Grouping } from "@ebo/core";
import { getDb } from "@ebo/db";
import { dashboard, loadBooks, loadContext, type CostLine } from "@ebo/engine";
import Link from "next/link";
import { BarList, ChartTable, ColumnChart, Legend, LineKey, type BarRow, type Column } from "@/components/charts";
import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { day } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Dashboard" };

/** Route names short enough for a chart row; the full ones are on invoices. */
const ROUTE_SHORT: Record<string, string> = {
  swift_esfca: "SWIFT to the ESFCA",
  swift_pkr: "SWIFT to the PKR account",
  payoneer: "Payoneer",
  wise_pkr: "Wise",
  platform: "Marketplace",
  other: "Other",
};
/** Age bands are ordered, so they take one hue from light (not due) to dark (most late). */
const AGE_COLORS = ["var(--age-1)", "var(--age-2)", "var(--age-3)", "var(--age-4)", "var(--age-5)"];
const FEES = "var(--series-1)";
const CONVERSION = "var(--series-2)";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** Whole rupees in the workspace's grouping: "PKR 816,060" or "PKR 8,16,060". */
const rupees = (x: string | number, g: Grouping) => formatMoney(x, "PKR", { grouping: g, decimals: 0 });

const UNITS: Record<Grouping, Array<[number, string]>> = {
  western: [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
  lakh: [
    [1e7, " Cr"],
    [1e5, " L"],
  ],
};

/** Three significant figures: "41.7M", or "4.17 Cr" for lakh grouping. Small amounts in full. */
function compact(x: number, g: Grouping): string {
  const units = UNITS[g];
  for (let i = 0; i < units.length; i++) {
    const [n, s] = units[i]!;
    if (Math.abs(x) < n) continue;
    const v = Number((x / n).toPrecision(3));
    const up = units[i - 1];
    if (up && Math.abs(v) * n >= up[0]) return `${Number((x / up[0]).toPrecision(3))}${up[1]}`;
    return `${v}${s}`;
  }
  return formatAmount(Math.round(x), { grouping: g, decimals: 0 });
}

/** A value axis with clean ticks, in one style: in full under 10,000, compact from there. */
function valueAxis(max: number, g: Grouping) {
  const raw = Math.max(max, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const top = Math.ceil(max / step) * step || step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const unit = UNITS[g].find(([n]) => top >= (n === 1e3 ? 1e4 : n));
  const label = (t: number) => (t === 0 ? "0" : unit ? `${Number((t / unit[0]).toPrecision(4))}${unit[1]}` : formatAmount(t, { grouping: g, decimals: 0 }));
  return { top, ticks, label };
}

const vsDue = (late: number | null) => (late == null ? "" : late < 0 ? `${plural(-late, "day")} before the due date` : late === 0 ? "on the due date" : `${plural(late, "day")} after the due date`);
const vsDueShort = (late: number | null) => (late == null ? "" : late < 0 ? `${plural(-late, "day")} early` : late === 0 ? "on time" : `${plural(late, "day")} late`);
const pctOf = (part: string, whole: string) => (Number(whole) > 0 ? (Number(part) / Number(whole)) * 100 : 0);

function costRow(r: CostLine, g: Grouping): BarRow {
  const label = ROUTE_SHORT[r.key] ?? r.label;
  const pct = r.pct == null ? "—" : `${r.pct}%`;
  const fees = pctOf(r.feesPkr, r.valuePkr);
  const conversion = pctOf(r.conversionPkr, r.valuePkr);
  const est = r.estimated ? ", estimated" : "";
  return {
    key: r.key,
    label,
    sub: plural(r.payments, "payment"),
    parts: [
      { value: fees, color: FEES },
      { value: conversion, color: CONVERSION },
    ],
    tipLabel: (
      <>
        {pct}
        {r.estimated ? <span className="text-muted"> est.</span> : null}
      </>
    ),
    aria: `${label}: ${pct} of ${rupees(r.valuePkr, g)} received in ${plural(r.payments, "payment")}. Fees ${rupees(r.feesPkr, g)}; conversion ${rupees(r.conversionPkr, g)}${est}.`,
    tip: {
      value: `${pct} of ${rupees(r.valuePkr, g)}`,
      lines: [
        <>
          <LineKey color={FEES} />
          {rupees(r.feesPkr, g)} fees ({fees.toFixed(2)}%)
        </>,
        <>
          <LineKey color={CONVERSION} />
          {rupees(r.conversionPkr, g)} conversion ({conversion.toFixed(2)}%){est}
        </>,
        `${plural(r.payments, "payment")} this tax year`,
      ],
    },
  };
}

export default async function DashboardPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const w = await loadContext(db, ws.id);
  const d = dashboard(await loadBooks(db, w), w);
  const g: Grouping = ws.numberGrouping;
  const base = `/w/${slug}`;
  const cash = (amount: string, currency: string) => formatMoney(amount, currency, { grouping: g });

  const { owed, cost, proceeds } = d;
  const oldest = owed.mostOverdue[0];
  const banked = Number(proceeds.totalPkr);
  const empty = !owed.open && !d.daysToPay.invoices && !cost.total.payments && !banked;

  // Proceeds by month: label the best month on its cap, and this month too when the two labels can't collide.
  const months = proceeds.months;
  const axis = valueAxis(Math.max(...months.map((m) => Number(m.pkr))), g);
  const thisMonth = d.today.slice(0, 7);
  const best = months.reduce((a, m, i) => (Number(m.pkr) > Number(months[a]!.pkr) ? i : a), 0);
  const now = months.findIndex((m) => m.month === thisMonth);
  const nowToo = now >= 0 && now !== best && Number(months[now]!.pkr) > 0 && (Math.abs(now - best) > 1 || (Number(months[best]!.pkr) - Number(months[now]!.pkr)) / axis.top > 0.2);
  const columns: Column[] = months.map((m, i) => {
    const when = `${periodLabel(m.month)}${m.month === thisMonth ? " so far" : ""}`;
    return {
      key: m.month,
      label: m.label,
      short: m.label.slice(0, 1),
      value: Number(m.pkr),
      future: m.future,
      capLabel: i === best || (nowToo && i === now) ? compact(Number(m.pkr), g) : undefined,
      aria: m.future ? `${periodLabel(m.month)}: still to come` : `${when}: ${rupees(m.pkr, g)} from ${plural(m.credits, "credit")}`,
      tip: { value: rupees(m.pkr, g), lines: [when, plural(m.credits, "credit")] },
    };
  });

  const hasPayoneer = cost.byRoute.some((r) => r.estimated);
  const hasEsfca = cost.byRoute.some((r) => r.key === "swift_esfca");

  return (
    <>
      <PageHeader title="Dashboard" sub={`Tax year ${d.year.label} so far, to ${day(d.today)}. Money received is in PKR at the reference rate of its day; money still owed, at today's rate.`} />

      {empty ? (
        <Empty>Nothing to show yet. Once you invoice clients and payments come in, this page shows what you're owed, how fast clients pay, and what getting paid costs.</Empty>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Owed to you"
              value={owed.open ? `PKR ${compact(Number(owed.totalPkr), g)}` : "Nothing"}
              hint={owed.open ? `${plural(owed.open, "open invoice")}, ${owed.overdue} overdue${owed.unpriced.length ? `; ${owed.unpriced.join(", ")} not counted (no rate)` : ""}` : "no open invoices"}
            />
            <Stat
              label="Overdue"
              value={owed.overdue ? `PKR ${compact(Number(owed.overduePkr), g)}` : "None"}
              tone={owed.overdue ? "warn" : "good"}
              hint={oldest ? `oldest ${plural(oldest.daysLate, "day")} late (${oldest.number})` : "every open invoice is within its terms"}
            />
            <Stat
              label="Days to get paid"
              value={d.daysToPay.medianDays != null ? plural(d.daysToPay.medianDays, "day") : "—"}
              hint={d.daysToPay.invoices ? `median of ${plural(d.daysToPay.invoices, "invoice")} paid this year, ${vsDue(d.daysToPay.medianLate)}` : "no invoices paid this tax year yet"}
            />
            <Stat
              label="Cost of getting paid"
              value={cost.total.pct != null ? `${cost.total.pct}%` : "—"}
              hint={cost.total.pct != null ? `${rupees(cost.total.costPkr, g)} in fees and conversion this year` : "no payments this tax year yet"}
            />
          </div>

          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <Card title="Owed to you, by how late it is">
              {owed.open ? (
                <>
                  <BarList
                    rows={owed.buckets.map((b, i) => {
                      const currencies = b.byCurrency.map((c) => cash(c.amount, c.currency));
                      return {
                        key: b.key,
                        label: b.label,
                        sub: b.invoices ? plural(b.invoices, "invoice") : undefined,
                        parts: [{ value: Number(b.pkr), color: AGE_COLORS[i]! }],
                        tipLabel: b.invoices ? rupees(b.pkr, g) : <span className="text-muted">none</span>,
                        aria: b.invoices ? `${b.label}: ${rupees(b.pkr, g)} on ${plural(b.invoices, "invoice")} (${currencies.join(", ")})` : `${b.label}: none`,
                        tip: b.invoices ? { value: rupees(b.pkr, g), lines: [...currencies, `${plural(b.invoices, "invoice")}, ${b.label.toLowerCase()}`] } : { value: "Nothing", lines: [b.label] },
                      };
                    })}
                  />
                  {owed.mostOverdue.length ? (
                    <div className="mt-5">
                      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Most overdue</h3>
                      <ul className="divide-y divide-line text-sm">
                        {owed.mostOverdue.map((o) => (
                          <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                            <span className="min-w-0">
                              <Link href={`${base}/invoices/${o.id}`} className="link">
                                {o.number}
                              </Link>{" "}
                              <span className="text-muted">{o.client}</span>
                            </span>
                            <span className="whitespace-nowrap tabular-nums text-ink">
                              {cash(o.balance, o.currency)} <span className="text-muted">· {plural(o.daysLate, "day")} late</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {owed.unpriced.length ? <p className="mt-3 text-xs text-muted">No reference rate for {owed.unpriced.join(", ")} today, so those amounts are left out of the PKR totals.</p> : null}
                  <ChartTable head={["How late", "Invoices", "PKR today", "In the invoice currency"]}>
                    {owed.buckets.map((b) => (
                      <tr key={b.key}>
                        <td className="whitespace-nowrap">{b.label}</td>
                        <td className="tabular-nums">{b.invoices}</td>
                        <td className="whitespace-nowrap tabular-nums">{rupees(b.pkr, g)}</td>
                        <td className="tabular-nums text-muted">{b.byCurrency.map((c) => cash(c.amount, c.currency)).join(", ") || "—"}</td>
                      </tr>
                    ))}
                  </ChartTable>
                </>
              ) : (
                <Empty>Nobody owes you anything right now.</Empty>
              )}
            </Card>

            <Card title="Cost of getting paid, by route">
              {cost.byRoute.length ? (
                <>
                  <Legend
                    items={[
                      { label: "Fees taken off payments", color: FEES },
                      { label: "Conversion below the reference rate", color: CONVERSION },
                    ]}
                  />
                  <BarList labelWidth="12rem" rows={cost.byRoute.map((r) => costRow(r, g))} />
                  <p className="mt-4 text-xs text-muted">
                    Share of what each route brought in this tax year. Fees are what banks and intermediaries kept; conversion is what was lost against the reference rate of the day.
                    {hasPayoneer ? " Payoneer's conversion is estimated: what its withdrawals lost this year, spread over the payments received in that currency." : ""}
                    {hasEsfca ? " Money kept in the ESFCA hasn't been converted, so that route shows fees only." : ""}
                  </p>
                  <ChartTable head={["Route", "Payments", "Received", "Fees", "Conversion", "Cost"]}>
                    {[...cost.byRoute, cost.total].map((r) => (
                      <tr key={r.key} className={r.key === "all" ? "font-medium" : undefined}>
                        <td className="whitespace-nowrap">{r.key === "all" ? "All routes" : (ROUTE_SHORT[r.key] ?? r.label)}</td>
                        <td className="tabular-nums">{r.payments}</td>
                        <td className="whitespace-nowrap tabular-nums">{rupees(r.valuePkr, g)}</td>
                        <td className="whitespace-nowrap tabular-nums">{rupees(r.feesPkr, g)}</td>
                        <td className="whitespace-nowrap tabular-nums">
                          {rupees(r.conversionPkr, g)}
                          {r.estimated ? <span className="text-muted"> est.</span> : null}
                        </td>
                        <td className="whitespace-nowrap tabular-nums">{r.pct == null ? "—" : `${r.pct}%`}</td>
                      </tr>
                    ))}
                  </ChartTable>
                </>
              ) : (
                <Empty>No payments this tax year yet.</Empty>
              )}
            </Card>
          </div>

          <Card title="Export proceeds banked in Pakistan, by month" className="mb-6">
            {banked > 0 ? (
              <>
                <p className="text-sm text-muted">
                  <span className="font-medium text-ink">{rupees(proceeds.totalPkr, g)}</span> so far in tax year {d.year.label}
                  {proceeds.sharePct != null ? (
                    <>
                      , with a banking-channel share of <span className="font-medium text-ink">{proceeds.sharePct}%</span> (
                      <Link href={`${base}/export`} className="link">
                        tax-year file
                      </Link>
                      )
                    </>
                  ) : null}
                  .
                </p>
                <ColumnChart columns={columns} ticks={axis.ticks} top={axis.top} tickLabel={axis.label} />
                <ChartTable head={["Month", "Credits", "PKR"]}>
                  {months
                    .filter((m) => !m.future)
                    .map((m) => (
                      <tr key={m.month}>
                        <td className="whitespace-nowrap">
                          {periodLabel(m.month)}
                          {m.month === thisMonth ? <span className="text-muted"> so far</span> : null}
                        </td>
                        <td className="tabular-nums">{m.credits}</td>
                        <td className="whitespace-nowrap tabular-nums">{rupees(m.pkr, g)}</td>
                      </tr>
                    ))}
                </ChartTable>
              </>
            ) : (
              <Empty>No export proceeds banked this tax year yet.</Empty>
            )}
          </Card>

          <Card title="Clients" pad={false}>
            {d.clients.length ? (
              <Table head={["Client", "Owed now", "Overdue", "Paid this year", "Days to pay (median)", "Cost of getting paid"]}>
                {d.clients.map((c) => (
                  <tr key={c.clientId}>
                    <td className="min-w-40">
                      <Link href={`${base}/clients/${c.clientId}`} className="link">
                        {c.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{Number(c.owedPkr) > 0 ? rupees(c.owedPkr, g) : <span className="text-muted">—</span>}</td>
                    <td>{c.overdueInvoices ? <Badge tone="amber">{plural(c.overdueInvoices, "invoice")}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="tabular-nums">{c.paidInvoices || <span className="text-muted">—</span>}</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {c.medianDaysToPay != null ? (
                        <>
                          {plural(c.medianDaysToPay, "day")}
                          <div className="text-xs text-muted">
                            terms {c.termsDays}, {vsDueShort(c.medianDaysLate)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      {c.cost?.pct != null ? (
                        <>
                          {c.cost.pct}%{c.cost.estimated ? <span className="text-muted"> est.</span> : null}
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <div className="p-4">
                <Empty>No client activity this tax year yet.</Empty>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
