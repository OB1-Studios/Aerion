"use server";

import { consent, getDb, member, storageFromEnv, workspace } from "@ebo/db";
import { createVisitorDemo } from "@ebo/db/seed";
import { acceptInvitation, createWorkspace } from "@ebo/engine";
import { and, count, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { formValues, type FormState } from "@/lib/forms";
import { getSession, myWorkspaces, requireUser } from "@/lib/session";

/** The version of the pilot terms and AI-processing wording a person agrees to at sign-up. */
const CONSENT_VERSION = "2026-11-04";
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;
const MAX_OWNED_WORKSPACES = 5;

/** Where to go after signing in or up: only a path on this site (an invitation, say). */
function nextPath(value: FormDataEntryValue | null): string | null {
  const n = typeof value === "string" ? value : "";
  return /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(n) ? n : null;
}

/** "Try the demo": a private copy of both demo workspaces for this visitor, no sign-up needed. */
export async function startDemo() {
  const session = await getSession();
  let userId = session?.user.id;
  if (userId) {
    const mine = await myWorkspaces(userId);
    if (mine.length) redirect(`/w/${mine[0]!.slug}/inbox`);
  } else {
    // Sets the session cookie on this response; the new user comes back in the result.
    const res = await auth.api.signInAnonymous({ headers: await headers() });
    userId = res?.user.id;
  }
  if (!userId) redirect("/login");
  const copy = await createVisitorDemo(getDb(), storageFromEnv(), userId);
  redirect(`/w/${copy.office.slug}/inbox?welcome=1`);
}

export async function signInWithPassword(_: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch {
    return { error: "Email or password is wrong." };
  }
  redirect(nextPath(form.get("next")) ?? "/workspaces");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}

/** A real account: name, email, password, and what the person agreed to. Workspaces come next. */
export async function signUp(_prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  const name = (v.name ?? "").trim();
  const email = (v.email ?? "").trim().toLowerCase();
  const password = v.password ?? "";
  const ai = v.ai === "on";
  // Never send the password back to the page.
  const values = { name, email, ...(ai ? { ai: "on" } : {}), ...(v.terms === "on" ? { terms: "on" } : {}), ...(nextPath(form.get("next")) ? { next: v.next! } : {}) };
  const problems: string[] = [];
  if (name.length < 2) problems.push("Add your name.");
  if (name.length > 80) problems.push("The name is too long (80 characters at most).");
  if (!EMAIL_RE.test(email)) problems.push("The email address doesn't look right.");
  if (password.length < 10) problems.push("The password needs at least 10 characters.");
  if (password.length > 128) problems.push("The password is too long (128 characters at most).");
  if (v.terms !== "on") problems.push("Tick the box to accept the pilot terms.");
  if (problems.length) return { problems, values };
  let userId: string;
  try {
    const res = await auth.api.signUpEmail({ body: { name, email, password }, headers: await headers() });
    userId = res.user.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { problems: [/exist/i.test(message) ? "There's already an account with this email. Sign in instead." : `Couldn't create the account: ${message}`], values };
  }
  await getDb()
    .insert(consent)
    .values([{ userId, kind: "terms", version: CONSENT_VERSION }, ...(ai ? [{ userId, kind: "ai_processing" as const, version: CONSENT_VERSION }] : [])]);
  redirect(nextPath(form.get("next")) ?? "/workspaces/new");
}

/** A new, empty workspace owned by the signed-in person; setup is the next stop. */
export async function newWorkspace(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  if (user.isAnonymous) redirect("/signup");
  const v = formValues(form);
  const db = getDb();
  const [owned] = await db
    .select({ n: count() })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(and(eq(member.userId, user.id), eq(member.role, "owner"), eq(workspace.isDemo, false)));
  if (Number(owned?.n ?? 0) >= MAX_OWNED_WORKSPACES) return { problems: [`You already own ${MAX_OWNED_WORKSPACES} workspaces, the most a pilot account can have.`], values: v };
  const [ai] = await db.select({ id: consent.id }).from(consent).where(and(eq(consent.userId, user.id), eq(consent.kind, "ai_processing"))).limit(1);
  const r = await createWorkspace(db, { kind: v.kind ?? "", name: v.name ?? "", legalName: v.legalName ?? "", city: v.city ?? "", aiReading: !!ai }, { id: user.id, name: user.name });
  if (!r.ok) return { problems: r.problems, values: v };
  redirect(`/w/${r.slug}/setup?welcome=1`);
}

/** Joins the workspace an invitation is for, if it's for this person's email address. */
export async function acceptInvite(token: string) {
  const user = await requireUser();
  const r = await acceptInvitation(getDb(), token, { id: user.id, email: user.email, isAnonymous: user.isAnonymous });
  if (!r.ok) redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(r.reason)}`);
  redirect(`/w/${r.slug}/inbox`);
}
