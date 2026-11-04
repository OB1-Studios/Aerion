import "server-only";
import { canAct, requireWorkspace } from "./session";

/** The signed-in member, if their role may change things here (owners for settings and accounts). */
export async function actor(slug: string, need: "act" | "own" = "act") {
  const m = await requireWorkspace(slug);
  if (need === "own" ? m.role !== "owner" : !canAct(m.role)) throw new Error(need === "own" ? "Only the workspace owner can change this." : "Your role can view this workspace but not change it.");
  return m;
}
