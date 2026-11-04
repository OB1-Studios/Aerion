import { getDb, invoice, match, receivingAccount, transaction, type TransactionKind } from "@ebo/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Card, Empty, PageHeader, Status, Table, cx } from "@/components/ui";
import { day, humanize, money } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Payments" };

const MONEY_IN: TransactionKind[] = ["credit", "payoneer_receipt", "platform_earning"];
const TABS = [
  ["in", "Money in"],
  ["review", "To match"],
  ["all", "Everything"],
] as const;

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ show?: string }> }) {
  const { ws: slug } = await params;
  const { show = "in" } = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const where =
    show === "all"
      ? eq(transaction.workspaceId, ws.id)
      : show === "review"
        ? and(eq(transaction.workspaceId, ws.id), inArray(transaction.matchStatus, ["unmatched", "duplicate", "pending"]))
        : and(eq(transaction.workspaceId, ws.id), inArray(transaction.kind, MONEY_IN));
  const [rows, matches] = await Promise.all([
    db
      .select({ tx: transaction, account: receivingAccount.label })
      .from(transaction)
      .leftJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
      .where(where)
      .orderBy(desc(transaction.valueDate), desc(transaction.createdAt))
      .limit(300),
    db.select({ txId: match.transactionId, invoiceId: invoice.id, number: invoice.number }).from(match).innerJoin(invoice, eq(invoice.id, match.invoiceId)).where(eq(match.workspaceId, ws.id)),
  ]);
  const invoicesOf = new Map<string, Array<{ invoiceId: string; number: string }>>();
  for (const m of matches) invoicesOf.set(m.txId, [...(invoicesOf.get(m.txId) ?? []), m]);
  const base = `/w/${slug}`;

  return (
    <>
      <PageHeader title="Payments" sub="Every credit, wallet receipt and transfer the agent has read, with what it was matched to." />
      <div className="mb-4 flex gap-1">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`${base}/payments?show=${k}`} className={cx("rounded-lg px-3 py-1.5 text-sm", k === show ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-ink")}>
            {label}
          </Link>
        ))}
      </div>
      <Card pad={false}>
        {rows.length ? (
          <Table head={["Date", "From", "Account", "Amount", "PKR", "Code", "Status", "Invoice"]}>
            {rows.map(({ tx, account }) => (
              <tr key={tx.id} className="hover:bg-canvas">
                <td className="whitespace-nowrap tabular-nums text-muted">{tx.valueDate}</td>
                <td className="min-w-48">
                  <Link href={`${base}/payments/${tx.id}`} className="text-ink hover:text-accent">
                    {tx.payerName ?? humanize(tx.kind)}
                  </Link>
                  {tx.kind !== "credit" ? <div className="text-xs text-muted">{humanize(tx.kind)}</div> : null}
                </td>
                <td className="whitespace-nowrap text-xs text-muted">{account ?? "—"}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{money(tx.amount, tx.currency)}</td>
                <td className="whitespace-nowrap text-right tabular-nums text-muted">{tx.pkrAmount && tx.currency !== "PKR" ? money(tx.pkrAmount, "PKR") : ""}</td>
                <td className="tabular-nums">{tx.purposeCode ?? ""}</td>
                <td>
                  <Status value={tx.matchStatus} />
                </td>
                <td className="whitespace-nowrap">
                  {(invoicesOf.get(tx.id) ?? []).map((i) => (
                    <Link key={i.invoiceId} href={`${base}/invoices/${i.invoiceId}`} className="link mr-2 text-xs">
                      {i.number}
                    </Link>
                  ))}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No payments here.</Empty>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Showing {day(rows.at(-1)?.tx.valueDate)} to {day(rows[0]?.tx.valueDate)}.</p>
    </>
  );
}
