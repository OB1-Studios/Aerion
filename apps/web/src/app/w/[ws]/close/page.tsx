import { dateInZone } from "@ebo/core";
import { getDb } from "@ebo/db";
import { closeOverview, loadContext, monthRange } from "@ebo/engine";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { day } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Month-end close" };

export default async function ClosePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const months = await closeOverview(db, await loadContext(db, ws.id));
  const base = `/w/${slug}/close`;

  return (
    <>
      <PageHeader
        title="Month-end close"
        sub="Before a month is signed off: every credit matched, every certificate on file or on its way, each bank statement agreeing with the records, every flag looked at and every document read. Closing makes a report for the director."
      />
      <Card pad={false}>
        {months.length ? (
          <Table head={["Month", "Status", "", ""]}>
            {months.map((m) => {
              const on = m.record?.closedAt ? day(dateInZone(new Date(m.record.closedAt), ws.timezone)) : null;
              return (
                <tr key={m.month}>
                  <td className="whitespace-nowrap font-medium text-ink">
                    <Link href={`${base}/${m.month}`} className="hover:underline">
                      {m.label}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">
                    {m.status === "closed" ? <Badge tone="green">Closed</Badge> : m.status === "ready" ? <Badge tone="blue">Ready to close</Badge> : m.status === "todo" ? <Badge tone="amber">{m.todo} to do</Badge> : <Badge tone="gray">In progress</Badge>}
                    {m.changedSinceClose ? (
                      <span className="ml-2">
                        <Badge tone="amber">changed since</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="text-sm text-muted">
                    {m.status === "closed"
                      ? m.record?.closedByName
                        ? `By ${m.record.closedByName}${on ? ` on ${on}` : ""}`
                        : on
                          ? `On ${on}`
                          : ""
                      : m.status === "in_progress"
                        ? `Can be closed after ${day(monthRange(m.month).end)}`
                        : m.waiting
                          ? `${m.waiting} waiting on the bank or a client`
                          : ""}
                  </td>
                  <td className="text-right">
                    <Link href={`${base}/${m.month}`} className="link whitespace-nowrap">
                      {m.status === "ready" || m.status === "todo" ? "Open the checklist" : "View"}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>Nothing to close yet: no invoices or payments have been recorded.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
