import { randomBytes } from "node:crypto";
import { createDb, createPool } from "../client";
import { loadLocalEnv } from "../env";
import { storageFromEnv } from "../storage";
import { DEMO_PEOPLE, DEMO_SLUGS, resetSharedDemo } from "./index";

/**
 * pnpm seed: reloads the shared demo workspaces (all data fictional).
 * DEMO_PASSWORD sets the demo users' password; without it a random one is printed.
 */
async function main() {
  loadLocalEnv();
  const pool = createPool(undefined, 2);
  const db = createDb(pool);
  const storage = storageFromEnv();
  const password = process.env.DEMO_PASSWORD || randomBytes(9).toString("base64url");
  try {
    const t0 = Date.now();
    const ids = await resetSharedDemo(db, storage, password);
    console.log(`Seeded in ${Date.now() - t0} ms (storage: ${storage.kind})`);
    console.log(`  ${DEMO_SLUGS.office}: ${ids.office}`);
    console.log(`  ${DEMO_SLUGS.freelancer}: ${ids.freelancer}`);
    console.log("Demo users:", Object.values(DEMO_PEOPLE).map((p) => p.email).join(", "));
    if (!process.env.DEMO_PASSWORD) console.log(`Password (random, set DEMO_PASSWORD to choose one): ${password}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
