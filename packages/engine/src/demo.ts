import { workspace, type Db } from "@ebo/db";
import { eq } from "drizzle-orm";
import { audit } from "./context";

/**
 * Demo controls: demo workspaces run on a simulated clock, so the follow-up week is just
 * the clock moving on (mailbox items arrive when their time comes).
 */
export async function advanceDemoClock(db: Db, workspaceId: string, days = 7, actorId: string | null = null): Promise<Date> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId));
  if (!ws?.isDemo || !ws.demoClock) throw new Error("only demo workspaces have a simulated clock");
  const next = new Date(ws.demoClock.getTime() + days * 86_400_000);
  await db.update(workspace).set({ demoClock: next }).where(eq(workspace.id, workspaceId));
  await audit(db, { workspaceId, actorType: actorId ? "user" : "system", actorId, action: "demo.clock_advanced", objectType: "workspace", objectId: workspaceId, details: { from: ws.demoClock.toISOString(), to: next.toISOString() } });
  return next;
}
