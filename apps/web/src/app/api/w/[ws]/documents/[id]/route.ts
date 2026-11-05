import { document, getDb, member, storageFromEnv, workspace } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { twoFactorRefusal } from "@/lib/two-factor";

/**
 * Serves a stored document to members of its workspace only. Files come from outside
 * (emails, uploads), so they are sent with a locked-down policy: no scripts, no
 * sniffing, sandboxed when opened directly.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Sign in first.", { status: 401 });
  const [row] = await getDb()
    .select({ doc: document, role: member.role, settings: workspace.settings, isDemo: workspace.isDemo })
    .from(document)
    .innerJoin(workspace, eq(workspace.id, document.workspaceId))
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, session.user.id)))
    .where(and(eq(workspace.slug, slug), eq(document.id, id)));
  if (!row) return new Response("Not found.", { status: 404 });
  const refused = twoFactorRefusal(row, row.role, session.user);
  if (refused) return refused;
  const { doc } = row;
  const body = await storageFromEnv().get(doc.storagePath);
  const stored = doc.mimeType ?? "application/octet-stream";
  const inline = INLINE_TYPES.has(stored);
  const type = inline ? stored : "application/octet-stream";
  const name = (doc.originalName ?? `document-${doc.id}`).replace(/[^\w.\- ]+/g, "_");
  const h: Record<string, string> = {
    "Content-Type": type.startsWith("text/") ? `${type}; charset=utf-8` : type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  };
  // SVG and text can carry markup: no scripts, no requests, sandboxed if opened directly.
  if (type === "image/svg+xml" || type.startsWith("text/")) h["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  return new Response(Buffer.from(body), { headers: h });
}

/** Shown in the browser; anything else downloads as a plain file. */
const INLINE_TYPES = new Set(["text/plain", "text/csv", "image/svg+xml", "image/png", "image/jpeg", "image/webp", "application/pdf"]);
