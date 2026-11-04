import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { workspace } from "./schema";
import { workspacePrefix, type Storage } from "./storage";

/**
 * Deletes a workspace and everything in it (cascades), including its audit trail and stored files.
 * The audit table refuses deletes unless `app.workspace_purge` is on for the transaction,
 * so nothing else can remove audit rows by accident.
 */
export async function purgeWorkspace(db: Db, storage: Storage | null, workspaceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_purge', 'on', true)`);
    await tx.delete(workspace).where(eq(workspace.id, workspaceId));
  });
  if (storage) await storage.deletePrefix(workspacePrefix(workspaceId));
}
