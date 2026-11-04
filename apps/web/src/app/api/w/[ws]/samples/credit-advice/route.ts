import { getDb, member, workspace } from "@ebo/db";
import { sampleCreditAdvice } from "@ebo/engine";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * A SIMULATED credit advice (PDF) paying this workspace's oldest open wire-paid invoice, for
 * trying the upload. Members only; nothing is stored until the file is uploaded.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  const [row] = await getDb()
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(eq(workspace.slug, slug));
  if (!row) return new Response("Not found.", { status: 404 });
  const sample = await sampleCreditAdvice(getDb(), row.id);
  if (!sample) return new Response("Every invoice paid by bank wire is settled; there's nothing for a sample to pay.", { status: 404 });
  return new Response(Buffer.from(sample.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${sample.name}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
