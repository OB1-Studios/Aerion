import { dateInZone, dec, ROUTE_LABELS, type Decimal } from "@ebo/core";
import { client, creditNote, getDb, invoice, match } from "@ebo/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { countryName } from "@/lib/forms";
import { money } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";

export const metadata = { title: "Clients" };

export default async function ClientsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const today = dateInZone(ws.demoClock ?? new Date(), ws.timezone);
  const [clients, open] = await Promise.all([
    db.select().from(client).where(eq(client.workspaceId, ws.id)).orderBy(asc(client.name)),
    db
      .select({ clientId: invoice.clientId, amount: invoice.amount, currency: invoice.currency, dueOn: invoice.dueOn, applied: sql<string>`coalesce((select sum(${match.appliedAmount}) from ${match} where ${match.invoiceId} = ${invoice.id}), 0)`, credited: sql<string>`coalesce((select sum(${creditNote.amount}) from ${creditNote} where ${creditNote.invoiceId} = ${invoice.id}), 0)` })
      .from(invoice)
      .where(and(eq(invoice.workspaceId, ws.id), inArray(invoice.status, ["sent", "part_paid"]))),
  ]);
  const owed = new Map<string, { count: number; byCcy: Map<string, Decimal>; overdueDays: number }>();
  for (const i of open) {
    const o = owed.get(i.clientId) ?? { count: 0, byCcy: new Map(), overdueDays: 0 };
    const balance = dec(i.amount).minus(i.applied).minus(i.credited);
    if (balance.lte(0)) continue;
    o.count++;
    o.byCcy.set(i.currency, (o.byCcy.get(i.currency) ?? dec(0)).plus(balance));
    if (i.dueOn < today) o.overdueDays = Math.max(o.overdueDays, Math.round((Date.parse(today) - Date.parse(i.dueOn)) / 86_400_000));
    owed.set(i.clientId, o);
  }
  const base = `/w/${slug}/clients`;

  return (
    <>
      <PageHeader
        title="Clients"
        sub="Who you invoice, what each owes, and how they usually pay."
        actions={
          canAct(role) ? (
            <Link href={`${base}/new`} className="btn btn-primary">
              New client
            </Link>
          ) : null
        }
      />
      <Card pad={false}>
        {clients.length ? (
          <Table head={["Client", "Country", "Pays in", "Usual route", "Open invoices", "Balance due", ""]}>
            {clients.map((c) => {
              const o = owed.get(c.id);
              return (
                <tr key={c.id} className="hover:bg-canvas">
                  <td className="min-w-48">
                    <Link href={`${base}/${c.id}`} className="font-medium text-ink hover:text-accent">
                      {c.name}
                    </Link>
                    {c.kind !== "business" ? <span className="ml-2 text-xs text-muted">{c.kind === "marketplace" ? "marketplace" : "person"}</span> : null}
                  </td>
                  <td className="whitespace-nowrap text-muted">{countryName(c.country) || "—"}</td>
                  <td>{c.defaultCurrency}</td>
                  <td className="text-xs text-muted">{c.preferredRoute ? ROUTE_LABELS[c.preferredRoute] : "agent suggests"}</td>
                  <td className="text-right tabular-nums">{o?.count ?? ""}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{o ? [...o.byCcy].map(([ccy, b]) => money(b.toFixed(2), ccy)).join(", ") : ""}</td>
                  <td>{o?.overdueDays ? <Badge tone="red">{o.overdueDays} days overdue</Badge> : null}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No clients yet.{canAct(role) ? " Add the first one to start invoicing." : ""}</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
