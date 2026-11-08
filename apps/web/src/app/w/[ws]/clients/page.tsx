import { dateInZone, dec, ROUTE_LABELS, type Decimal } from "@ebo/core";
import { client, getDb, invoice } from "@ebo/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { FilterForm, FilterSearch, FilterSelect } from "@/components/filters";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { appliedToInvoice, creditedOnInvoice } from "@/lib/balances";
import { countryName } from "@/lib/forms";
import { money } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";

export const metadata = { title: "Clients" };

const SORTS = [
  ["name", "Name"],
  ["owed", "Most overdue first"],
  ["country", "Country"],
] as const;

export default async function ClientsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const today = dateInZone(ws.demoClock ?? new Date(), ws.timezone);
  const q = (sp.q ?? "").trim().slice(0, 80).toLowerCase();
  const sort = SORTS.some(([k]) => k === sp.sort) ? sp.sort! : "name";
  const [clients, open] = await Promise.all([
    db.select().from(client).where(eq(client.workspaceId, ws.id)).orderBy(asc(client.name)),
    db
      .select({ clientId: invoice.clientId, amount: invoice.amount, paidBefore: invoice.paidBeforeImport, currency: invoice.currency, dueOn: invoice.dueOn, applied: appliedToInvoice, credited: creditedOnInvoice })
      .from(invoice)
      .where(and(eq(invoice.workspaceId, ws.id), inArray(invoice.status, ["sent", "part_paid"]))),
  ]);
  const owed = new Map<string, { count: number; overdue: number; byCcy: Map<string, Decimal>; overdueDays: number }>();
  for (const i of open) {
    const balance = dec(i.amount).minus(i.paidBefore).minus(i.applied).minus(i.credited);
    if (balance.lte(0)) continue;
    const o = owed.get(i.clientId) ?? { count: 0, overdue: 0, byCcy: new Map(), overdueDays: 0 };
    o.count++;
    o.byCcy.set(i.currency, (o.byCcy.get(i.currency) ?? dec(0)).plus(balance));
    if (i.dueOn < today) {
      o.overdue++;
      o.overdueDays = Math.max(o.overdueDays, Math.round((Date.parse(today) - Date.parse(i.dueOn)) / 86_400_000));
    }
    owed.set(i.clientId, o);
  }
  const rows = clients
    .filter((c) => !q || [c.name, c.contactName, ...(c.contactEmails ?? []), countryName(c.country), c.defaultCurrency].some((x) => x?.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "owed") return (owed.get(b.id)?.overdueDays ?? -1) - (owed.get(a.id)?.overdueDays ?? -1) || (owed.get(b.id)?.count ?? 0) - (owed.get(a.id)?.count ?? 0) || a.name.localeCompare(b.name);
      if (sort === "country") return countryName(a.country).localeCompare(countryName(b.country)) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  const base = `/w/${slug}/clients`;
  const withOverdue = [...owed.values()].filter((o) => o.overdue).length;

  return (
    <>
      <PageHeader
        eyebrow="Records"
        title="Clients"
        sub={
          clients.length
            ? `${clients.length} client${clients.length === 1 ? "" : "s"}; ${owed.size} with money owed${withOverdue ? `, ${withOverdue} overdue` : ""}. What each owes, and how they usually pay.`
            : "Who you invoice, what each owes, and how they usually pay."
        }
        actions={
          canAct(role) ? (
            <>
              <Link href={`/w/${slug}/import#clients`} className="btn btn-secondary">
                Import
              </Link>
              <Link href={`${base}/new`} className="btn btn-primary">
                New client
              </Link>
            </>
          ) : null
        }
      />
      {clients.length ? (
        <FilterForm clearHref={base} active={!!q || sort !== "name"}>
          <FilterSearch value={sp.q ?? ""} placeholder="Name, email, country or currency" />
          <FilterSelect name="sort" label="Order" value={sort} options={SORTS.map(([k, l]) => [k, l])} />
        </FilterForm>
      ) : null}
      <Card pad={false}>
        {rows.length ? (
          <Table head={["Client", "Country", "Pays in", "Usual route", "Open", "Still owed", ""]} num={[4, 5]} phoneHidden={[1, 2, 3, 4, 5, 6]}>
            {rows.map((c) => {
              const o = owed.get(c.id);
              return (
                <tr key={c.id}>
                  <td className="min-w-48">
                    <Link href={`${base}/${c.id}`} className="font-medium text-ink hover:text-accent">
                      {c.name}
                    </Link>
                    {c.kind !== "business" ? <span className="ml-2 text-xs text-muted">{c.kind === "marketplace" ? "Marketplace" : "Individual"}</span> : null}
                    {c.contactEmails?.[0] ? <div className="truncate text-xs text-muted">{c.contactEmails[0]}</div> : null}
                    {o ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                        <span className="whitespace-nowrap text-sm font-medium tabular-nums text-ink">{[...o.byCcy].map(([ccy, b]) => money(b.toFixed(2), ccy)).join(", ")} owed</span>
                        {o.overdueDays ? <Badge tone="red">{o.overdueDays} days overdue</Badge> : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-muted">{countryName(c.country) || "—"}</td>
                  <td>{c.defaultCurrency}</td>
                  <td className="text-xs text-muted">{c.preferredRoute ? ROUTE_LABELS[c.preferredRoute] : "Suggested per invoice"}</td>
                  <td className="text-right tabular-nums">{o?.count ?? <span className="text-muted">—</span>}</td>
                  <td className="whitespace-nowrap text-right font-medium tabular-nums">{o ? [...o.byCcy].map(([ccy, b]) => money(b.toFixed(2), ccy)).join(", ") : <span className="font-normal text-muted">—</span>}</td>
                  <td className="text-right">{o?.overdueDays ? <Badge tone="red">{o.overdueDays} days overdue</Badge> : null}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <div className="p-4">
            <Empty
              action={
                !clients.length && canAct(role) ? (
                  <Link href={`${base}/new`} className="btn btn-primary">
                    Add a client
                  </Link>
                ) : undefined
              }
            >
              {clients.length ? "No clients match that search." : "No clients yet. Add the first one, or import a spreadsheet of them, to start invoicing."}
            </Empty>
          </div>
        )}
      </Card>
    </>
  );
}
