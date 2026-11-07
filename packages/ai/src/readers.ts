import { weekday } from "@ebo/core";
import type { DocumentKind } from "@ebo/db";
import {
  classifyOffline,
  offlineDocumentReader,
  offlineIntentReader,
  readIntentsOffline,
  workspaceMatch,
  type Classification,
  type DocumentReader,
  type Intent,
  type IntentReader,
  type ModelCallRecord,
  type Readers,
} from "@ebo/engine";
import { parseJsonObject, type ChatMessage, type ChatResult, type InferenceClient } from "./client";
import { extractionSchema, FIELDS, MT103_FIELDS, normalizeExtraction, type FieldSpec } from "./fields";
import { CLASSIFY_KINDS, CLASSIFY_SYSTEM, classifyMessage, EXTRACT_SYSTEM, extractMessage, INTENT_SYSTEM, intentMessage, PROMPT_VERSIONS } from "./prompts";

export interface ModelReaderOptions {
  client: InferenceClient;
  /** Model for extraction and email intents. */
  model: string;
  /** Smaller model for classification (defaults to `model`). */
  classifyModel?: string;
  /** "object" (default): JSON mode plus the schema in the prompt. "schema": strict json_schema, where the model supports it. */
  jsonMode?: "object" | "schema";
  /** USD per million tokens, for the cost column of the run timeline (0 if unknown). */
  usdPerMillionInput?: number;
  usdPerMillionOutput?: number;
}

/** Layouts code reads itself (build kit decision 1): CSV exports never go to a model. */
const CODE_KINDS = new Set<DocumentKind>(["payoneer_export", "marketplace_export", "statement"]);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Document and email readers backed by Vultr Serverless Inference. Every call is recorded
 * (tokens, cost, time). If the model can't be reached or returns unusable JSON twice, the
 * reader falls back to the offline rules so a run never stops on the model; the failed
 * calls still show on the timeline.
 */
