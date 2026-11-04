import { readersFromEnv } from "@ebo/ai";
import { getDb, storageFromEnv } from "@ebo/db";
import { defaultDeps, imapReader, mailboxMailer, offlineReaders, type EngineDeps } from "@ebo/engine";

/**
 * Engine dependencies from the environment: database, document storage, the readers
 * (Vultr Serverless Inference when VULTR_INFERENCE_API_KEY is set, else the offline rules),
 * and each workspace's own mailbox when one is connected (IMAP in, SMTP out).
 */
export function depsFromEnv(env: Record<string, string | undefined> = process.env): EngineDeps {
  const model = readersFromEnv(env);
  return defaultDeps({ db: getDb(), storage: storageFromEnv(env), env, readers: model ? { document: model.document, intent: model.intent } : offlineReaders, mailer: mailboxMailer(getDb(), env), mailbox: imapReader(env) });
}
