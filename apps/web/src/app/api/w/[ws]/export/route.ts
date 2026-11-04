import { getDb, member, workspace } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { taxYearFile, toCsv } from "@/lib/tax-file";

/** CSV downloads of the tax-year file: ?part=credits (default) or ?part=share. */
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  const [row] = await getDb()
    .select({ ws: workspace })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(eq(workspace.slug, slug));
  if (!row) return new Response("Not found.", { status: 404 });

  const file = await taxYearFile(row.ws);
  const part = new URL(req.url).searchParams.get("part") === "share" ? "share" : "credits";
  const csv =
    part === "share"
      ? toCsv([["date", "kind", "currency", "amount", "usd_at_reference_rate", "counts_as", "note"], ...(file.share?.lines ?? []).map((l) => [l.date, l.kind, l.currency, l.amount, l.usd, l.counts, l.note])])
      : toCsv([
          ["value_date", "account", "payer", "reference", "currency", "amount", "pkr_amount", "purpose_code", "own_transfer", "invoices", "eprc", "wht_certificate"],
          ...file.lines.map((l) => [l.valueDate, l.account, l.payer, l.reference, l.currency, l.amount, l.pkrAmount, l.purposeCode, l.ownTransfer ? "yes" : "no", l.invoices.join(" "), l.eprc, l.whtCertificate]),
        ]);
  const name = `${slug}-${file.year.label.replace(/[^\w-]+/g, "-")}-${part}.csv`;
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
