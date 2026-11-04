import { createHash, randomBytes } from "node:crypto";
import { invitation, member, user, workspace, type Db, type Role } from "@ebo/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { audit, type Workspace } from "./context";

/**
 * People in a workspace (main doc W2): an owner invites someone by email with a role, and
 * they join through a link that only works for that email address. Only a hash of the link's
 * token is stored, so the database alone can't be used to join. A workspace always keeps at
 * least one owner.
 */

export const ROLES: Role[] = ["owner", "finance", "accountant", "viewer"];
export const ROLE_TEXT: Record<Role, string> = {
  owner: "Everything, including setup, the mailbox and people",
  finance: "Writes invoices, runs the agent, and approves emails",
  accountant: "Sees everything, changes nothing (an outside accountant)",
  viewer: "Sees everything, changes nothing",
};
const INVITE_DAYS = 7;
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function inviteMember(
  db: Db,
  ws: Workspace,
  input: { email: string; role: string },
  invitedBy: string,
  now = new Date(),
): Promise<{ ok: true; id: string; token: string; expiresAt: Date } | { ok: false; problems: string[] }> {
  const email = input.email.trim().toLowerCase();
  const role = ROLES.find((r) => r === input.role);
  const problems: string[] = [];
  if (!EMAIL_RE.test(email)) problems.push("The email address doesn't look right.");
  if (!role) problems.push("Choose a role.");
  if (problems.length || !role) return { ok: false, problems };
  const [already] = await db
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.workspaceId, ws.id), sql`lower(${user.email}) = ${email}`));
  if (already) return { ok: false, problems: [`${email} is already in this workspace.`] };
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  const id = await db.transaction(async (tx) => {
    // A new invitation to the same address replaces the old one (and its link).
    await tx.delete(invitation).where(and(eq(invitation.workspaceId, ws.id), eq(invitation.email, email), isNull(invitation.acceptedAt)));
    const [row] = await tx.insert(invitation).values({ workspaceId: ws.id, email, role, token: hashToken(token), invitedBy, expiresAt }).returning({ id: invitation.id });
    return row!.id;
  });
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: invitedBy, action: "member.invited", objectType: "invitation", objectId: id, details: { email, role, expiresAt: expiresAt.toISOString() } });
  return { ok: true, id, token, expiresAt };
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  invitedById: string;
  invitedByName: string | null;
  expiresAt: Date;
  /** Why it can't be used, if it can't. */
  problem: string | null;
}

/** What an invitation link is for, for the page that accepts it. */
export async function findInvitation(db: Db, token: string, now = new Date()): Promise<InvitationView | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db
    .select({ inv: invitation, wsName: workspace.name, wsSlug: workspace.slug, by: user.name })
    .from(invitation)
    .innerJoin(workspace, eq(workspace.id, invitation.workspaceId))
    .leftJoin(user, eq(user.id, invitation.invitedBy))
    .where(eq(invitation.token, hashToken(token)));
  if (!row) return null;
  const problem = row.inv.acceptedAt ? "This invitation has already been used." : row.inv.expiresAt <= now ? "This invitation has expired. Ask for a new one." : null;
  return { id: row.inv.id, email: row.inv.email, role: row.inv.role, workspaceId: row.inv.workspaceId, workspaceName: row.wsName, workspaceSlug: row.wsSlug, invitedById: row.inv.invitedBy, invitedByName: row.by, expiresAt: row.inv.expiresAt, problem };
}

export async function acceptInvitation(
  db: Db,
  token: string,
  who: { id: string; email: string; isAnonymous?: boolean | null },
  now = new Date(),
): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
  const inv = await findInvitation(db, token, now);
  if (!inv) return { ok: false, reason: "This invitation link isn't valid." };
  if (inv.problem) return { ok: false, reason: inv.problem };
  if (who.isAnonymous) return { ok: false, reason: "Create an account first, with the invited email address." };
  if (who.email.trim().toLowerCase() !== inv.email) return { ok: false, reason: `This invitation is for ${inv.email}. Sign in with that address to accept it.` };
  const joined = await db.transaction(async (tx) => {
    const used = await tx
      .update(invitation)
      .set({ acceptedAt: now })
      .where(and(eq(invitation.id, inv.id), isNull(invitation.acceptedAt), gt(invitation.expiresAt, now)))
      .returning({ id: invitation.id });
    if (!used.length) return false;
    await tx.insert(member).values({ workspaceId: inv.workspaceId, userId: who.id, role: inv.role, invitedBy: inv.invitedById }).onConflictDoNothing({ target: [member.workspaceId, member.userId] });
    return true;
  });
  if (!joined) return { ok: false, reason: "This invitation has already been used." };
  await audit(db, { workspaceId: inv.workspaceId, actorType: "user", actorId: who.id, action: "member.joined", objectType: "invitation", objectId: inv.id, details: { email: inv.email, role: inv.role } });
  return { ok: true, slug: inv.workspaceSlug };
}

export async function revokeInvitation(db: Db, workspaceId: string, invitationId: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(invitation)
    .where(and(eq(invitation.workspaceId, workspaceId), eq(invitation.id, invitationId), isNull(invitation.acceptedAt)))
    .returning({ email: invitation.email });
  if (!rows.length) return false;
  await audit(db, { workspaceId, actorType: "user", actorId: userId, action: "member.invitation_revoked", objectType: "invitation", objectId: invitationId, details: { email: rows[0]!.email } });
  return true;
}

async function ownerCount(db: Db, workspaceId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.role, "owner")));
  return row?.n ?? 0;
}

/** Changes someone's role, or removes them (`role: null`). The last owner can't be demoted or removed. */
export async function setMemberRole(db: Db, workspaceId: string, memberId: string, role: Role | null, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [m] = await db.select().from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.id, memberId)));
  if (!m) return { ok: false, reason: "That person isn't in this workspace." };
  if (role !== null && !ROLES.includes(role)) return { ok: false, reason: "Choose a role." };
  if (m.role === role) return { ok: true };
  if (m.role === "owner" && (await ownerCount(db, workspaceId)) <= 1) return { ok: false, reason: "A workspace needs at least one owner. Make someone else an owner first." };
  if (role === null) await db.delete(member).where(eq(member.id, m.id));
  else await db.update(member).set({ role }).where(eq(member.id, m.id));
  await audit(db, { workspaceId, actorType: "user", actorId: userId, action: role === null ? "member.removed" : "member.role_changed", objectType: "member", objectId: m.id, details: { userId: m.userId, from: m.role, to: role } });
  return { ok: true };
}
