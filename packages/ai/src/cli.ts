import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLocalEnv } from "@ebo/db";
import { answerKey } from "@ebo/db/seed";
import { documentText, offlineDocumentReader } from "@ebo/engine";
import { benchmark, benchMarkdown, pct, type BenchReader } from "./bench";
import { CANDIDATE_MODELS, LIST_PRICES } from "./catalog";
import { inferenceClient } from "./client";
import { DEFAULT_MODEL, readersFromEnv } from "./index";
import { modelReaders } from "./readers";

const USAGE = `usage:
  models                      list the models this key can use
  try <file> [mime]           read one document with the configured model
  bench [options]             score readers against the answer key
    --models a,b | candidates   models to compare (default: VULTR_INFERENCE_MODEL or ${DEFAULT_MODEL})
    --set demo | stress | all   which documents (default all)
    --limit N                   an evenly spread sample of N documents
    --concurrency N             documents read at once per model (default 3)
    --schema                    strict json_schema output instead of JSON mode
    --out DIR                   also write DIR/benchmark.md and DIR/benchmark.json
Models need VULTR_INFERENCE_API_KEY; without it, bench scores the layout rules only.
Only send simulated or consented documents.`;

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

async function bench(argv: string[]) {
  const f = flags(argv);
  const set = f.set === "demo" || f.set === "stress" ? f.set : "all";
  let docs = answerKey({ stress: set !== "demo" }).filter((d) => set === "all" || d.set === set);
  const limit = Number(f.limit) || 0;
  if (limit && limit < docs.length) {
    const step = docs.length / limit;
    docs = Array.from({ length: limit }, (_, i) => docs[Math.floor(i * step)]!);
  }

  const readers: BenchReader[] = [{ name: "layout rules (no model)", reader: offlineDocumentReader }];
  const apiKey = process.env.VULTR_INFERENCE_API_KEY;
  if (apiKey) {
    const client = inferenceClient({ apiKey, baseUrl: process.env.VULTR_INFERENCE_URL || undefined });
    let models = String(typeof f.models === "string" ? f.models : process.env.VULTR_INFERENCE_MODEL || DEFAULT_MODEL)
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (f.models === "candidates") {
      const available = new Set(await client.models());
      const missing = CANDIDATE_MODELS.filter((m) => !available.has(m));
      if (missing.length) console.error(`Not available to this key, skipped: ${missing.join(", ")}`);
      models = CANDIDATE_MODELS.filter((m) => available.has(m));
    }
    for (const model of models) {
      const envIn = Number(process.env.VULTR_INFERENCE_USD_PER_M_IN ?? 0) || 0;
      const envOut = Number(process.env.VULTR_INFERENCE_USD_PER_M_OUT ?? 0) || 0;
      readers.push({
        name: model,
        model: true,
        reader: modelReaders({
          client,
          model,
          jsonMode: f.schema ? "schema" : "object",
          usdPerMillionInput: envIn || LIST_PRICES[model]?.input || 0,
          usdPerMillionOutput: envOut || LIST_PRICES[model]?.output || 0,
        }).document,
      });
    }
  } else {
    console.error("No VULTR_INFERENCE_API_KEY, so only the layout rules are scored.");
  }

  console.error(`Reading ${docs.length} documents with ${readers.map((r) => r.name).join(", ")}…`);
  const runs = await benchmark(readers, docs, {
    concurrency: Number(f.concurrency) || 3,
    onDoc: (reader, s, done, total) => {
      if (done % 10 === 0 || done === total) console.error(`  ${reader}: ${done}/${total}`);
      if (s.error) console.error(`  ${reader}: ${s.id}: ${s.error}`);
    },
  });
  const md = benchMarkdown(runs, docs);
  console.log(md);
  if (typeof f.out === "string") {
    const dir = resolve(process.env.INIT_CWD ?? process.cwd(), f.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "benchmark.md"), md);
    writeFileSync(join(dir, "benchmark.json"), `${JSON.stringify({ date: new Date().toISOString(), documents: docs.map((d) => ({ id: d.id, set: d.set, layout: d.layout, kind: d.kind, ours: d.ours })), runs }, null, 2)}\n`);
    console.error(`Wrote ${join(dir, "benchmark.md")} and benchmark.json`);
  }
  for (const r of runs) console.error(`${r.reader}: fields ${pct(r.summary.fields)}, kind ${pct(r.summary.kind)}, $${r.summary.costUsd.toFixed(4)}`);
}

async function main() {
  loadLocalEnv();
  const [cmd, file, mime] = process.argv.slice(2);
  if (cmd === "bench") return bench(process.argv.slice(3));
  const apiKey = process.env.VULTR_INFERENCE_API_KEY;
  if ((cmd === "models" || cmd === "try") && !apiKey) throw new Error("Set VULTR_INFERENCE_API_KEY first.");
  if (cmd === "models") {
    for (const m of await inferenceClient({ apiKey: apiKey!, baseUrl: process.env.VULTR_INFERENCE_URL || undefined }).models()) console.log(m);
    return;
  }
  if (cmd === "try" && file) {
    const readers = readersFromEnv()!;
    const mimeType = mime ?? (file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".csv") ? "text/csv" : file.endsWith(".pdf") ? "application/pdf" : "text/plain");
    const text = await documentText(new Uint8Array(readFileSync(file)), mimeType);
    const res = await readers.document.read(
      { id: "cli", name: file.split("/").pop() ?? file, mimeType, text, kindHint: null },
      { workspaceName: "Ravi Code Works", legalName: "Ravi Code Works (Pvt) Ltd", ibans: ["PK33DEMO0001004410001234", "PK41DEMO0001004470005678"], receivedOn: new Date().toISOString().slice(0, 10) },
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(USAGE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
