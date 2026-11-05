import "server-only";
import type { IsoDate } from "@ebo/core";
import { exportJob, getDb, user } from "@ebo/db";
import { gatherTaxPack, loadContext, taxYearFile as fileFor, type Workspace } from "@ebo/engine";
import { and, desc, eq } from "drizzle-orm";

export { creditsCsv, shareCsv, toCsv, type CreditLine } from "@ebo/engine";

/** The tax-year file (engine/tax-file.ts) for the current tax year, or the one `yearStart` falls in. */
export async function taxYearFile(ws: Workspace, yearStart?: IsoDate) {
  const db = getDb();
  return fileFor(db, await loadContext(db, ws.id), yearStart);
}

/** What the year's tax pack would hold (the tax-year file is part of it), without reading any files. */
export async function taxPackPreview(ws: Workspace, yearStart?: IsoDate) {
  const db = getDb();
  const { file, summary } = await gatherTaxPack(db, null, await loadContext(db, ws.id), yearStart);
  return { file, summary };
}

/** Packs built for the workspace, newest first, with who built them. */
export async function builtPacks(workspaceId: string) {
  const rows = await getDb()
    .select({ id: exportJob.id, period: exportJob.period, status: exportJob.status, createdAt: exportJob.createdAt, by: user.name, anon: user.isAnonymous })
    .from(exportJob)
    .leftJoin(user, eq(user.id, exportJob.requestedBy))
    .where(and(eq(exportJob.workspaceId, workspaceId), eq(exportJob.kind, "tax_pack")))
    .orderBy(desc(exportJob.createdAt))
    .limit(12);
  return rows.map(({ anon, ...r }) => ({ ...r, by: anon ? "Visitor" : r.by }));
}
