import { ROUTE_LABELS } from "@ebo/core";
import { client, clientAlias, getDb, invoice, match, transaction } from "@ebo/db";
import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, KeyValues, Notice, PageHeader, Status, Table } from "@/components/ui";
import { countryName } from "@/lib/forms";
import { day, money } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";

export const metadata = { title: "Client" };

export default async function ClientPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { ws: slug, id } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, id)));
  if (!c) notFound();
  const [invoices, payments, aliases] = await Promise.all([
    db.select().from(invoice).where(and(eq(invoice.workspaceId, ws.id), eq(invoice.clientId, c.id))).orderBy(desc(invoice.issuedOn), desc(invoice.number)),
    db
      .select({ tx: transaction, applied: match.appliedAmount, number: invoice.number, invoiceId: invoice.id })
      .from(match)
      .innerJoin(invoice, eq(invoice.id, match.invoiceId))
      .innerJoin(transaction, eq(transaction.id, match.transactionId))
      .where(and(eq(match.workspaceId, ws.id), eq(invoice.clientId, c.id)))
      .orderBy(desc(transaction.valueDate))
      .limit(50),
    db.select().from(clientAlias).where(eq(clientAlias.clientId, c.id)).orderBy(asc(clientAlias.alias)),
  ]);
  const base = `/w/${slug}`;
  const acts = canAct(role);

  return (
    <>
      <PageHeader
        title={c.name}
        sub={[countryName(c.country), `pays in ${c.defaultCurrency}`, `${c.paymentTermsDays} days`].filter(Boolean).join(" · ")}
        actions={
          <>
            {acts ? (
              <>
                <Link href={`${base}/invoices/new?client=${c.id}`} className="btn btn-primary">
                  New invoice
                </Link>
                <Link href={`${base}/clients/${c.id}/edit`} className="btn btn-secondary">
                  Edit
                </Link>
              </>
            ) : null}
            <Link href={`${base}/clients`} className="btn btn-secondary">
              All clients
            </Link>
          </>
        }
      />
      {q.saved ? <Notice tone="green">Saved.</Notice> : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card title="Invoices" pad={false}>
            {invoices.length ? (
              <Table head={["Invoice", "Issued", "Due", "Amount", "Status"]}>
                {invoices.map((i) => (
                  <tr key={i.id} className="hover:bg-canvas">
                    <td className="whitespace-nowrap">
                      <Link href={`${base}/invoices/${i.id}`} className="font-medium text-ink hover:text-accent">
                        {i.number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap text-muted">{day(i.issuedOn)}</td>
                    <td className="whitespace-nowrap text-muted">{day(i.dueOn)}</td>
                    <td className="whitespace-nowrap text-right tabular-nums">{money(i.amount, i.currency)}</td>
                    <td>
                      <Status value={i.status} label={i.status === "part_paid" ? "part paid" : undefined} />
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <div className="p-4">
                <Empty>No invoices yet.</Empty>
              </div>
            )}
          </Card>
          <Card title="Payments received" pad={false}>
            {payments.length ? (
              <Table head={["Value date", "Payment", "Settled", "Invoice"]}>
                {payments.map((p) => (
                  <tr key={`${p.tx.id}-${p.invoiceId}`}>
                    <td className="whitespace-nowrap tabular-nums text-muted">{p.tx.valueDate}</td>
                    <td className="whitespace-nowrap">
                      <Link href={`${base}/payments/${p.tx.id}`} className="text-ink hover:text-accent">
                        {money(p.tx.amount, p.tx.currency)}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{money(p.applied, invoices.find((i) => i.id === p.invoiceId)?.currency)}</td>
                    <td className="whitespace-nowrap">{p.number}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <div className="p-4">
                <Empty>Nothing matched to this client yet.</Empty>
              </div>
            )}
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Details">
            <KeyValues
              rows={[
                ["Kind", c.kind === "business" ? "A business" : c.kind === "individual" ? "A person" : "A marketplace"],
                ["Usual route", c.preferredRoute ? ROUTE_LABELS[c.preferredRoute] : "The agent suggests one per invoice"],
                ["Contact", c.contactName ?? "—"],
                ["Emails", c.contactEmails.length ? c.contactEmails.join(", ") : "None: add one before sending invoices"],
              ]}
            />
            {c.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-muted">{c.notes}</p> : null}
          </Card>
          <Card title="Payments arrive as">
            {aliases.length ? (
              <ul className="space-y-1 text-sm">
                {aliases.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <code className="text-xs">{a.alias}</code>
                    {a.source === "learned" ? <Badge tone="violet">learned</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No payer names yet. The agent matches by name and invoice number, and learns names as it goes.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
