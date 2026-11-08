import { dateInZone, daysBetween, dec, formatMoney } from "@ebo/core";
import { client, getDb, invoice } from "@ebo/db";
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Status, Table, Tabs } from "@/components/ui";
import { appliedToInvoice, creditedOnInvoice } from "@/lib/balances";
import { day, money, shortDay } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";

export const metadata = { title: "Invoices" };

const TABS = [
  ["open", "Open"],
  ["overdue", "Overdue"],
  ["drafts", "Drafts"],
  ["all", "All"],
] as const;
type Show = (typeof TABS)[number][0];

export default async function InvoicesPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ show?: string; q?: string }> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const show: Show = TABS.some(([k]) => k === sp.show) ? (sp.show as Show) : "open";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const today = dateInZone(ws.demoClock ?? new Date(), ws.timezone);
  const conditions: SQL[] = [eq(invoice.workspaceId, ws.id)];
  if (show === "drafts") conditions.push(eq(invoice.status, "draft"));
  else if (show !== "all") conditions.push(inArray(invoice.status, ["sent", "part_paid"]));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(invoice.number, like), ilike(client.name, like))!);
  }
  const rows = (
    await db
      .select({
        inv: invoice,
        client: client.name,
        applied: appliedToInvoice,
        credited: creditedOnInvoice,
      })
      .from(invoice)
      .innerJoin(client, eq(client.id, invoice.clientId))
      .where(and(...conditions))
      .orderBy(desc(invoice.issuedOn), desc(invoice.number))
  ).map((r) => {
    const balance = dec(r.inv.amount).minus(r.inv.paidBeforeImport).minus(r.applied).minus(r.credited);
    const late = (r.inv.status === "sent" || r.inv.status === "part_paid") && balance.gt(0) ? daysBetween(r.inv.dueOn, today) : null;
    return { ...r, balance, late };
  });
  const list = show === "overdue" ? rows.filter((r) => r.late != null && r.late > 0).sort((a, b) => b.late! - a.late!) : rows;
  // What's still owed on the rows shown, per currency: amounts in different currencies aren't added up.
  const owed = new Map<string, ReturnType<typeof dec>>();
  for (const r of list) if (r.balance.gt(0) && r.inv.status !== "draft" && r.inv.status !== "void") owed.set(r.inv.currency, (owed.get(r.inv.currency) ?? dec(0)).plus(r.balance));
  const base = `/w/${slug}`;
  const href = (k: Show) => `${base}/invoices?show=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      <PageHeader
        eyebrow="Receivables"
        title="Invoices"
        sub="What clients owe, what has arrived against each invoice, and what is overdue."
        actions={
          canAct(role) ? (
            <>
              <Link href={`${base}/import#invoices`} className="btn btn-secondary">
                Import
              </Link>
              <Link href={`${base}/invoices/new`} className="btn btn-primary">
                New invoice
              </Link>
            </>
          ) : null
        }
      />
      <div className="flex flex-wrap items-start justify-between gap-x-4">
        <Tabs items={TABS.map(([k, label]) => ({ href: href(k), label, active: k === show, count: k === show ? list.length : undefined }))} />
        <form method="get" className="mb-4 flex w-full gap-2 sm:w-auto">
          <input type="hidden" name="show" value={show} />
          <input name="q" defaultValue={q} type="search" placeholder="Invoice number or client" aria-label="Search invoices" className="input min-w-0 flex-1 sm:w-64" />
          <button className="btn btn-secondary">Search</button>
        </form>
      </div>
      <Card pad={false}>
        {list.length ? (
          <>
            <Table num={[2, 3, 4]} phoneHidden={[1, 2, 3, 4, 5, 6]} head={["Invoice", "Client", "Amount", "Received", "Balance", "Due", "Status"]}>
              {list.map(({ inv, client: name, applied, balance, late }) => (
                <tr key={inv.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`${base}/invoices/${inv.id}`} className="font-medium text-ink hover:text-accent">
                      {inv.number}
                    </Link>
                    <div className="mt-0.5 space-y-1 whitespace-normal sm:hidden">
                      <div className="text-xs text-muted">
                        {name}
                        {inv.dueOn ? ` · due ${shortDay(inv.dueOn)}` : ""}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="whitespace-nowrap text-sm font-medium tabular-nums text-ink">{balance.gt(0) ? `${money(balance.toFixed(2), inv.currency)} owed` : money(inv.amount, inv.currency)}</span>
                        <Status value={inv.status} label={inv.status === "part_paid" ? "Part paid" : undefined} />
                        {late != null && late > 0 ? <Badge tone="red">{late} day{late === 1 ? "" : "s"} late</Badge> : late === 0 ? <Badge tone="amber">Due today</Badge> : null}
                      </div>
                    </div>
                  </td>
                  <td className="min-w-40">{name}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{money(inv.amount, inv.currency)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums text-muted">{dec(applied).gt(0) ? money(dec(applied).toFixed(2), inv.currency) : "—"}</td>
                  <td className="whitespace-nowrap text-right font-medium tabular-nums">{balance.gt(0) ? money(balance.toFixed(2), inv.currency) : <span className="font-normal text-muted">—</span>}</td>
                  <td className="whitespace-nowrap">
                    <span className="text-muted">{day(inv.dueOn)}</span>{" "}
                    {late != null && late > 0 ? <Badge tone="red">{late} day{late === 1 ? "" : "s"} late</Badge> : late === 0 ? <Badge tone="amber">Due today</Badge> : null}
                  </td>
                  <td>
                    <Status value={inv.status} label={inv.status === "part_paid" ? "Part paid" : undefined} />
                  </td>
                </tr>
              ))}
            </Table>
            {owed.size ? (
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line bg-sunken px-4 py-2.5 text-sm">
                <span className="text-muted">
                  Still owed on {list.length === 1 ? "this invoice" : `these ${list.length} invoices`}
                </span>
                <span className="font-medium tabular-nums text-ink">{[...owed].map(([c, v]) => formatMoney(v.toFixed(2), c, { grouping: ws.numberGrouping })).join(" · ")}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="p-4">
            <Empty
              action={
                q ? (
                  <Link href={href(show)} className="link text-sm">
                    Clear the search
                  </Link>
                ) : show === "open" && canAct(role) ? (
                  <Link href={`${base}/invoices/new`} className="btn btn-primary">
                    Write an invoice
                  </Link>
                ) : null
              }
            >
              {q ? `No invoices match “${q}”.` : show === "drafts" ? "No draft invoices." : show === "overdue" ? "Nothing is overdue." : "No invoices here."}
            </Empty>
          </div>
        )}
      </Card>
    </>
  );
}
