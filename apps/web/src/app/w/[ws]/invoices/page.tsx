import { dateInZone, dec } from "@ebo/core";
import { client, getDb, invoice, match } from "@ebo/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Status, Table, cx } from "@/components/ui";
import { day, money } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Invoices" };

const TABS = [
  ["open", "Open"],
  ["all", "All"],
] as const;

export default async function InvoicesPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ show?: string }> }) {
  const { ws: slug } = await params;
  const { show = "open" } = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const today = dateInZone(ws.demoClock ?? new Date(), ws.timezone);
  const rows = await db
    .select({
      inv: invoice,
      client: client.name,
      applied: sql<string>`coalesce((select sum(${match.appliedAmount}) from ${match} where ${match.invoiceId} = ${invoice.id}), 0)`,
    })
    .from(invoice)
    .innerJoin(client, eq(client.id, invoice.clientId))
    .where(show === "all" ? eq(invoice.workspaceId, ws.id) : and(eq(invoice.workspaceId, ws.id), inArray(invoice.status, ["sent", "part_paid"])))
    .orderBy(desc(invoice.issuedOn), desc(invoice.number));
  const base = `/w/${slug}`;

  return (
    <>
      <PageHeader title="Invoices" sub="What clients owe, what has arrived against each invoice, and what is overdue." />
      <div className="mb-4 flex gap-1">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`${base}/invoices?show=${k}`} className={cx("rounded-lg px-3 py-1.5 text-sm", k === show ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-ink")}>
            {label}
          </Link>
        ))}
      </div>
      <Card pad={false}>
        {rows.length ? (
          <Table head={["Invoice", "Client", "Amount", "Received", "Balance", "Due", "Status"]}>
            {rows.map(({ inv, client: name, applied }) => {
              const balance = dec(inv.amount).minus(applied);
              const overdue = (inv.status === "sent" || inv.status === "part_paid") && inv.dueOn < today && balance.gt(0);
              return (
                <tr key={inv.id} className="hover:bg-canvas">
                  <td className="whitespace-nowrap">
                    <Link href={`${base}/invoices/${inv.id}`} className="font-medium text-ink hover:text-accent">
                      {inv.number}
                    </Link>
                  </td>
                  <td className="min-w-40">{name}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{money(inv.amount, inv.currency)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums text-muted">{dec(applied).gt(0) ? money(dec(applied).toFixed(2), inv.currency) : ""}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{balance.gt(0) ? money(balance.toFixed(2), inv.currency) : ""}</td>
                  <td className="whitespace-nowrap text-muted">
                    {day(inv.dueOn)} {overdue ? <Badge tone="red">overdue</Badge> : null}
                  </td>
                  <td>
                    <Status value={inv.status} label={inv.status === "part_paid" ? "part paid" : undefined} />
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No invoices here.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
