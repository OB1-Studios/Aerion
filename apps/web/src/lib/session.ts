import "server-only";
import { getDb, member, workspace, type Role } from "@ebo/db";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

export async function requireUser() {
  const s = await getSession();
  if (!s) redirect("/login");
  return s.user as typeof s.user & { isAnonymous?: boolean | null };
}

/** The workspace by slug, only if the signed-in user is a member. */
export const requireWorkspace = cache(async (slug: string) => {
  const user = await requireUser();
  const [row] = await getDb()
    .select({ ws: workspace, role: member.role })
    .from(workspace)
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, user.id)))
    .where(eq(workspace.slug, slug));
  if (!row) notFound();
  return { user, ws: row.ws, role: row.role };
});

export async function myWorkspaces(userId: string) {
  return getDb()
    .select({ slug: workspace.slug, name: workspace.name, kind: workspace.kind, isDemo: workspace.isDemo, role: member.role })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(eq(member.userId, userId))
    .orderBy(asc(workspace.kind), asc(workspace.name));
}

/** Owners and finance prepare and approve; accountants and viewers read. */
export const canAct = (role: Role) => role === "owner" || role === "finance";
/** May build exports such as the tax pack: everyone but viewers (the accountant included). */
export const canExport = (role: Role) => role !== "viewer";
