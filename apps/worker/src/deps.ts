import { readersFromEnv } from "@ebo/ai";
import { getDb, storageFromEnv } from "@ebo/db";
import { defaultDeps, offlineReaders, type EngineDeps } from "@ebo/engine";

/**
 * Engine dependencies from the environment: database, document storage, and the readers
 * (Vultr Serverless Inference when VULTR_INFERENCE_API_KEY is set, else the offline rules).
 */
export function depsFromEnv(env: Record<string, string | undefined> = process.env): EngineDeps {
  const model = readersFromEnv(env);
  return defaultDeps({ db: getDb(), storage: storageFromEnv(env), env, readers: model ? { document: model.document, intent: model.intent } : offlineReaders });
}
