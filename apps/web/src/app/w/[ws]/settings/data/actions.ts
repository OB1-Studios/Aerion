"use server";

import { getDb, getPool, purgeWorkspace, storageFromEnv } from "@ebo/db";
import { buildFullExport } from "@ebo/engine";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { actor } from "@/lib/actor";
import { auth } from "@/lib/auth";
import type { FormState } from "@/lib/forms";
import { clearFailures, limited, recordFailure, TOO_MANY } from "@/lib/limits";

/** Owners download everything: every record as JSON and CSV, and every document file. */
export async function buildFullExportAction(slug: string, _prev: FormState, _form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  let r: Awaited<ReturnType<typeof buildFullExport>>;
  try {
    r = await buildFullExport(getPool(), getDb(), storageFromEnv(), ws, { id: user.id, name: user.isAnonymous ? "Visitor" : user.name });
  } catch (err) {
    console.error("full export failed", err);
    return { problems: ["The export couldn't be built or saved to storage. Try again in a minute."], values: null };
  }
  if (!r.ok) return { problems: [r.reason], values: null };
  redirect(`/w/${slug}/settings/data?built=${r.jobId}`);
}

/**
 * Deletes the workspace and everything in it, files included: the owner types its name and their
 * password. Demo workspaces are reset instead, and visitors' copies go on their own.
 */
export async function deleteWorkspaceAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const typed = String(form.get("confirm") ?? "").trim();
  const values = { confirm: typed };
  if (ws.isDemo) return { problems: ["Demo workspaces can't be deleted. Reset puts this one back the way it started."], values };
  if (typed !== ws.name.trim()) return { problems: [`Type the workspace's name exactly as shown: ${ws.name}`], values };
  const key = `password:${user.id}`;
  if (limited(key, 5)) return { problems: [TOO_MANY], values };
  try {
    await auth.api.verifyPassword({ body: { password: String(form.get("password") ?? "") }, headers: await headers() });
  } catch {
    recordFailure(key);
    return { problems: ["That password isn't right."], values };
  }
  clearFailures(key);
  // The audit log goes with the workspace, so the server log keeps the only record of who deleted it.
  console.info(`workspace deleted: ${ws.id} (${ws.slug}, "${ws.name}") by user ${user.id}`);
  await purgeWorkspace(getDb(), storageFromEnv(), ws.id);
  redirect("/workspaces?deleted=1");
}
