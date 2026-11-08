import { formatDateLong, nextRetainerDate, periodLabel, ROUTE_LABELS } from "@ebo/core";
import { client, clientAlias, contract, getDb, invoice, invoiceLine, match, transaction } from "@ebo/db";
import { retainerTerms, workspaceToday } from "@ebo/engine";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Empty, KeyValues, Notice, PageHeader, Status, Table, cx } from "@/components/ui";
import { countryName, CURRENCIES } from "@/lib/forms";
import { day, money, shortDay } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { addRetainerAction, stopRetainerAction } from "../../manage-actions";
import { RetainerForm } from "./retainer-form";

export const metadata = { title: "Client" };

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export default async function ClientPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ saved?: string; stopped?: string }> }) {
  const { ws: slug, id } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, id)));
  if (!c) notFound();
  const [invoices, payments, aliases, retainers, billed] = await Promise.all([
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
    db.select().from(contract).where(and(eq(contract.workspaceId, ws.id), eq(contract.clientId, c.id), eq(contract.kind, "retainer"))).orderBy(asc(contract.createdAt)),
    db
      .select({ contractId: invoiceLine.contractId, period: invoiceLine.milestoneLabel, id: invoice.id, number: invoice.number, status: invoice.status })
      .from(invoiceLine)
      .innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId))
      .where(and(eq(invoice.workspaceId, ws.id), eq(invoice.clientId, c.id), isNotNull(invoiceLine.contractId)))
      .orderBy(desc(invoiceLine.milestoneLabel)),
  ]);
  const base = `/w/${slug}`;
  const acts = canAct(role);
  const today = workspaceToday(ws);

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
      {q.stopped ? <Notice tone="green">Retainer stopped. The agent won&apos;t draft any more invoices from it.</Notice> : null}
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
                      <Status value={i.status} />
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
                    <td className="whitespace-nowrap tabular-nums text-muted">{shortDay(p.tx.valueDate)}</td>
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
          <Card title={<span id="retainers">Monthly retainer</span>} pad={false}>
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted">Each run drafts the month&apos;s invoice once the billing day comes, with the email that sends it. Both wait in the inbox for approval.</p>
              {retainers.length ? (
                <ul className="space-y-3 text-sm">
                  {retainers.map((r) => {
                    const next = nextRetainerDate(retainerTerms(r), today);
                    const last = billed.find((b) => b.contractId === r.id);
                    const ended = !next;
                    return (
                      <li key={r.id} className={cx("rounded-lg border border-line p-3", ended && "opacity-70")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">{money(r.amountOrRate, r.currency)} a month</span>
                          {ended ? <Badge tone="gray">ended</Badge> : null}
                        </div>
                        <p className="mt-0.5 text-muted">{r.description ?? "Monthly retainer"}</p>
                        <p className="mt-1 text-xs text-muted">
                          Billed on the {ordinal(r.billingDay ?? 1)}
                          {r.startsOn ? `, since ${formatDateLong(r.startsOn)}` : ""}
                          {r.endsOn ? `, until ${formatDateLong(r.endsOn)}` : ""}.
                        </p>
                        {last ? (
                          <p className="mt-1 text-xs text-muted">
                            Last invoice:{" "}
                            <Link href={`${base}/invoices/${last.id}`} className="font-medium text-accent hover:underline">
                              {last.number}
                            </Link>{" "}
                            for {periodLabel(last.period!)}
                            {last.status === "draft" ? " (a draft waiting for review)" : ""}.
                          </p>
                        ) : null}
                        {next ? (
                          <p className="mt-1 text-xs text-ink">{next <= today ? `${periodLabel(next.slice(0, 7))}'s invoice is due: the next run drafts it.` : `Next invoice drafted on ${formatDateLong(next)}.`}</p>
                        ) : null}
                        {acts && !ended ? (
                          <form action={stopRetainerAction.bind(null, slug, c.id, r.id)} className="mt-2">
                            <SubmitButton variant="secondary" pendingText="Stopping…">
                              Stop
                            </SubmitButton>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
            {acts ? (
              <div className="border-t border-line p-4">
                <h3 className="mb-3 text-sm font-medium text-ink">{retainers.some((r) => nextRetainerDate(retainerTerms(r), today)) ? "Add another retainer" : "Add a retainer"}</h3>
                <RetainerForm
                  action={addRetainerAction.bind(null, slug, c.id)}
                  currency={c.defaultCurrency}
                  currencies={CURRENCIES.includes(c.defaultCurrency) ? CURRENCIES : [c.defaultCurrency, ...CURRENCIES]}
                  today={today}
                />
              </div>
            ) : retainers.length ? null : (
              <p className="border-t border-line p-4 text-sm text-muted">No retainer. An owner or finance person can add one.</p>
            )}
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
