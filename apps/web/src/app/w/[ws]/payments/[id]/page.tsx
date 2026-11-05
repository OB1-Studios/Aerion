import { eprcStatus } from "@ebo/core";
import { complianceItem, document, flag, getDb, invoice, match, receivingAccount, transaction, transferLink } from "@ebo/db";
import { loadRules } from "@ebo/engine";
import { and, eq, or } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, KeyValues, PageHeader, Status, severityTone } from "@/components/ui";
import { day, humanize, money } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const [row] = await db
    .select({ tx: transaction, account: receivingAccount })
    .from(transaction)
    .leftJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
    .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.id, id)));
  if (!row) notFound();
  const { tx, account } = row;
  const [matches, items, links, flags, doc, rules] = await Promise.all([
    db.select({ m: match, number: invoice.number, invCurrency: invoice.currency }).from(match).innerJoin(invoice, eq(invoice.id, match.invoiceId)).where(and(eq(match.workspaceId, ws.id), eq(match.transactionId, tx.id))),
    db.select().from(complianceItem).where(and(eq(complianceItem.workspaceId, ws.id), eq(complianceItem.transactionId, tx.id))),
    db.select().from(transferLink).where(and(eq(transferLink.workspaceId, ws.id), or(eq(transferLink.fromTransactionId, tx.id), eq(transferLink.toTransactionId, tx.id)))),
    db.select().from(flag).where(and(eq(flag.workspaceId, ws.id), eq(flag.subjectType, "transaction"), eq(flag.subjectId, tx.id))),
    tx.sourceDocumentId ? db.select({ id: document.id, name: document.originalName, kind: document.kind }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.id, tx.sourceDocumentId))) : Promise.resolve([]),
    loadRules(db, ws.id),
  ]);
  const base = `/w/${slug}`;
  const isWallet = account?.kind === "payoneer" || account?.kind === "platform";

  return (
    <>
      <PageHeader
        title={`${money(tx.amount, tx.currency)}${tx.payerName ? ` from ${tx.payerName}` : ""}`}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={tx.matchStatus} />
            <span>
              {humanize(tx.kind)} · {day(tx.valueDate)} · {account?.label}
            </span>
          </span>
        }
        actions={
          <Link href={`${base}/payments`} className="btn btn-secondary">
            All payments
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="What the bank or wallet says">
            <KeyValues
              rows={[
                ["Amount", money(tx.amount, tx.currency)],
                ...(tx.pkrAmount && tx.currency !== "PKR" ? ([["Credited in PKR", `${money(tx.pkrAmount, "PKR")}${tx.fxRateApplied ? ` at ${tx.fxRateApplied}` : ""}`]] as Array<[string, string]>) : []),
                ...(tx.chargesAmount ? ([["Charges", `${money(tx.chargesAmount, tx.chargesCurrency ?? tx.currency)}${tx.chargesCode ? ` (${tx.chargesCode})` : ""}`]] as Array<[string, string]>) : []),
                ["Payer", tx.payerName ?? "—"],
                ["Payer's bank", tx.payerBank ?? "—"],
                ["Reference", tx.reference ?? "—"],
                ["Purpose code", tx.purposeCode ?? "—"],
                [isWallet ? "Transaction id" : "Advice number", tx.adviceNumber ?? "—"],
                ...(tx.uetr ? ([["UETR", <code key="u" className="text-xs">{tx.uetr}</code>]] as Array<[string, React.ReactNode]>) : []),
                [
                  "Read from",
                  doc[0] ? (
                    <Link key="d" href={`${base}/documents/${doc[0].id}`} className="link">
                      {doc[0].name ?? humanize(doc[0].kind)}
                    </Link>
                  ) : (
                    "seeded history"
                  ),
                ],
              ]}
            />
          </Card>

          <Card title="How it was matched">
            {matches.length ? (
              <div className="space-y-4">
                {matches.map(({ m, number, invCurrency }) => (
                  <div key={m.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`${base}/invoices/${m.invoiceId}`} className="font-medium text-ink hover:text-accent">
                        {number}
                      </Link>
                      <Badge tone={m.tier === "A" ? "green" : "blue"}>tier {m.tier}</Badge>
                      {m.feeProbable ? <Badge tone="amber">fee probable</Badge> : null}
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-ink">
                      {m.explanation.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                    <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <Fact k="Settles">{money(m.appliedAmount, invCurrency)}</Fact>
                      <Fact k="Cash">{money(m.cashAmount, invCurrency)}</Fact>
                      <Fact k="Fee">{money(m.feeAmount, invCurrency)}</Fact>
                      <Fact k="FX vs reference">{m.fxDifference ? money(m.fxDifference, "PKR") : "—"}</Fact>
                    </dl>
                  </div>
                ))}
              </div>
            ) : tx.matchStatus === "transfer" ? (
              <p className="text-sm text-muted">A transfer between our own accounts, not a client payment.</p>
            ) : (
              <Empty>Not matched to an invoice.</Empty>
            )}
            {links.length ? <p className="mt-3 text-xs text-muted">Linked transfer: {links.map((l) => (l.fromTransactionId === tx.id ? "money moved on to another of our accounts" : "money came from another of our accounts")).join("; ")}.</p> : null}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Documents the bank owes us" pad={false}>
            {items.length ? (
              <ul className="divide-y divide-line text-sm">
                {items.map((i) => ({ ...i, status: i.kind === "eprc" ? eprcStatus(i, rules) : i.status })).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span>{c.kind === "eprc" ? "ePRC" : "Withholding certificate"}</span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {(c.status === "on_file" || c.status === "wrong_code") && c.documentId ? (
                        <Link href={`${base}/documents/${c.documentId}`} className="link">
                          view
                        </Link>
                      ) : c.dueOn ? (
                        `due ${c.dueOn}`
                      ) : null}
                      <Status value={c.status} label={c.status === "wrong_code" ? `wrong code${c.purposeCodeOnDocument ? ` ${c.purposeCodeOnDocument}` : ""}` : undefined} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted">{isWallet ? "Wallet receipts get an ePRC only when withdrawn to a Pakistani bank." : "None tracked."}</p>
            )}
          </Card>
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

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-canvas px-2 py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="tabular-nums text-ink">{children}</dd>
    </div>
  );
}
