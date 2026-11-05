"use server";

import { isIsoDate } from "@ebo/core";
import { getDb, storageFromEnv } from "@ebo/db";
import { buildTaxPack } from "@ebo/engine";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/forms";
import { canExport, requireWorkspace } from "@/lib/session";

/** Builds the year-end tax pack (W27) and keeps it in storage. Viewers can download packs but not build them. */
export async function buildTaxPackAction(slug: string, yearStart: string | null, _prev: FormState, _form: FormData): Promise<FormState> {
  const { user, ws, role } = await requireWorkspace(slug);
  if (!canExport(role)) return { problems: ["Your role can download tax packs but not build them."], values: null };
  const year = yearStart && isIsoDate(yearStart) ? yearStart : undefined;
  let r: Awaited<ReturnType<typeof buildTaxPack>>;
  try {
    r = await buildTaxPack(getDb(), storageFromEnv(), ws, { yearStart: year, by: { id: user.id, name: user.name } });
  } catch (err) {
    console.error("tax pack build failed", err);
    return { problems: ["The pack couldn't be saved to storage, so nothing was built. Try again in a minute."], values: null };
  }
  if (!r.ok) return { problems: [r.reason], values: null };
  revalidatePath(`/w/${slug}/export`);
  redirect(`/w/${slug}/export?${new URLSearchParams({ ...(year ? { year } : {}), built: r.jobId })}#packs`);
}