export function modelReaders(o: ModelReaderOptions): Readers {
  const calls = (records: ModelCallRecord[]) => records;
  const cost = (r: Pick<ChatResult, "inputTokens" | "outputTokens">) =>
    ((r.inputTokens * (o.usdPerMillionInput ?? 0) + r.outputTokens * (o.usdPerMillionOutput ?? 0)) / 1_000_000).toFixed(6);

  /** One JSON call with one retry that tells the model what was wrong (build kit section 2, step 4). */
  async function jsonCall<T>(
    purpose: ModelCallRecord["purpose"],
    model: string,
    messages: ChatMessage[],
    parse: (raw: Record<string, unknown>) => T,
    schema: { name: string; schema: Record<string, unknown> } | null,
    log: ModelCallRecord[],
    maxTokens?: number,
  ): Promise<T> {
    let convo = messages;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      let res: ChatResult;
      try {
        res = await o.client.chat({ model, messages: convo, maxTokens, json: o.jsonMode === "schema" && schema ? { mode: "schema", ...schema } : { mode: "object" } });
      } catch (err) {
        log.push({ purpose, model, inputTokens: 0, outputTokens: 0, costUsd: "0", latencyMs: Date.now() - started, ok: false, error: (err as Error).message.slice(0, 500) });
        throw err;
      }
      try {
        const value = parse(parseJsonObject(res.content));
        log.push({ purpose, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost(res), latencyMs: res.latencyMs, ok: true });
        return value;
      } catch (err) {
        lastError = (err as Error).message;
        log.push({ purpose, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost(res), latencyMs: res.latencyMs, ok: false, error: `unusable reply: ${lastError}`.slice(0, 500) });
        convo = [...messages, { role: "assistant", content: res.content.slice(0, 4000) }, { role: "user", content: `That reply could not be used (${lastError}). Reply again with only the JSON object, matching the schema.` }];
      }
    }
    throw new Error(`unusable reply twice: ${lastError}`);
  }

  const document: DocumentReader = {
    name: "vultr",
    async read(doc, ctx) {
      const offline = classifyOffline(doc, ctx);
      // CSVs are parsed by code; without a text layer there is nothing to send (images need OCR first).
      if (CODE_KINDS.has(offline.kind) || !doc.text) return offlineDocumentReader.read(doc, ctx);
      const log: ModelCallRecord[] = [];
      try {
        const classification = await jsonCall(
          "classify",
          o.classifyModel ?? o.model,
          [
            { role: "system", content: CLASSIFY_SYSTEM },
            { role: "user", content: classifyMessage(doc.name, doc.text, ctx) },
          ],
          (raw): Classification => {
            const kind = String(raw.kind ?? "");
            if (!(kind in CLASSIFY_KINDS)) throw new Error(`unknown kind "${kind}"`);
            const confidence = raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low";
            // Whether the document is ours is checked by code too: the model's opinion can only lower it.
            const byCode = workspaceMatch(doc.text ?? "", ctx);
            const byModel = raw.workspace_match === "yes" || raw.workspace_match === "no" ? raw.workspace_match : "unsure";
            return { kind: kind as DocumentKind, confidence, workspaceMatch: byCode === "yes" && byModel !== "no" ? "yes" : byCode === "yes" ? "unsure" : "no", reason: String(raw.reason ?? "").slice(0, 300) };
          },
          null,
          log,
        );
        const spec: FieldSpec | undefined = classification.kind === "other" ? (/MT103|:32A:/.test(doc.text) ? MT103_FIELDS : undefined) : FIELDS[classification.kind];
        if (!spec) return { classification, extraction: null, model: o.model, promptVersion: PROMPT_VERSIONS.classify, calls: calls(log) };
        const schema = extractionSchema(spec);
        const { extraction } = await jsonCall(
          "extract",
          o.model,
          [
            { role: "system", content: EXTRACT_SYSTEM },
            { role: "user", content: extractMessage(classification.kind, schema, doc.text, ctx) },
          ],
          (raw) => normalizeExtraction(classification.kind, spec, raw),
          { name: `extract_${classification.kind}`, schema },
          log,
        );
        return { classification, extraction, model: o.model, promptVersion: `${PROMPT_VERSIONS.extract}.${classification.kind}`, calls: calls(log) };
      } catch {
        const fallback = await offlineDocumentReader.read(doc, ctx);
        return { ...fallback, model: `${fallback.model} (model unavailable)`, calls: [...log, ...fallback.calls] };
      }
    },
  };

  const intent: IntentReader = {
    name: "vultr",
    async read(msg, ctx) {
      // Forwarded senders and UETRs are found by code; the model reads what the sender is saying.
      const rules = readIntentsOffline(msg);
      if (!msg.body?.trim()) return offlineIntentReader.read(msg, ctx);
      const log: ModelCallRecord[] = [];
      try {
        const result = await jsonCall(
          "intent",
          o.model,
          [
            { role: "system", content: INTENT_SYSTEM },
            { role: "user", content: intentMessage(msg.from, msg.subject, msg.body, msg.receivedOn, WEEKDAYS[weekday(msg.receivedOn)]!) },
          ],
          (raw) => {
            if (!Array.isArray(raw.intents)) throw new Error('"intents" is not a list');
            const intents: Intent[] = raw.intents.flatMap((x): Intent[] => {
              const it = x as Record<string, unknown>;
              const kind = String(it.kind ?? "other") as Intent["kind"];
              if (!["payment_claim", "promise_to_pay", "dispute", "bank_detail_change", "remittance_advice", "question", "other"].includes(kind)) return [];
              const amount = typeof it.amount === "string" && /^-?\d+(\.\d{1,2})?$/.test(it.amount.replace(/,/g, "")) ? it.amount.replace(/,/g, "") : null;
              const date = typeof it.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : null;
              const numbers = Array.isArray(it.invoice_numbers) ? it.invoice_numbers.filter((n): n is string => typeof n === "string").map((n) => n.toUpperCase().replace(/\s+/g, "-")) : [];
              return [{ kind, invoiceNumbers: numbers, amount, currency: typeof it.currency === "string" && /^[A-Z]{3}$/.test(it.currency) ? it.currency : null, date: kind === "payment_claim" ? (date ?? msg.receivedOn) : date, quote: String(it.quote ?? "").slice(0, 500) }];
            });
            return {
              intents,
              mentionsNewBankDetails: raw.mentions_new_bank_details === true || rules.mentionsNewBankDetails,
              forwardedFrom: rules.forwardedFrom,
              uetr: rules.uetr,
              requestsActionFromUs: typeof raw.requests_action_from_us === "string" ? raw.requests_action_from_us.slice(0, 300) : null,
            };
          },
          null,
          log,
          // A reply is a few hundred tokens. A model that starts repeating itself is cut off early.
          800,
        );
        return { result, model: o.model, promptVersion: PROMPT_VERSIONS.intent, calls: log };
      } catch {
        const fallback = await offlineIntentReader.read(msg, ctx);
        return { ...fallback, model: `${fallback.model} (model unavailable)`, calls: [...log, ...fallback.calls] };
      }
    },
  };

  return { document, intent };
}
