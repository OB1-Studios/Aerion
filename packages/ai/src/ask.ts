import { ASK_TOOLS, type AskPlanner, type AskScope, type ModelCallRecord } from "@ebo/engine";
import { parseJsonObject, type ChatMessage, type InferenceClient } from "./client";
import { LIST_PRICES } from "./catalog";

/** Bumped whenever the planner prompt changes, so recorded calls can be told apart. */
export const ASK_PROMPT_VERSION = "ask-1";

const TOOL_TEXT: Record<(typeof ASK_TOOLS)[number], string> = {
  owed: "what clients owe now, open invoice by invoice (optionally one client)",
  overdue: "invoices past their due date now (optionally one client)",
  received: "money received in a period, payment by payment (optionally one client; give from/to)",
  proceeds: "export proceeds credited to Pakistani bank accounts, by month (give from/to)",
  banking_share: "the share of this tax year's export proceeds that came through Pakistani banks",
  missing_paperwork: "ePRCs and withholding certificates still missing for payments (optionally one client)",
  cost: "what getting paid cost this tax year: bank fees and conversion below the reference rate, by route and client (optionally one client)",
  days_to_pay: "how long clients take to pay, median days from invoice to payment (optionally one client)",
  invoice: "everything about one invoice: amount, payments, balance, open problems (give invoice_number)",
};

export const ASK_SYSTEM = `You route a question about a small business's books to exactly one read-only query. You never answer the question yourself and never write an amount: code computes the answer from the records.

Queries:
${ASK_TOOLS.map((t) => `- ${t}: ${TOOL_TEXT[t]}`).join("\n")}

Reply with one JSON object and nothing else:
{"tool": one of the query names above, or null when none of them answers the question,
 "client": the number of the client from the list when the question is about one client, else null,
 "invoice_number": the invoice number exactly as the question writes it, else null,
 "from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null (only for received and proceeds; work them out from today's date)}

Use null for anything the question doesn't say. Questions that ask for advice, predictions, changes to the records, or anything outside these queries get "tool": null.`;

export function askMessage(question: string, scope: AskScope): string {
  return [
    `Today is ${scope.today}. The tax year ${scope.taxYear.label} runs from ${scope.taxYear.start} to ${scope.taxYear.end}.`,
    `Clients:\n${scope.clients.map((c, i) => `${i + 1}. ${c.name}${c.aliases.length ? ` (also written: ${c.aliases.slice(0, 3).join("; ")})` : ""}`).join("\n") || "(none yet)"}`,
    `Question: ${JSON.stringify(question)}`,
  ].join("\n\n");
}

export interface ModelAskPlannerOptions {
  client: InferenceClient;
  model: string;
  jsonMode?: "object" | "schema";
  usdPerMillionInput?: number;
  usdPerMillionOutput?: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "client", "invoice_number", "from", "to"],
  properties: {
    tool: { type: ["string", "null"], enum: [...ASK_TOOLS, null] },
    client: { type: ["integer", "null"] },
    invoice_number: { type: ["string", "null"] },
    from: { type: ["string", "null"] },
    to: { type: ["string", "null"] },
  },
} as const;

/**
 * A planner on Vultr Serverless Inference. It sends the question, today's date and the
 * client names (no amounts, documents or emails), and gets back only a query choice, which the
 * engine checks before using. One retry when the reply isn't JSON; every call is recorded.
 */
export function modelAskPlanner(o: ModelAskPlannerOptions): AskPlanner {
  const price = LIST_PRICES[o.model];
  const inRate = o.usdPerMillionInput ?? price?.input ?? 0;
  const outRate = o.usdPerMillionOutput ?? price?.output ?? 0;
  return {
    model: o.model,
    async plan(question, scope) {
      const calls: ModelCallRecord[] = [];
      const base: ChatMessage[] = [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: askMessage(question, scope) },
      ];
      let messages = base;
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        let res;
        try {
          res = await o.client.chat({ model: o.model, messages, maxTokens: 3000, json: o.jsonMode === "schema" ? { mode: "schema", name: "ask_plan", schema: SCHEMA as unknown as Record<string, unknown> } : { mode: "object" } });
        } catch (err) {
          calls.push({ purpose: "assistant", model: o.model, inputTokens: 0, outputTokens: 0, costUsd: "0", latencyMs: Date.now() - started, ok: false, error: (err as Error).message.slice(0, 500) });
          return { raw: null, calls };
        }
        const costUsd = ((res.inputTokens * inRate + res.outputTokens * outRate) / 1_000_000).toFixed(6);
        try {
          const raw = parseJsonObject(res.content);
          calls.push({ purpose: "assistant", model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd, latencyMs: res.latencyMs, ok: true });
          return { raw, calls };
        } catch (err) {
          const why = res.truncated ? "cut off at the token limit" : (err as Error).message;
          calls.push({ purpose: "assistant", model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd, latencyMs: res.latencyMs, ok: false, error: `unusable reply: ${why}`.slice(0, 500) });
          messages = [...base, { role: "assistant", content: res.content.slice(0, 2000) }, { role: "user", content: `That reply could not be used (${why}). Reply again with only the JSON object.` }];
        }
      }
      return { raw: null, calls };
    },
  };
}
