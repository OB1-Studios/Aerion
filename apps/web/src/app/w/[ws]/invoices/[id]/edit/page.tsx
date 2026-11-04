import { client, getDb, invoice, invoiceLine } from "@ebo/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Notice, PageHeader } from "@/components/ui";
import { canAct, requireWorkspace } from "@/lib/session";
import { saveInvoiceAction } from "../../../manage-actions";
import { InvoiceForm } from "../../invoice-form";
import { cleanCurrency, CurrencySwitch, routeChoices, startingLines, UUID_RE } from "../../shared";

export const metadata = { title: "Edit invoice" };

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const plain = (n: string) => (n.includes(".") ? n.replace(/\.?0+$/, "") : n);

export default async function EditInvoicePage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ currency?: string; lines?: string }> }) {
  const { ws: slug, id } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  if (!UUID_RE.test(id)) notFound();
  const db = getDb();
  const [row] = await db
    .select({ inv: invoice, client })
    .from(invoice)
    .innerJoin(client, eq(client.id, invoice.clientId))
    .where(and(eq(invoice.workspaceId, ws.id), eq(invoice.id, id)));
  if (!row) notFound();
  const { inv } = row;
  const back = (
    <Link href={`/w/${slug}/invoices/${inv.id}`} className="btn btn-secondary">
      Back to the invoice
    </Link>
  );
  if (!canAct(role) || inv.status !== "draft")
    return (
      <>
        <PageHeader title={`Edit ${inv.number}`} actions={back} />
        <Notice tone="amber">{canAct(role) ? "Only a draft invoice can be changed; this one has been sent. Issue a credit note or a new invoice instead." : "Your role can view invoices but not change them."}</Notice>
      </>
    );

  const currency = cleanCurrency(q.currency) ?? inv.currency;
  const [lines, routes] = await Promise.all([db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, inv.id)).orderBy(asc(invoiceLine.position)), routeChoices(db, ws.id, row.client.id, currency)]);
  return (
    <>
      <PageHeader title={`Edit ${inv.number}`} sub={`For ${row.client.name}. It keeps its number.`} actions={back} />
      <Card>
        <CurrencySwitch clientId={row.client.id} currency={currency} also={[inv.currency, row.client.defaultCurrency]} />
        <InvoiceForm
          action={saveInvoiceAction.bind(null, slug, inv.id)}
          initial={{ clientId: row.client.id, issuedOn: inv.issuedOn, termsDays: String(days(inv.issuedOn, inv.dueOn)), route: inv.receivingAccountId ? `${inv.route}:${inv.receivingAccountId}` : "", purposeWording: inv.purposeWording ?? "" }}
          lines={lines.map((l) => ({ description: l.description, quantity: plain(l.quantity), unitPrice: l.unitPrice }))}
          lineCount={startingLines(q.lines, lines.length + 1)}
          routes={routes}
          currency={currency}
          submitLabel="Save changes"
        />
      </Card>
    </>
  );
}
