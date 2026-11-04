import { auditEvent, getDb, user } from "@ebo/db";
import { desc, eq } from "drizzle-orm";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { clock } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const rows = await getDb()
    .select({ e: auditEvent, who: user.name, anon: user.isAnonymous })
    .from(auditEvent)
    .leftJoin(user, eq(user.id, auditEvent.actorId))
    .where(eq(auditEvent.workspaceId, ws.id))
    .orderBy(desc(auditEvent.id))
    .limit(300);
  return (
    <>
      <PageHeader title="Audit log" sub="Everything the agent and people did, newest first. Append-only: the app never edits or deletes these rows. Times are real, not the demo clock." />
      <Card pad={false}>
        {rows.length ? (
          <Table dense head={["When", "Who", "Action", "Details"]}>
            {rows.map(({ e, who, anon }) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap text-xs text-muted">{clock(e.at, ws.timezone)}</td>
                <td className="whitespace-nowrap">
                  <Badge tone={e.actorType === "agent" ? "blue" : e.actorType === "user" ? "violet" : "gray"}>{e.actorType === "agent" ? "agent" : e.actorType === "user" ? (anon ? "visitor" : (who ?? "person")) : "system"}</Badge>
                </td>
                <td className="whitespace-nowrap text-xs">
                  <code>{e.action}</code>
                </td>
                <td className="max-w-xl text-xs text-muted">
                  <span className="line-clamp-2 break-all">{summarize(e.details)}</span>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>Nothing yet.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}

function summarize(d: Record<string, unknown>): string {
  for (const k of ["summary", "subject", "title", "reason"]) if (typeof d[k] === "string") return d[k] as string;
  const s = JSON.stringify(d);
  return s === "{}" ? "" : s;
}
