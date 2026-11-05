import { getDb, member, workspace } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { twoFactorRefusal } from "@/lib/two-factor";
import { isIsoDate } from "@ebo/core";
import { creditsCsv, shareCsv, taxYearFile } from "@/lib/tax-file";

/** CSV downloads of the tax-year file: ?part=credits (default) or ?part=share, and ?year=<any date in the tax year>. */
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  const [row] = await getDb()
    .select({ ws: workspace, role: member.role, settings: workspace.settings, isDemo: workspace.isDemo })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(eq(workspace.slug, slug));
  if (!row) return new Response("Not found.", { status: 404 });
  const refused = twoFactorRefusal(row, row.role, session.user);
  if (refused) return refused;

  const q = new URL(req.url).searchParams;
  const year = q.get("year");
  const file = await taxYearFile(row.ws, year && isIsoDate(year) ? year : undefined);
  const part = q.get("part") === "share" ? "share" : "credits";
  const csv = part === "share" ? shareCsv(file) : creditsCsv(file);
  const name = `${slug}-${file.year.label.replace(/[^\w-]+/g, "-")}-${part}.csv`;
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
