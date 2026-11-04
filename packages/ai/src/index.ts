import type { Readers } from "@ebo/engine";
import { inferenceClient } from "./client";
import { modelReaders } from "./readers";

export * from "./client";
export * from "./fields";
export * from "./prompts";
export * from "./readers";

/** Model named in the build kit; set VULTR_INFERENCE_MODEL to whatever `pnpm --filter @ebo/ai models` lists. */
export const DEFAULT_MODEL = "glm-5.3-flash";

/**
 * Readers backed by Vultr Serverless Inference when VULTR_INFERENCE_API_KEY is set, otherwise
 * null (the caller keeps the offline rules). Settings:
 *   VULTR_INFERENCE_MODEL           extraction and email model
 *   VULTR_INFERENCE_CLASSIFY_MODEL  classification model (defaults to the above)
 *   VULTR_INFERENCE_JSON_MODE       "object" (default) or "schema" (strict json_schema)
 *   VULTR_INFERENCE_URL             defaults to https://api.vultrinference.com/v1
 *   VULTR_INFERENCE_USD_PER_M_IN / _OUT   prices for the cost column, if known
 */
export function readersFromEnv(env: Record<string, string | undefined> = process.env): (Readers & { model: string }) | null {
  const apiKey = env.VULTR_INFERENCE_API_KEY;
  if (!apiKey) return null;
  const model = env.VULTR_INFERENCE_MODEL || DEFAULT_MODEL;
  const readers = modelReaders({
    client: inferenceClient({ apiKey, baseUrl: env.VULTR_INFERENCE_URL || undefined }),
    model,
    classifyModel: env.VULTR_INFERENCE_CLASSIFY_MODEL || undefined,
    jsonMode: env.VULTR_INFERENCE_JSON_MODE === "schema" ? "schema" : "object",
    usdPerMillionInput: Number(env.VULTR_INFERENCE_USD_PER_M_IN ?? 0) || 0,
    usdPerMillionOutput: Number(env.VULTR_INFERENCE_USD_PER_M_OUT ?? 0) || 0,
  });
  return { ...readers, model };
}
