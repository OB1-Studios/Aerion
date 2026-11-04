import { DEFAULT_PURPOSE_WORDING } from "@ebo/core";
import { client, getDb } from "@ebo/db";
import { peekInvoiceNumber, workspaceToday } from "@ebo/engine";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { Field } from "@/components/form-problems";
import { Card, Empty, Notice, PageHeader } from "@/components/ui";
import { canAct, requireWorkspace } from "@/lib/session";
import { saveInvoiceAction } from "../../manage-actions";
import { InvoiceForm } from "../invoice-form";
import { cleanCurrency, CurrencySwitch, routeChoices, startingLines, UUID_RE } from "../shared";

export const metadata = { title: "New invoice" };

export default async function NewInvoicePage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ client?: string; currency?: string; lines?: string }> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const base = `/w/${slug}`;
  const db = getDb();
  const back = (
    <Link href={`${base}/invoices`} className="btn btn-secondary">
      All invoices
    </Link>
  );
  if (!canAct(role))
    return (
      <>
        <PageHeader title="New invoice" actions={back} />
        <Notice tone="amber">Your role can view invoices but not write them.</Notice>
      </>
    );

  const [c] = q.client && UUID_RE.test(q.client) ? await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, q.client))) : [];
  if (!c) {
    const clients = await db.select({ id: client.id, name: client.name, currency: client.defaultCurrency }).from(client).where(eq(client.workspaceId, ws.id)).orderBy(asc(client.name));
    return (
      <>
        <PageHeader title="New invoice" sub="Who is it for?" actions={back} />
        {q.client ? <Notice tone="amber">That client isn&apos;t in this workspace. Choose one below.</Notice> : null}
        <Card>
          {clients.length ? (
            <form method="get" className="flex flex-wrap items-end gap-3">
              <Field label="Client" className="w-full max-w-sm">
                <select name="client" required className="input w-full">
                  {clients.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.currency})
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="btn btn-primary">
                Continue
              </button>
              <Link href={`${base}/clients/new`} className="pb-2 text-sm text-accent hover:underline">
                or add a new client
              </Link>
            </form>
          ) : (
            <Empty>
              No clients yet.{" "}
              <Link href={`${base}/clients/new`} className="text-accent hover:underline">
                Add your first client
              </Link>{" "}
              and come back here.
            </Empty>
          )}
        </Card>
      </>
    );
  }

  const currency = cleanCurrency(q.currency) ?? c.defaultCurrency;
  const today = workspaceToday(ws);
  const [routes, number] = await Promise.all([routeChoices(db, ws.id, c.id, currency), peekInvoiceNumber(db, ws, today)]);
  return (
    <>
      <PageHeader title={`New invoice for ${c.name}`} sub={`It will be numbered ${number} when you save it. Nothing is sent until you choose to.`} actions={back} />
      {!c.contactEmails.length ? (
        <Notice tone="amber">
          {c.name} has no email address yet. You can still write the invoice and download the PDF;{" "}
          <Link href={`${base}/clients/${c.id}/edit`} className="underline">
            add an address
          </Link>{" "}
          before sending it from here.
        </Notice>
      ) : null}
      <Card>
        <CurrencySwitch clientId={c.id} currency={currency} also={[c.defaultCurrency]} />
        <InvoiceForm
          action={saveInvoiceAction.bind(null, slug, null)}
          initial={{ clientId: c.id, issuedOn: today, termsDays: String(c.paymentTermsDays), purposeWording: ws.settings?.purposeWording ?? DEFAULT_PURPOSE_WORDING }}
          lines={[]}
          lineCount={startingLines(q.lines)}
          routes={routes}
          currency={currency}
          submitLabel="Save the draft invoice"
        />
      </Card>
    </>
  );
}
