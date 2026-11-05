"use server";

import { getDb, storageFromEnv } from "@ebo/db";
import { applyImport, isImportKind, startImport } from "@ebo/engine";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actor } from "@/lib/actor";
import type { FormState } from "@/lib/forms";

/** Keeps the CSV, checks every row, and opens the result: the problems, or what importing would add. */
export async function uploadImportAction(slug: string, kind: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug);
  if (!isImportKind(kind)) return { problems: ["Choose what the file holds."], values: null };
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { problems: ["Choose a CSV file to upload."], values: null };
  const r = await startImport(getDb(), storageFromEnv(), ws, kind, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, user.id);
  if (!r.ok) return { problems: r.problems, values: null };
  redirect(`/w/${slug}/import/${r.jobId}`);
}

/** Writes every row, or none: the file is checked once more first. */
export async function applyImportAction(slug: string, jobId: string, _prev: FormState, _form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug);
  const r = await applyImport(getDb(), storageFromEnv(), ws, jobId, { id: user.id, name: user.isAnonymous ? "Visitor" : user.name });
  if (!r.ok) {
    // Rows that no longer fit are on the page now.
    if (r.errors) redirect(`/w/${slug}/import/${jobId}?changed=1`);
    return { problems: r.problems, values: null };
  }
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/import/${jobId}?done=1`);
}
