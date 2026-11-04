// Light local mode for a laptop: one production web process that also runs the workflow
// (RUNS_INLINE=1). No dev compiler, no separate worker. Rebuilds only when the source changed.
//
//   pnpm local            serve http://localhost:3000 (builds first if needed)
//   pnpm local --build    rebuild before serving
//
// Needs the database (`pnpm dev:db`) and the repo's .env. LOCAL_HEAP_MB caps the server's heap.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const web = join(root, "apps/web");
const standalone = join(web, ".next/standalone");
const server = join(standalone, "apps/web/server.js");
const buildId = join(web, ".next/BUILD_ID");

const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Newest modification time under the given paths (files or folders). */
function newest(paths) {
  let max = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (!st.isDirectory()) {
      max = Math.max(max, st.mtimeMs);
      continue;
    }
    for (const e of readdirSync(p, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
    }
  }
  return max;
}

const sources = [
  "apps/web/src",
  "apps/web/next.config.ts",
  "apps/web/package.json",
  "pnpm-lock.yaml",
  ...["ai", "core", "db", "engine", "vultr"].map((p) => `packages/${p}/src`),
].map((p) => join(root, p));

const why = process.argv.includes("--build")
  ? "asked to rebuild"
  : !existsSync(server) || !existsSync(buildId)
    ? "no build yet"
    : newest(sources) > statSync(buildId).mtimeMs
      ? "the source changed since the last build"
      : null;

if (why) {
  console.log(`Building the app (${why}); this takes about a minute.`);
  const r = spawnSync("pnpm", ["--filter", "@ebo/web", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    // Sign-in secrets are read at run time; the placeholder only keeps the build log quiet.
    env: { ...process.env, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "local-build-placeholder", NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// The standalone server serves the static files from next to itself.
rmSync(join(standalone, "apps/web/.next/static"), { recursive: true, force: true });
cpSync(join(web, ".next/static"), join(standalone, "apps/web/.next/static"), { recursive: true });

const port = process.env.PORT || "3000";
const child = spawn(process.execPath, [`--max-old-space-size=${process.env.LOCAL_HEAP_MB || 384}`, server], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: port,
    HOSTNAME: "127.0.0.1",
    RUNS_INLINE: "1",
    DB_POOL_MAX: process.env.DB_POOL_MAX || "4",
    STORAGE_DIR: process.env.STORAGE_DIR || join(root, ".storage"),
  },
});
console.log(`Serving http://localhost:${port} (production build, workflow runs inside this process). Ctrl+C to stop.`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
