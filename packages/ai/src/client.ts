/**
 * Minimal client for Vultr Serverless Inference, which speaks the OpenAI chat-completions
 * protocol at https://api.vultrinference.com/v1. Plain fetch: no SDK, nothing to keep in sync.
 */

export const VULTR_INFERENCE_URL = "https://api.vultrinference.com/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  /** JSON output: "object" asks for any JSON object; "schema" also sends the JSON schema (strict mode, if the model supports it). */
  json?: { mode: "object" } | { mode: "schema"; name: string; schema: Record<string, unknown> };
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** The model stopped at the token limit (finish_reason "length"), so the reply may be incomplete or empty. */
  truncated?: boolean;
}

/**
 * Reasoning models count their hidden reasoning against max_tokens. On the answer key,
 * minimax-m3.1-flash used up to about 1,100 tokens per call when it finished, and a limit of 2,000
 * cut off the first attempt on 12 of 61 documents (2026-11-07).
 */
export const DEFAULT_MAX_TOKENS = 6000;

export class InferenceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface InferenceClient {
  readonly baseUrl: string;
  chat(opts: ChatOptions): Promise<ChatResult>;
  models(): Promise<string[]>;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Attempts for rate limits and server errors (with backoff). */
  maxAttempts?: number;
  fetch?: typeof fetch;
}

export function inferenceClient(o: ClientOptions): InferenceClient {
  const baseUrl = (o.baseUrl ?? VULTR_INFERENCE_URL).replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  const attempts = o.maxAttempts ?? 3;
  const headers = { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" };

  async function call(path: string, init: RequestInit): Promise<unknown> {
    let last: InferenceError | null = null;
    for (let i = 0; i < attempts; i++) {
      if (i) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
      let res: Response;
      try {
        res = await f(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
      } catch (err) {
        last = new InferenceError(`request failed: ${(err as Error).message}`, null);
        continue;
      }
      if (res.ok) return res.json();
      const body = (await res.text()).slice(0, 300);
      last = new InferenceError(`HTTP ${res.status}: ${body}`, res.status);
      if (res.status !== 429 && res.status < 500) break; // a bad request won't get better
    }
    throw last ?? new InferenceError("request failed", null);
  }

  return {
    baseUrl,
    async chat(opts) {
      const started = Date.now();
      const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, temperature: 0, max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS };
      if (opts.json?.mode === "object") body.response_format = { type: "json_object" };
      if (opts.json?.mode === "schema") body.response_format = { type: "json_schema", json_schema: { name: opts.json.name, schema: opts.json.schema, strict: true } };
      const data = (await call("/chat/completions", { method: "POST", body: JSON.stringify(body) })) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new InferenceError("the response had no message content", null);
      return {
        content,
        model: data.model ?? opts.model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    },
    async models() {
      const data = (await call("/models", { method: "GET" })) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
    },
  };
}

/**
 * The first complete JSON object in a reply. Models sometimes wrap it in prose or a code fence,
 * and some repeat it until the token limit, so read up to the brace that closes the first one.
 */
export function parseJsonObject(content: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1];
  const text = (fenced ?? content).trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object in the reply");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
  }
  throw new Error("the JSON object in the reply is not complete");
}
