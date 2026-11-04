import { CREDIT_KIND_LABELS, creditKindsAllowed, dateInZone, dec, periodLabel, sumDec } from "@ebo/core";
import { client, clientClaim, creditNote, dispute, draftAction, flag, getDb, invoice, invoiceLine, invoiceReminder, match, promiseToPay, transaction, user } from "@ebo/db";
import { loadInvoiceDocument } from "@ebo/engine";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Empty, KeyValues, Notice, PageHeader, Status, Table, severityTone } from "@/components/ui";
import { clock, day, money } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { creditAction, markInvoiceSentAction, sendInvoiceAction } from "../../manage-actions";
import { CreditForm } from "./credit-form";
import { UUID_RE } from "../shared";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ saved?: string; marked?: string; error?: string; credited?: string; closed?: string; held?: string; cancelled?: string }> }) {
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
  const [lines, matches, reminders, claims, promises, disputes, flags, doc, [email], credits] = await Promise.all([
    db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, inv.id)).orderBy(asc(invoiceLine.position)),
    db.select({ m: match, tx: transaction }).from(match).innerJoin(transaction, eq(transaction.id, match.transactionId)).where(and(eq(match.workspaceId, ws.id), eq(match.invoiceId, inv.id))),
    db.select().from(invoiceReminder).where(eq(invoiceReminder.invoiceId, inv.id)).orderBy(asc(invoiceReminder.stage)),
    db.select().from(clientClaim).where(eq(clientClaim.invoiceId, inv.id)),
    db.select().from(promiseToPay).where(eq(promiseToPay.invoiceId, inv.id)),
    db.select().from(dispute).where(eq(dispute.invoiceId, inv.id)),
    db.select().from(flag).where(and(eq(flag.workspaceId, ws.id), eq(flag.subjectType, "invoice"), eq(flag.subjectId, inv.id))),
    loadInvoiceDocument(db, ws.id, inv.id),
    db.select({ id: draftAction.id, status: draftAction.status, sentAt: draftAction.sentAt, to: draftAction.toAddress }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.key, `T11:invoice:${inv.id}`))),
    db
      .select({ c: creditNote, by: user.name })
      .from(creditNote)
      .leftJoin(user, eq(user.id, creditNote.approvedBy))
      .where(and(eq(creditNote.workspaceId, ws.id), eq(creditNote.invoiceId, inv.id)))
      .orderBy(asc(creditNote.createdAt), asc(creditNote.number)),
  ]);
  const applied = sumDec(matches.map(({ m }) => m.appliedAmount));
  const credited = sumDec(credits.map(({ c }) => c.amount));
  const balance = dec(inv.amount).minus(applied).minus(credited);
  const owed = (balance.gt(0) ? balance : dec(0)).toFixed(2);
  const kinds = creditKindsAllowed({ status: inv.status, applied: applied.toFixed(2), balance: owed });
  const voided = inv.status === "void" ? credits.find(({ c }) => c.kind === "void")?.c : undefined;
  const recorded = q.credited ? credits.find(({ c }) => c.number === q.credited)?.c : undefined;
  const count = (n: string | undefined, one: string) => (Number(n) > 0 ? `${n} ${one}${n === "1" ? "" : "s"}` : "");
  const base = `/w/${slug}`;
  const pdf = `/api/w/${slug}/invoices/${inv.id}/pdf`;
  const draft = inv.status === "draft";
  const retainerLine = lines.find((l) => l.contractId && l.milestoneLabel);
  const acts = canAct(role);
  const emailWaiting = email && ["draft", "blocked", "approved", "scheduled", "sending"].includes(email.status);

  return (
    <>
      <PageHeader
        title={`${inv.number} · ${row.client.name}`}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={inv.status} label={inv.status === "part_paid" ? "part paid" : undefined} />
            <span>
              {money(inv.amount, inv.currency)} · issued {day(inv.issuedOn)} · due {day(inv.dueOn)}
            </span>
          </span>
        }
        actions={
          <>
            <a href={pdf} target="_blank" rel="noopener" className="btn btn-secondary">
              View PDF
            </a>
            <a href={`${pdf}?download=1`} className="btn btn-secondary">
              Download
            </a>
            {draft && acts ? (
              <Link href={`${base}/invoices/${inv.id}/edit`} className="btn btn-secondary">
                Edit
              </Link>
            ) : null}
            <Link href={`${base}/invoices`} className="btn btn-secondary">
              All invoices
            </Link>
          </>
        }
      />
      {q.saved ? <Notice tone="green">Saved{draft ? " as a draft. Check the PDF, then send it for approval when it looks right." : "."}</Notice> : null}
      {q.marked ? <Notice tone="green">Marked as sent. The agent now watches for the payment and will remind the client if it&apos;s late.</Notice> : null}
      {q.error ? <Notice tone="red">{q.error.slice(0, 300)}</Notice> : null}
      {recorded ? (
        <Notice tone="green">
          {CREDIT_KIND_LABELS[recorded.kind]} {recorded.number} recorded: {money(recorded.amount, inv.currency)} off.{" "}
          {inv.status === "void" ? "The invoice is void." : balance.gt(0) ? `${money(owed, inv.currency)} is still owed.` : "Nothing is owed on it now."}
          {Number(q.closed) > 0 ? ` ${count(q.closed, "flag")} about it closed.` : ""}
          {Number(q.held) > 0 ? ` ${count(q.held, "email")} waiting to go out ${q.held === "1" ? "was" : "were"} held back; the next run redrafts ${q.held === "1" ? "it" : "them"} with the new balance.` : ""}
          {Number(q.cancelled) > 0 ? ` ${count(q.cancelled, "email")} waiting to go out ${q.cancelled === "1" ? "was" : "were"} cancelled.` : ""}
        </Notice>
      ) : null}
      {voided && !recorded ? (
        <Notice tone="amber">
          Voided on {day(dateInZone(voided.createdAt, ws.timezone))} ({voided.number}): {voided.reason}
        </Notice>
      ) : null}
      {retainerLine?.milestoneLabel ? (
        <Notice tone="violet">
          {draft ? "The agent drafted this from " : "Billed under "}
          <Link href={`${base}/clients/${inv.clientId}#retainers`} className="font-medium underline">
            {row.client.name}&apos;s monthly retainer
          </Link>
          , for {periodLabel(retainerLine.milestoneLabel)}.{draft ? (email ? " Check it, then approve its email in the inbox." : " Check it, then send it for approval.") : ""}
        </Notice>
      ) : null}
      {draft && acts ? (
        <Card title="Send it" className="mb-6">
          {emailWaiting ? (
            <p className="text-sm">
              The email with this invoice is waiting in the{" "}
              <Link href={`${base}/drafts/${email.id}`} className="font-medium text-accent hover:underline">
                approval inbox
              </Link>
              . Approving it sends the email and marks the invoice as sent.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <form action={sendInvoiceAction.bind(null, slug, inv.id)}>
                <SubmitButton pendingText="Preparing…">Email it to {row.client.name}</SubmitButton>
              </form>
              <form action={markInvoiceSentAction.bind(null, slug, inv.id)}>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  I sent it another way
                </SubmitButton>
              </form>
              <p className="w-full text-xs text-muted">
                Emailing prepares the message with the PDF and the payment instructions. Nothing leaves until someone approves it in the inbox{row.client.contactEmails.length ? ` (to ${row.client.contactEmails[0]})` : ""}.
              </p>
            </div>
          )}
        </Card>
      ) : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {lines.length ? (
            <Card title="Lines" pad={false}>
              <Table dense head={["Description", "Qty", "Amount"]}>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}</td>
                    <td className="tabular-nums">{l.quantity.includes(".") ? l.quantity.replace(/\.?0+$/, "") : l.quantity}</td>
                    <td className="text-right tabular-nums">{money(l.amount, inv.currency)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}
          <Card title="Money received against it" pad={false}>
            {matches.length ? (
              <Table head={["Date", "Payment", "Settles", "Explanation"]}>
                {matches.map(({ m, tx }) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap tabular-nums text-muted">{tx.valueDate}</td>
                    <td className="whitespace-nowrap">
                      <Link href={`${base}/payments/${tx.id}`} className="text-ink hover:text-accent">
                        {money(tx.amount, tx.currency)}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{money(m.appliedAmount, inv.currency)}</td>
                    <td className="text-xs text-muted">{m.explanation[0]}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <div className="p-4">
                <Empty>Nothing received yet.</Empty>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t border-line px-4 py-3 text-sm">
              <span className="text-muted">
                Received <b className="tabular-nums text-ink">{money(applied.toFixed(2), inv.currency)}</b>
              </span>
              {credits.length ? (
                <span className="text-muted">
                  Credited, written off or voided <b className="tabular-nums text-ink">{money(credited.toFixed(2), inv.currency)}</b>
                </span>
              ) : null}
              <span className="text-muted">
                Balance <b className="tabular-nums text-ink">{money(owed, inv.currency)}</b>
              </span>
            </div>
          </Card>
          {credits.length ? (
            <Card title="Credit notes, write-offs and voids" pad={false}>
              <Table head={["Number", "Amount", "Why", "Recorded"]}>
                {credits.map(({ c, by }) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap">
                      <span className="tabular-nums">{c.number}</span>
                      <div className="text-xs text-muted">{CREDIT_KIND_LABELS[c.kind]}</div>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{money(c.amount, inv.currency)}</td>
                    <td className="min-w-48">{c.reason}</td>
                    <td className="whitespace-nowrap text-xs text-muted">
                      {clock(c.createdAt, ws.timezone)}
                      {by ? <div>by {by}</div> : null}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}
        </div>
        <div className="space-y-6">
          {doc ? (
            <Card title="How the client pays">
              <p className="mb-2 text-sm font-medium">{doc.routeLabel}</p>
              <ul className="space-y-0.5 text-sm text-muted">
                {doc.instructions.map((l) => (
                  <li key={l} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
              {inv.purposeWording ? <p className="mt-3 text-xs text-muted">Purpose of payment: &ldquo;{inv.purposeWording}&rdquo;</p> : null}
              {email?.status === "sent" ? <p className="mt-3 text-xs text-muted">Emailed to {email.to} {email.sentAt ? clock(email.sentAt, ws.timezone) : ""}.</p> : null}
            </Card>
          ) : null}
          <Card title="Client">
            <KeyValues
              rows={[
                ["Name", <Link key="c" href={`${base}/clients/${row.client.id}`} className="text-ink hover:text-accent">{row.client.name}</Link>],
                ["Contact", row.client.contactName ?? "—"],
                ["Email", row.client.contactEmails.join(", ") || "—"],
                ["Country", row.client.country ?? "—"],
                ["Terms", `${row.client.paymentTermsDays} days`],
              ]}
            />
          </Card>
          <Card title="Collections">
            <ul className="space-y-1.5 text-sm">
              {reminders.map((r) => (
                <li key={r.id}>
                  Reminder {r.stage} sent {day(r.sentOn)}
                </li>
              ))}
              {claims.map((c) => (
                <li key={c.id}>
                  Client said it was paid on {day(c.claimedOn)}
                  {c.claimedAmount ? ` (${money(c.claimedAmount, c.currency ?? inv.currency)})` : ""} <Status value={c.status} />
                </li>
              ))}
              {promises.map((p) => (
                <li key={p.id}>
                  Promised by {day(p.promisedOn)}
                  {p.amount ? ` (${money(p.amount, inv.currency)})` : ""} <Status value={p.status} />
                </li>
              ))}
              {disputes.map((d) => (
                <li key={d.id}>
                  Disputed: {d.reason} <Status value={d.status} />
                </li>
              ))}
              {!reminders.length && !claims.length && !promises.length && !disputes.length ? <li className="text-muted">No reminders, claims or promises.</li> : null}
            </ul>
          </Card>
          {acts && kinds.length ? (
            <Card title={kinds.length === 1 && kinds[0] === "void" ? "Void this invoice" : "Credit, write off or void"}>
              <CreditForm action={creditAction.bind(null, slug, inv.id)} kinds={kinds} balance={owed} owedText={money(owed, inv.currency)} currency={inv.currency} />
            </Card>
          ) : null}
          {flags.length ? (
            <Card title="Flags" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {flags.map((f) => (
                  <li key={f.id} className="px-4 py-2.5">
                    <div className="mb-1 flex gap-2">
                      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                      <Status value={f.status} />
                    </div>
                    <Link href={`${base}/flags/${f.id}`} className="text-ink hover:text-accent">
                      {f.summary}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
