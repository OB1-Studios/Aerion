import createClient from "openapi-fetch";
import type { paths } from "./schema";

export type VultrPaths = paths;
export type VultrClient = ReturnType<typeof createVultrClient>;

export const VULTR_API_BASE = "https://api.vultr.com/v2";

export class VultrApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    const detail =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "";
    super(`Vultr API ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "VultrApiError";
  }
}

/**
 * fetch with retries for rate limits (429) and transient server errors.
 * Vultr rate-limits the API per account, so bursts during provisioning are expected.
 */
export function fetchWithRetry(baseFetch: typeof fetch = fetch, maxAttempts = 5): typeof fetch {
  return async (input, init) => {
    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        // A Request body can only be read once, so clone it for every attempt.
        const req = input instanceof Request ? input.clone() : input;
        const res = await baseFetch(req, init);
        if (res.status !== 429 && res.status < 500) return res;
        if (attempt >= maxAttempts) return res;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts) throw err;
        await sleep(backoff(attempt));
      }
    }
    throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
  };
}

function backoff(attempt: number): number {
  return Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface VultrClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Typed client for the Vultr API v2, generated from Vultr's OpenAPI spec.
 * Every path, parameter and response body is checked by TypeScript.
 */
export function createVultrClient(apiKey: string, opts: VultrClientOptions = {}) {
  if (!apiKey) throw new Error("createVultrClient: an API key is required");
  const client = createClient<paths>({
    baseUrl: opts.baseUrl ?? VULTR_API_BASE,
    fetch: fetchWithRetry(opts.fetch ?? fetch),
  });
  client.use({
    onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${apiKey}`);
      return request;
    },
  });
  return client;
}

/** Throws a VultrApiError unless the call succeeded; returns the parsed body. */
export function unwrap<T>(
  result: { data?: T; error?: unknown; response: Response },
  label?: string,
): T {
  const { data, error, response } = result;
  if (!response.ok || error !== undefined) {
    const url = new URL(response.url || "http://unknown");
    throw new VultrApiError(response.status, label ?? "request", url.pathname, error);
  }
  return data as T;
}

/** Follows Vultr's cursor pagination (meta.links.next) and returns every item. */
export async function listAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next?: string | undefined }>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(cursor);
    out.push(...items);
    if (!next) break;
    cursor = next;
  }
  return out;
}
