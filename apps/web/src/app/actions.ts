"use server";

import { getDb, storageFromEnv } from "@ebo/db";
import { createVisitorDemo } from "@ebo/db/seed";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSession, myWorkspaces } from "@/lib/session";

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
  redirect("/workspaces");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}
