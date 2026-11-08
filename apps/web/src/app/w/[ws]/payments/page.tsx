import { client, getDb, invoice, match, receivingAccount, rule, transaction, type TransactionKind } from "@ebo/db";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql, sum, type SQL } from "drizzle-orm";
import Link from "next/link";
import { FilterForm, FilterSearch, FilterSelect } from "@/components/filters";
import { Badge, Card, Empty, PageHeader, Pager, Status, Table, Tabs, pageOf } from "@/components/ui";
import { money, shortDay } from "@/lib/format";
import { MATCH_STATUS, TRANSACTION_KIND } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Payments" };

const MONEY_IN: TransactionKind[] = ["credit", "payoneer_receipt", "platform_earning"];
const TO_PLACE = ["unmatched", "duplicate", "pending"] as const;
const TABS = [
  ["in", "Money in"],
  ["review", "To place"],
  ["all", "Every movement"],
] as const;
const PAGE = 50;

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const show = TABS.some(([k]) => k === sp.show) ? sp.show! : "in";
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const accounts = await db.select({ id: receivingAccount.id, label: receivingAccount.label }).from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id));
  const account = accounts.some((a) => a.id === sp.account) ? sp.account! : "";
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : "";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = pageOf(sp.page);

  const where: SQL[] = [eq(transaction.workspaceId, ws.id)];
  if (show === "review") where.push(inArray(transaction.matchStatus, [...TO_PLACE]));
  else if (show === "in") where.push(inArray(transaction.kind, MONEY_IN));
  if (account) where.push(eq(transaction.receivingAccountId, account));
  if (month) where.push(sql`to_char(${transaction.valueDate}, 'YYYY-MM') = ${month}`);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Payer, reference, advice number, or the number of an invoice it paid.
    where.push(
      or(
        ilike(transaction.payerName, like),
        ilike(transaction.reference, like),
        ilike(transaction.adviceNumber, like),
        sql`exists (select 1 from match m join invoice i on i.id = m.invoice_id where m.transaction_id = ${transaction.id} and i.number ilike ${like})`,
      )!,
    );
  }

  const [rows, [total], totals, months, toPlace, itRule] = await Promise.all([
    db
      .select({ tx: transaction, account: receivingAccount.label })
      .from(transaction)
      .leftJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
      .where(and(...where))
      .orderBy(desc(transaction.valueDate), desc(transaction.createdAt))
      .limit(PAGE)
      .offset((page - 1) * PAGE),
    db.select({ n: count() }).from(transaction).where(and(...where)),
    show === "all" ? Promise.resolve([]) : db.select({ currency: transaction.currency, total: sum(transaction.amount) }).from(transaction).where(and(...where)).groupBy(transaction.currency),
    db
      .selectDistinct({ m: sql<string>`to_char(${transaction.valueDate}, 'YYYY-MM')` })
      .from(transaction)
      .where(eq(transaction.workspaceId, ws.id))
      .orderBy(desc(sql`to_char(${transaction.valueDate}, 'YYYY-MM')`)),
    db.select({ n: count() }).from(transaction).where(and(eq(transaction.workspaceId, ws.id), inArray(transaction.matchStatus, [...TO_PLACE]))),
    db.select({ value: rule.value, ws: rule.workspaceId }).from(rule).where(and(eq(rule.key, "purpose_code.it_services"), or(isNull(rule.workspaceId), eq(rule.workspaceId, ws.id)))),
  ]);
  const ids = rows.map((r) => r.tx.id);
  const matches = ids.length
    ? await db
        .select({ txId: match.transactionId, invoiceId: invoice.id, number: invoice.number, client: client.name })
        .from(match)
        .innerJoin(invoice, eq(invoice.id, match.invoiceId))
        .innerJoin(client, eq(client.id, invoice.clientId))
        .where(and(eq(match.workspaceId, ws.id), inArray(match.transactionId, ids)))
    : [];
  const invoicesOf = new Map<string, typeof matches>();
  for (const m of matches) invoicesOf.set(m.txId, [...(invoicesOf.get(m.txId) ?? []), m]);
  const itCodes = new Set(((itRule.find((r) => r.ws) ?? itRule[0])?.value as string[] | undefined) ?? ["9186"]);
  const base = `/w/${slug}`;
  const filtered = !!(account || month || q);
  const keep = { show: show === "in" ? undefined : show };
  const params_ = (p: number) => new URLSearchParams(Object.entries({ show: keep.show, account, month, q, page: p > 1 ? String(p) : "" }).filter(([, v]) => v) as Array<[string, string]>);
  const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <PageHeader eyebrow="Receivables" title="Payments" sub="Every credit, wallet receipt and transfer Aerion has read, and the invoices each one paid." />
      <Tabs
        items={TABS.map(([k, label]) => ({
          href: `${base}/payments${k === "in" ? "" : `?show=${k}`}`,
          label,
          active: k === show,
          count: k === "review" ? Number(toPlace[0]?.n ?? 0) : k === show ? Number(total?.n ?? 0) : undefined,
        }))}
      />
      <FilterForm keep={keep} clearHref={`${base}/payments${keep.show ? `?show=${keep.show}` : ""}`} active={filtered}>
        <FilterSelect name="account" label="Account" value={account} options={[["", "All accounts"], ...accounts.map((a) => [a.id, a.label] as [string, string])]} />
        <FilterSelect name="month" label="Month" value={month} options={[["", "Any month"], ...months.map((m) => [m.m, monthLabel(m.m)] as [string, string])]} />
        <FilterSearch value={q} placeholder="Payer, reference or invoice number" />
      </FilterForm>

      {totals.length && filtered ? (
        <p className="-mt-1 mb-3 text-sm text-muted">
          Total in this view:{" "}
          <b className="font-medium tabular-nums text-ink">
            {totals
              .sort((a, b) => a.currency.localeCompare(b.currency))
              .map((t) => money(t.total, t.currency))
              .join(" · ")}
          </b>
        </p>
      ) : null}

      <Card pad={false}>
        {rows.length ? (
          <>
            <Table head={["Value date", "From", "Account", "Amount", "In PKR", "Code", "Status", "Paid"]} num={[3, 4]} phoneHidden={[2, 3, 4, 5, 6, 7]}>
              {rows.map(({ tx, account: acct }) => {
                const paid = invoicesOf.get(tx.id) ?? [];
                const clientName = paid[0]?.client;
                // The payer's name as the bank wrote it, when it reads differently from the client's.
                const asWritten = clientName && tx.payerName && tx.payerName.toLowerCase() !== clientName.toLowerCase() ? tx.payerName : null;
                const kindLabel = tx.kind !== "credit" ? (TRANSACTION_KIND[tx.kind] ?? null) : null;
                return (
                  <tr key={tx.id}>
                    <td className="whitespace-nowrap tabular-nums text-muted">{shortDay(tx.valueDate)}</td>
                    <td className="min-w-48">
                      <Link href={`${base}/payments/${tx.id}`} className="font-medium text-ink hover:text-accent">
                        {clientName ?? tx.payerName ?? TRANSACTION_KIND[tx.kind] ?? tx.kind}
                      </Link>
                      {kindLabel || asWritten ? (
                        <div className="text-xs text-muted">
                          {kindLabel}
                          {kindLabel && asWritten ? " · " : null}
                          {asWritten ? <span title="The payer's name as the bank wrote it">{asWritten}</span> : null}
                        </div>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                        <span className="whitespace-nowrap text-sm font-medium tabular-nums text-ink">{money(tx.amount, tx.currency)}</span>
                        <Status value={tx.matchStatus} label={MATCH_STATUS[tx.matchStatus]} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">{acct ?? "—"}</td>
                    <td className="whitespace-nowrap text-right font-medium tabular-nums">{money(tx.amount, tx.currency)}</td>
                    <td className="whitespace-nowrap text-right tabular-nums text-muted">{tx.pkrAmount && tx.currency !== "PKR" ? money(tx.pkrAmount, "PKR") : ""}</td>
                    <td className="tabular-nums">
                      {tx.purposeCode ? (
                        itCodes.has(tx.purposeCode) ? (
                          tx.purposeCode
                        ) : (
                          <Badge tone="red" title="Not an IT export purpose code">
                            {tx.purposeCode}
                          </Badge>
                        )
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td>
                      <Status value={tx.matchStatus} label={MATCH_STATUS[tx.matchStatus]} />
                    </td>
                    <td className="whitespace-nowrap">
                      {paid.map((i) => (
                        <Link key={i.invoiceId} href={`${base}/invoices/${i.invoiceId}`} className="link mr-2 text-xs">
                          {i.number}
                        </Link>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <Pager page={page} pageSize={PAGE} total={Number(total?.n ?? 0)} href={(p) => `${base}/payments?${params_(p)}`} noun={show === "all" ? "movements" : "payments"} />
          </>
        ) : (
          <div className="p-4">
            <Empty>
              {filtered
                ? "No payments match these filters."
                : show === "review"
                  ? "Nothing to place: every payment is matched to an invoice or explained as a transfer."
                  : "No payments yet. They arrive from credit advices, statements and wallet exports: upload them on Documents, or connect the mailbox in Setup."}
            </Empty>
          </div>
        )}
      </Card>
    </>
  );
}
