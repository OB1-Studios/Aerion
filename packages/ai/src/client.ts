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
}

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
      const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, temperature: 0, max_tokens: opts.maxTokens ?? 2000 };
      if (opts.json?.mode === "object") body.response_format = { type: "json_object" };
      if (opts.json?.mode === "schema") body.response_format = { type: "json_schema", json_schema: { name: opts.json.name, schema: opts.json.schema, strict: true } };
      const data = (await call("/chat/completions", { method: "POST", body: JSON.stringify(body) })) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new InferenceError("the response had no message content", null);
      return { content, model: data.model ?? opts.model, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, latencyMs: Date.now() - started };
    },
    async models() {
      const data = (await call("/models", { method: "GET" })) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
    },
  };
}

/** The first JSON object in a reply (models sometimes wrap JSON in prose or code fences). */
export function parseJsonObject(content: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1];
  const text = (fenced ?? content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the reply is not a JSON object");
  return value as Record<string, unknown>;
}
