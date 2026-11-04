import { document, getDb, invoice, member, storageFromEnv, workspace } from "@ebo/db";
import { invoicePdf } from "@ebo/engine";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * The invoice as an A4 PDF. Once it has been emailed, this is the exact copy that went out
 * (kept in storage); before that it's rendered from the records each time. Members only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  const db = getDb();
  const [row] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(eq(workspace.slug, slug));
  if (!row || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found.", { status: 404 });
  const [sent] = await db
    .select({ number: invoice.number, path: document.storagePath })
    .from(invoice)
    .innerJoin(document, eq(document.id, invoice.pdfDocumentId))
    .where(and(eq(invoice.workspaceId, row.id), eq(invoice.id, id)));
  let pdf: { name: string; bytes: Uint8Array } | null = null;
  if (sent) {
    try {
      pdf = { name: `${sent.number}.pdf`, bytes: await storageFromEnv().get(sent.path) };
    } catch {
      pdf = null; // The stored copy is missing: fall back to rendering it.
    }
  }
  pdf ??= await invoicePdf(db, row.id, id);
  if (!pdf) return new Response("Not found.", { status: 404 });
  const download = new URL(req.url).searchParams.has("download");
  return new Response(Buffer.from(pdf.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${pdf.name}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
