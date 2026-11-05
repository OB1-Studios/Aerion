"use server";

import { getDb } from "@ebo/db";
import { isDigestFrequency, markAllRead, sendDigestNow, setDigest } from "@ebo/engine";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { engineDeps } from "@/lib/engine";
import type { FormState } from "@/lib/forms";
import { requireWorkspace } from "@/lib/session";

/** Everyone in a workspace manages their own notifications, whatever their role. */
export async function markAllReadAction(slug: string) {
  const { user, ws } = await requireWorkspace(slug);
  await markAllRead(getDb(), ws.id, user.id);
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/notifications`);
}

export async function setDigestAction(slug: string, form: FormData) {
  const { user, ws } = await requireWorkspace(slug);
  const digest = form.get("digest");
  if (!isDigestFrequency(digest)) redirect(`/w/${slug}/notifications`);
  await setDigest(getDb(), ws.id, user.id, digest);
  redirect(`/w/${slug}/notifications?saved=1`);
}

export async function sendDigestNowAction(slug: string, _prev: FormState, _form: FormData): Promise<FormState> {
  const { user, ws, role } = await requireWorkspace(slug);
  const r = await sendDigestNow(engineDeps(), ws, user, role);
  if (!r.ok) return { problems: [r.problem], values: null };
  redirect(`/w/${slug}/notifications?sent=1`);
}
