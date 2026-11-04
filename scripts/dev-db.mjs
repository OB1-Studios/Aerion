// Local PostgreSQL for development, with no Docker or system install needed.
// Data lives in ./.pgdata (gitignored). Stop with Ctrl+C.
//
//   pnpm dev:db
//   DATABASE_URL=postgres://ebo:ebo@localhost:54329/ebo
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../.pgdata");
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port,
  user: "ebo",
  password: "ebo",
  authMethod: "scram-sha-256",
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  // Laptop settings: the demo database is tiny, so keep Postgres small (defaults suit a server).
  postgresFlags: [
    "-c", "shared_buffers=32MB",
    "-c", "max_connections=40",
    "-c", "work_mem=2MB",
    "-c", "maintenance_work_mem=16MB",
    "-c", "max_worker_processes=4",
    "-c", "max_parallel_workers_per_gather=0",
    "-c", "autovacuum_max_workers=1",
    "-c", "jit=off",
  ],
  onLog: () => {},
  onError: (e) => console.error(String(e)),
});

if (!existsSync(resolve(dir, "PG_VERSION"))) {
  console.log(`Creating a new database cluster in ${dir} …`);
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("ebo");
  console.log('Created database "ebo".');
} catch {
  // Already exists.
}
console.log(`PostgreSQL is running: postgres://ebo:ebo@localhost:${port}/ebo  (Ctrl+C to stop)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
