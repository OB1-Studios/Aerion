import "server-only";
import { getDb, member, workspace, type Role } from "@ebo/db";
import { DEMO_PEOPLE } from "@ebo/db/seed";
import type { Workspace } from "@ebo/engine";
import { and, eq, inArray } from "drizzle-orm";

/** The roles a workspace can require two-factor sign-in for: the people who approve and send. */
export const TWO_FACTOR_ROLES: Role[] = ["owner", "finance"];

const SHARED_DEMO = new Set<string>(Object.values(DEMO_PEOPLE).map((p) => p.email));

interface Person {
  email: string;
  isAnonymous?: boolean | null;
  twoFactorEnabled?: boolean | null;
}

/** Why this person can't use two-factor sign-in, or null if they can. */
export function twoFactorUnavailable(p: Person): string | null {
  if (p.isAnonymous) return "Demo visitors sign in without a password, so there's nothing for a second step to protect. Create an account to set it up.";
  if (SHARED_DEMO.has(p.email.toLowerCase())) return "This is a shared demo account, so two-factor sign-in can't be turned on: it would lock everyone else out. Create your own account to try it.";
  return null;
}

/** The workspace requires two-factor sign-in for this person's role, and they haven't set it up. */
export function mustSetUpTwoFactor(ws: Workspace, role: Role, p: Person): boolean {
  return !!ws.settings?.requireTwoFactor && !ws.isDemo && TWO_FACTOR_ROLES.includes(role) && !p.twoFactorEnabled && !p.isAnonymous;
}

/** Names of the workspaces that require this person to keep two-factor sign-in on. */
export async function workspacesRequiringTwoFactor(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: workspace.name, settings: workspace.settings, isDemo: workspace.isDemo })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(and(eq(member.userId, userId), inArray(member.role, TWO_FACTOR_ROLES)));
  return rows.filter((r) => r.settings?.requireTwoFactor && !r.isDemo).map((r) => r.name);
}

/** The auth library's refusals, in plain words. */
export function authProblem(err: unknown): string {
  const code = (err as { body?: { code?: string } } | null)?.body?.code ?? "";
  switch (code) {
    case "INVALID_PASSWORD":
      return "That password isn't right.";
    case "INVALID_CODE":
      return "That code isn't right. Use the six digits the app shows now; they change every 30 seconds.";
    case "INVALID_BACKUP_CODE":
      return "That backup code isn't right, or it has already been used.";
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "Too many wrong codes for this sign-in. Sign in again with your password.";
    case "INVALID_TWO_FACTOR_COOKIE":
      return "This sign-in has expired: the code has to be entered within 10 minutes. Sign in again with your password.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Too many wrong codes on this account. Wait 15 minutes, then try again.";
    case "TOTP_ALREADY_ENABLED":
      return "Two-factor sign-in is already on.";
    case "TOTP_NOT_ENABLED":
    case "TWO_FACTOR_NOT_ENABLED":
      return "Two-factor sign-in isn't set up on this account.";
    default:
      console.error("two-factor step failed", err);
      return "That didn't work. Try again in a minute.";
  }
}

/** Whether a sign-in that has to start over (expired, or too many tries) caused this refusal. */
export function signInMustRestart(err: unknown): boolean {
  const code = (err as { body?: { code?: string } } | null)?.body?.code ?? "";
  return code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || code === "INVALID_TWO_FACTOR_COOKIE";
}
