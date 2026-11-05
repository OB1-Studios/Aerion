"use server";

import { getDb, storageFromEnv } from "@ebo/db";
import { addUpload, closeMonth, isMonth, reopenMonth, sampleStatements } from "@ebo/engine";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actor } from "@/lib/actor";
import { engineDeps, startRun } from "@/lib/engine";
import type { FormState } from "@/lib/forms";
import { canExport, requireWorkspace } from "@/lib/session";

const refresh = (slug: string) => revalidatePath(`/w/${slug}`, "layout");

/** Closes a month (W25): checked again in the engine, then the report PDF is made and kept. */
export async function closeMonthAction(slug: string, month: string, _prev: FormState, _form: FormData): Promise<FormState> {
  const { user, ws, role } = await requireWorkspace(slug);
  if (!canExport(role)) return { problems: ["Your role can see the close but not close a month."], values: null };
  let r: Awaited<ReturnType<typeof closeMonth>>;
  try {
    r = await closeMonth(getDb(), storageFromEnv(), ws, month, { id: user.id, name: user.isAnonymous ? "Visitor" : user.name });
  } catch (err) {
    console.error("month close failed", err);
    return { problems: ["The report couldn't be saved to storage, so the month wasn't closed. Try again in a minute."], values: null };
  }
  if (!r.ok) return { problems: [r.reason], values: null };
  refresh(slug);
  redirect(`/w/${slug}/close/${month}?closed=1`);
}

/** Opens a closed month again: owners only, with a reason for the audit log. */
export async function reopenMonthAction(slug: string, month: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws, role } = await requireWorkspace(slug);
  const reason = String(form.get("reason") ?? "");
  if (role !== "owner") return { problems: ["Only the workspace owner can reopen a closed month."], values: { reason } };
  const r = await reopenMonth(getDb(), ws, month, { id: user.id }, reason);
  if (!r.ok) return { problems: [r.reason], values: { reason } };
  refresh(slug);
  redirect(`/w/${slug}/close/${month}?reopened=1`);
}

/** Demo help: last month's SIMULATED bank statements, built from the books, uploaded and read at once. */
export async function uploadSampleStatements(slug: string, month: string) {
  const { user, ws } = await actor(slug);
  if (!ws.isDemo || !isMonth(month)) redirect(`/w/${slug}/close/${month}`);
  const deps = engineDeps();
  const samples = await sampleStatements(deps.db, ws);
  let added = 0;
  for (const s of samples) if ((await addUpload(deps, ws, { name: s.name, bytes: s.bytes }, { kindHint: "statement", userId: user.id })).status === "added") added++;
  const back = new URLSearchParams({ samples: String(samples.length) });
  if (added) back.set("run", await startRun(ws.id, "manual", user.id));
  refresh(slug);
  redirect(`/w/${slug}/close/${month}?${back}`);
}
