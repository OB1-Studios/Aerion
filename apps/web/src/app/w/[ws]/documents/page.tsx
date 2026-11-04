import { document, getDb } from "@ebo/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Card, Empty, PageHeader, Status, Table } from "@/components/ui";
import { clock, humanize } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const docs = await getDb().select().from(document).where(eq(document.workspaceId, ws.id)).orderBy(desc(document.receivedAt)).limit(300);
  return (
    <>
      <PageHeader title="Documents" sub="Everything that came in: credit advices, ePRCs, wallet exports, screenshots, pasted bank texts. Stored once by content hash." />
      <Card pad={false}>
        {docs.length ? (
          <Table head={["Received", "Document", "Kind", "Came from", "Read by", "Status"]}>
            {docs.map((d) => (
              <tr key={d.id} className="hover:bg-canvas">
                <td className="whitespace-nowrap text-xs text-muted">{clock(d.receivedAt, ws.timezone)}</td>
                <td className="min-w-48">
                  <Link href={`/w/${slug}/documents/${d.id}`} className="text-ink hover:text-accent">
                    {d.originalName ?? d.sha256.slice(0, 12)}
                  </Link>
                </td>
                <td className="whitespace-nowrap text-xs">{humanize(d.kind)}</td>
                <td className="text-xs text-muted">{d.source}</td>
                <td className="text-xs text-muted">{d.model ?? "—"}</td>
                <td>
                  <Status value={d.parseStatus} label={d.parseStatus === "needs_review" ? "needs review" : undefined} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No documents yet. The run pulls them from the mailbox.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
