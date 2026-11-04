import { flag, getDb } from "@ebo/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Status, Table, cx, severityTone } from "@/components/ui";
import { clock, humanize } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Flags" };

const TABS = [
  ["open", "Open", ["open", "actioned"]],
  ["closed", "Resolved", ["resolved"]],
  ["dismissed", "Dismissed", ["dismissed"]],
] as const;

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, info: 2 };

export default async function FlagsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ show?: string }> }) {
  const { ws: slug } = await params;
  const { show = "open" } = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const tab = TABS.find(([k]) => k === show) ?? TABS[0];
  const rows = await getDb()
    .select()
    .from(flag)
    .where(and(eq(flag.workspaceId, ws.id), inArray(flag.status, [...tab[2]])))
    .orderBy(desc(flag.updatedAt));
  rows.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  return (
    <>
      <PageHeader title="Flags" sub="Problems the rules found. Each run re-checks them: a flag closes on its own when the condition clears (a payment arrives, the bank sends the ePRC)." />
      <div className="mb-4 flex gap-1">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/w/${slug}/flags?show=${k}`} className={cx("rounded-lg px-3 py-1.5 text-sm", k === tab[0] ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-ink")}>
            {label}
          </Link>
        ))}
      </div>
      <Card pad={false}>
        {rows.length ? (
          <Table head={["Severity", "What", "Kind", "Status", "Updated"]}>
            {rows.map((f) => (
              <tr key={f.id} className="hover:bg-canvas">
                <td>
                  <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                </td>
                <td className="min-w-64">
                  <Link href={`/w/${slug}/flags/${f.id}`} className="text-ink hover:text-accent">
                    {f.summary}
                  </Link>
                </td>
                <td className="whitespace-nowrap text-xs text-muted">{humanize(f.kind)}</td>
                <td>
                  <Status value={f.status} label={f.status === "actioned" ? "email sent" : undefined} />
                </td>
                <td className="whitespace-nowrap text-xs text-muted">{clock(f.status === "resolved" ? f.resolvedAt : f.updatedAt, ws.timezone)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>{tab[0] === "open" ? "No open flags." : "Nothing here yet."}</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
