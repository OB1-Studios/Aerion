import { exportJob, getDb, member, storageFromEnv, workspace } from "@ebo/db";
import { taxPackKey } from "@ebo/engine";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A built tax pack (W27), for members of its workspace only. */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  if (!UUID.test(id)) return new Response("Not found.", { status: 404 });
  const [row] = await getDb()
    .select({ job: exportJob, slug: workspace.slug })
    .from(exportJob)
    .innerJoin(workspace, eq(workspace.id, exportJob.workspaceId))
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(and(eq(workspace.slug, slug), eq(exportJob.id, id), eq(exportJob.kind, "tax_pack"), eq(exportJob.status, "done")));
  if (!row) return new Response("Not found.", { status: 404 });
  let body: Uint8Array;
  try {
    body = await storageFromEnv().get(taxPackKey(row.job.workspaceId, row.job.id));
  } catch {
    return new Response("This pack is no longer in storage. Build it again.", { status: 410 });
  }
  const name = `${row.slug}-tax-pack-${row.job.period ?? "year"}.zip`.replace(/[^\w.-]+/g, "-");
  return new Response(Buffer.from(body), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
