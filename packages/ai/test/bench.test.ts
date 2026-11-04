import { answerKey, type AnswerDoc } from "@ebo/db/seed";
import { documentText, offlineDocumentReader } from "@ebo/engine";
import { describe, expect, it } from "vitest";
import { benchmark, benchMarkdown, modelReaders, scoreValue, specFor, type InferenceClient } from "../src";

const misses = (runScores: Awaited<ReturnType<typeof benchmark>>[number]["scores"]) =>
  runScores.flatMap((s) => [...(s.kindOk ? [] : [`${s.id}: kind ${s.gotKind}`]), ...s.fields.filter((f) => !f.ok).map((f) => `${s.id}: ${f.name} expected ${f.expected} got ${f.got}`)]);

describe("the answer key", () => {
  it("covers every generated document once, with every field of its kind", () => {
    const key = answerKey();
    expect(new Set(key.map((d) => d.id)).size).toBe(key.length);
    expect(key.filter((d) => d.set === "demo")).toHaveLength(16);
    expect(key.filter((d) => d.set === "stress").length).toBeGreaterThanOrEqual(40);
    for (const d of key) expect(Object.keys(d.fields).sort()).toEqual(Object.keys(specFor(d.kind)).sort());
    expect(key.filter((d) => d.ours === false)).toHaveLength(3);
    expect(key.every((d) => d.content.includes("SIMULATED"))).toBe(true);
  });
});

describe("scoring", () => {
  it("normalises before comparing", () => {
    expect(scoreValue("money", "6,400.00")).toBe(scoreValue("money", "6400"));
    expect(scoreValue("money", "USD 25")).toBe(scoreValue("money", "25.00"));
    expect(scoreValue("date", "27-10-2026")).toBe("2026-10-27");
    expect(scoreValue("iban", "pk41 demo 0001 0044 7000 5678")).toBe("PK41DEMO0001004470005678");
    expect(scoreValue("string", "  It services\nexport ")).toBe("IT SERVICES EXPORT");
    expect(scoreValue("string", "")).toBeNull();
  });
});

describe("the reading benchmark", () => {
  it("the layout rules read every demo document exactly as the answer key says", async () => {
    const [run] = await benchmark([{ name: "rules", reader: offlineDocumentReader }], answerKey({ stress: false }));
    expect(misses(run!.scores)).toEqual([]);
    expect(run!.summary.ours).toEqual({ ok: 14, of: 14 });
    expect(run!.summary.perfect).toEqual({ ok: 16, of: 16 });
  });

  it("other layouts are hard for the rules, and someone else's advice is never taken as ours", async () => {
    const docs = answerKey().filter((d) => d.set === "stress");
    const [run] = await benchmark([{ name: "rules", reader: offlineDocumentReader }], docs);
    expect(run!.summary.fields.ok / run!.summary.fields.of).toBeLessThan(0.5);
    const notOurs = run!.scores.filter((s) => s.ours === false);
    expect(notOurs).toHaveLength(3);
    expect(notOurs.every((s) => s.oursOk)).toBe(true);
  });

  it("a model that answers right scores 100%, with its tokens and cost added up", async () => {
    const docs = answerKey({ stress: false });
    const texts = await Promise.all(docs.map(async (d) => [d, (await documentText(new TextEncoder().encode(d.content), d.mimeType)) ?? ""] as const));
    // Finds the document a prompt is about by its text, and answers from the key.
    const find = (prompt: string): AnswerDoc => texts.filter(([, t]) => prompt.includes(t.slice(0, 400))).sort((a, b) => b[1].length - a[1].length)[0]![0];
    const client: InferenceClient = {
      baseUrl: "fake",
      async chat(opts) {
        const prompt = opts.messages.at(-1)!.content;
        const doc = find(prompt);
        const content = prompt.startsWith("Kinds:")
          ? JSON.stringify({ kind: doc.kind, confidence: "high", workspace_match: "yes", reason: "fake" })
          : JSON.stringify({ fields: doc.fields, evidence: {} });
        return { content, model: opts.model, inputTokens: 1000, outputTokens: 100, latencyMs: 1 };
      },
      async models() {
        return ["fake-model"];
      },
    };
    const reader = modelReaders({ client, model: "fake-model", usdPerMillionInput: 0.1, usdPerMillionOutput: 0.35 }).document;
    const [run] = await benchmark([{ name: "fake-model", reader, model: true }], docs);
    expect(misses(run!.scores)).toEqual([]);
    expect(run!.summary.fellBack).toBe(0);
    expect(run!.summary.calls).toBe(32);
    expect(run!.summary.inputTokens).toBe(32_000);
    expect(run!.summary.costUsd).toBeCloseTo(32 * 0.000135, 9);
  });

  it("a model that can't be reached counts as a miss, not as the rules' reading", async () => {
    const down: InferenceClient = {
      baseUrl: "fake",
      async chat() {
        throw new Error("503 from the endpoint");
      },
      async models() {
        return [];
      },
    };
    const docs = answerKey({ stress: false }).filter((d) => d.kind === "credit_advice").slice(0, 3);
    const runs = await benchmark([{ name: "rules", reader: offlineDocumentReader }, { name: "down", reader: modelReaders({ client: down, model: "m" }).document, model: true }], docs);
    expect(runs[1]!.summary.fellBack).toBe(3);
    expect(runs[1]!.summary.fields.ok).toBe(0);
    expect(runs[1]!.summary.failedCalls).toBe(3);
    const md = benchMarkdown(runs, docs, new Date("2026-11-04T12:00:00Z"));
    expect(md).toContain("# Reading benchmark, 2026-11-04");
    expect(md).toContain("| rules | 100.0% | 100.0% | — | 3 of 3 | 100.0% | 0 |");
    expect(md).toContain("| down | 0.0% | 0.0% | — | 0 of 3 | 0.0% | 3 |");
  });
});
