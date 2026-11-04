/**
 * List prices in USD per million tokens (input / output), copied from Vultr Serverless
 * Inference's public model list on 2026-10-29. Prices change: `pnpm --filter @ebo/ai models`
 * shows what the key can use today, and VULTR_INFERENCE_USD_PER_M_IN / _OUT override these.
 */
export const LIST_PRICES: Record<string, { input: number; output: number }> = {
  "glm-5.3-flash": { input: 0.1, output: 0.35 },
  "qwen3.8-flash-next": { input: 0.1, output: 0.2 },
  "nemotron-3-nano-omni-30b-a3b-reasoning": { input: 0.1, output: 0.25 },
  "deepseek-v4.1-flash-1017": { input: 0.15, output: 0.6 },
  "glm-5.3": { input: 0.75, output: 3 },
  "mimo-v2.6-pro": { input: 0.4, output: 0.8 },
  "minimax-m3.1-flash": { input: 0.2, output: 0.9 },
};

/** Models worth comparing for reading documents (build plan, "Models on Vultr"); `bench --models candidates` runs the ones the key can use. */
export const CANDIDATE_MODELS = ["glm-5.3-flash", "qwen3.8-flash-next", "nemotron-3-nano-omni-30b-a3b-reasoning", "deepseek-v4.1-flash-1017", "glm-5.3", "mimo-v2.6-pro"];
