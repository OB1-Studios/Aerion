import { getDb, member, workspace } from "@ebo/db";
import { IMPORT_SPECS, importTemplate, isImportKind } from "@ebo/engine";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { twoFactorRefusal } from "@/lib/two-factor";

/** The CSV template for an import (W4): the headings and two example rows. */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; kind: string }> }) {
  const { ws: slug, kind } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  if (!isImportKind(kind)) return new Response("Not found.", { status: 404 });
  const [row] = await getDb()
    .select({ role: member.role, settings: workspace.settings, isDemo: workspace.isDemo })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(eq(workspace.slug, slug));
  if (!row) return new Response("Not found.", { status: 404 });
  const refused = twoFactorRefusal(row, row.role, session.user);
  if (refused) return refused;
  return new Response(importTemplate(kind), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${IMPORT_SPECS[kind].file}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
