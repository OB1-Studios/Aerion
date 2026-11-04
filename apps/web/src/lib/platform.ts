import "server-only";
import { createVultrClient, platformStatus, vultrResources, type PlatformStatus } from "@ebo/vultr";

let cached: { at: number; status: PlatformStatus } | null = null;

/**
 * Live status of the Vultr resources running this deployment (VM, Managed PostgreSQL,
 * Object Storage, Serverless Inference usage), read through the Vultr API. Needs
 * VULTR_API_KEY plus the resource ids that `pnpm infra:apply` writes to the app's env.
 * Cached for a minute so the settings page doesn't call the API on every view.
 */
export async function vultrStatus(): Promise<PlatformStatus | null> {
  const key = process.env.VULTR_API_KEY;
  if (!key) return null;
  if (cached && Date.now() - cached.at < 60_000) return cached.status;
  const r = vultrResources(createVultrClient(key));
  const status = await platformStatus(r, {
    instanceId: process.env.VULTR_INSTANCE_ID,
    databaseId: process.env.VULTR_DATABASE_ID,
    objectStorageId: process.env.VULTR_OBJECT_STORAGE_ID,
    inferenceId: process.env.VULTR_INFERENCE_ID,
  });
  cached = { at: Date.now(), status };
  return status;
}

/** How documents are read in this deployment. */
export function readerInfo(): { mode: "vultr" | "offline"; model: string | null } {
  return process.env.VULTR_INFERENCE_API_KEY ? { mode: "vultr", model: process.env.VULTR_INFERENCE_MODEL ?? "default" } : { mode: "offline", model: null };
}
