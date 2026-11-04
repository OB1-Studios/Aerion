import { getPool, loadLocalEnv, workspace } from "@ebo/db";
import { resetSharedDemo } from "@ebo/db/seed";
import { advanceDemoClock, runWorkspace } from "@ebo/engine";
import { eq } from "drizzle-orm";
import { depsFromEnv } from "./deps";

/**
 * pnpm --filter @ebo/worker cli <command>
 *   run <slug>         run the workflow now, in this process
 *   next-week <slug>   move a demo workspace's clock on 7 days, then run
 *   reset-demo         reload the shared demo workspaces (needs DEMO_PASSWORD)
 */
const [cmd, slug] = process.argv.slice(2);
loadLocalEnv();
const deps = depsFromEnv();

async function bySlug(s: string | undefined) {
  if (!s) throw new Error("give a workspace slug");
  const [ws] = await deps.db.select().from(workspace).where(eq(workspace.slug, s));
  if (!ws) throw new Error(`no workspace ${s}`);
  return ws;
}

async function main() {
  if (cmd === "run" || cmd === "next-week") {
    const ws = await bySlug(slug);
    if (cmd === "next-week") console.log(`clock -> ${(await advanceDemoClock(deps.db, ws.id)).toISOString()}`);
    const r = await runWorkspace(deps, ws.id, { kind: "manual" });
    console.log(`${r.status}${r.error ? `: ${r.error}` : ""}\n${r.summary}`);
  } else if (cmd === "reset-demo") {
    if (!process.env.DEMO_PASSWORD) throw new Error("set DEMO_PASSWORD");
    console.log(await resetSharedDemo(deps.db, deps.storage, process.env.DEMO_PASSWORD));
  } else {
    console.log("commands: run <slug> | next-week <slug> | reset-demo");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
