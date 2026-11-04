import { getDb, rule } from "@ebo/db";
import { asc, eq, isNull, or } from "drizzle-orm";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Rules" };

export default async function RulesPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const rows = await getDb()
    .select()
    .from(rule)
    .where(or(isNull(rule.workspaceId), eq(rule.workspaceId, ws.id)))
    .orderBy(asc(rule.key));
  // A workspace's own value replaces the global one.
  const own = new Set(rows.filter((r) => r.workspaceId).map((r) => r.key));
  const shown = rows.filter((r) => r.workspaceId || !own.has(r.key));
  const unverified = shown.filter((r) => r.status !== "verified").length;

  return (
    <>
      <PageHeader title="Rules" sub="Every number the agent decides with: purpose codes, wait times, tolerances, tax rates. Code reads them from here, not from the model." />
      {unverified ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {unverified} of {shown.length} rules are still <b>unverified</b>: starting values from public sources that a person must check before the results are relied on.
        </p>
      ) : null}
      <Card pad={false}>
        <Table head={["Rule", "Value", "What it does", "Status"]}>
          {shown.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap align-top">
                <code className="text-xs">{r.key}</code>
                {r.workspaceId ? <div className="text-xs text-muted">this workspace</div> : null}
              </td>
              <td className="align-top">
                <code className="text-xs">{JSON.stringify(r.value)}</code>
              </td>
              <td className="min-w-64 align-top text-sm text-muted">
                {r.description}
                {r.sourceUrl ? (
                  <div className="mt-0.5">
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="link text-xs">
                      {r.sourceTitle ?? "source"}
                    </a>
                  </div>
                ) : null}
              </td>
              <td className="align-top">
                <Badge tone={r.status === "verified" ? "green" : "amber"}>{r.status}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
