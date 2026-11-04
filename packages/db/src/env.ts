import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./storage";

/**
 * Local development keeps one .env at the repo root (copied from .env.example). Variables that
 * are already set win. Deployed containers have no .env; they get real environment variables.
 */
export function loadLocalEnv(): void {
  const file = join(/*turbopackIgnore: true*/ repoRoot(), ".env");
  if (existsSync(/*turbopackIgnore: true*/ file)) process.loadEnvFile(file);
}
