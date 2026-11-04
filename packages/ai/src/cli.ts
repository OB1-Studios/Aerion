import { readFileSync } from "node:fs";
import { loadLocalEnv } from "@ebo/db";
import { documentText } from "@ebo/engine";
import { inferenceClient } from "./client";
import { readersFromEnv } from "./index";

/**
 *   pnpm --filter @ebo/ai models                  list the models this key can use
 *   pnpm --filter @ebo/ai try <file> [mime]       read one document with the configured model
 * Needs VULTR_INFERENCE_API_KEY. Only send simulated or consented documents.
 */
async function main() {
  loadLocalEnv();
  const [cmd, file, mime] = process.argv.slice(2);
  const apiKey = process.env.VULTR_INFERENCE_API_KEY;
  if (!apiKey) throw new Error("Set VULTR_INFERENCE_API_KEY first.");
  if (cmd === "models") {
    for (const m of await inferenceClient({ apiKey, baseUrl: process.env.VULTR_INFERENCE_URL || undefined }).models()) console.log(m);
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
  console.log("usage: models | try <file> [mime]");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
