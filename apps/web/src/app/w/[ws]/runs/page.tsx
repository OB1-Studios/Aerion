import { getDb, run, user } from "@ebo/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { RunPoller } from "@/components/run-poller";
import { Card, Empty, PageHeader, Status, Table } from "@/components/ui";
import { clock, duration } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Runs" };

const COUNT_LABELS: Array<[string, string]> = [
  ["documents_read", "read"],
  ["matched", "matched"],
  ["flags_opened", "new flags"],
  ["flags_resolved", "resolved"],
  ["sent", "sent"],
  ["awaiting_approval", "to approve"],
];

export default async function RunsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const runs = await getDb()
    .select({ r: run, who: user.name, anon: user.isAnonymous })
    .from(run)
    .leftJoin(user, eq(user.id, run.triggeredBy))
    .where(eq(run.workspaceId, ws.id))
    .orderBy(desc(run.startedAt))
    .limit(50);
  const active = runs.some(({ r }) => r.status === "queued" || r.status === "running");

  return (
    <>
      <RunPoller active={active} everyMs={2000} />
      <PageHeader title="Runs" sub="Every run of the workflow, step by step. The weekly run starts on its own every Monday at 09:00 PKT." />
      <Card pad={false}>
        {runs.length ? (
          <Table head={["As of", "Kind", "Status", "Took", "Results", "Started by"]}>
            {runs.map(({ r, who, anon }) => (
              <tr key={r.id} className="hover:bg-canvas">
                <td className="whitespace-nowrap">
                  <Link href={`/w/${slug}/runs/${r.id}`} className="font-medium text-ink hover:text-accent">
                    {clock(r.clockAt, ws.timezone)}
                  </Link>
                </td>
                <td className="capitalize text-muted">{r.kind.replace("_", " ")}</td>
                <td>
                  <Status value={r.status} />
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted">{duration(r.startedAt, r.finishedAt)}</td>
                <td className="text-xs text-muted">
                  {COUNT_LABELS.filter(([k]) => r.counts[k])
                    .map(([k, label]) => `${r.counts[k]} ${label}`)
                    .join(" · ") || "—"}
                </td>
                <td className="text-muted">{r.triggeredBy ? (anon ? "Visitor" : (who ?? "A person")) : "Schedule"}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No runs yet. Use &ldquo;Run now&rdquo; at the top.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
