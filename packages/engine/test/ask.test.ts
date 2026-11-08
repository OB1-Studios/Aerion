/**
 * Ask your books: the rules route plain questions to the right query; a model's choice is
 * checked before use; answers come from the same books as Insights, so the figures agree.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, localStorage, modelCall, purgeWorkspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { askBooks, askScope, dashboard, defaultDeps, loadBooks, loadContext, parsePeriod, planByRules, planFromModel, runWorkspace, type AskPlanner, type AskScope, type EngineDeps } from "../src/index";

const scope: AskScope = {
  today: "2026-11-02",
  taxYear: { start: "2026-07-01", end: "2027-06-30", label: "2026-27" },
  clients: [
    { id: "c-alnoor", name: "Al Noor Trading FZ-LLC", kind: "business", aliases: ["AL NOOR TRADING FZ LLC"] },
    { id: "c-bright", name: "Brightlane Health LLC", kind: "business", aliases: [] },
    { id: "c-varga", name: "Dr. Elena Varga", kind: "individual", aliases: [] },
    { id: "c-thames", name: "Thames Ledger Ltd", kind: "business", aliases: [] },
  ],
  invoices: [
    { id: "i-29", number: "INV-2026-029" },
    { id: "i-2", number: "INV-2026-002" },
  ],
};

describe("reading a question (built-in rules)", () => {
  const cases: Array<[string, Partial<ReturnType<typeof planByRules> & object> | null]> = [
    ["What does Al Noor owe?", { tool: "owed", clientId: "c-alnoor" }],
    ["How much is still outstanding from Brightlane", { tool: "owed", clientId: "c-bright" }],
    ["Which invoices are unpaid?", { tool: "owed", clientId: null }],
    ["What's overdue?", { tool: "overdue" }],
    ["Who should I chase?", { tool: "overdue" }],
    ["Who pays late?", { tool: "days_to_pay" }],
    ["How long does Varga take to pay?", { tool: "days_to_pay", clientId: "c-varga" }],
    ["How much did we receive in October?", { tool: "received", from: "2026-10-01", to: "2026-10-31" }],
    ["How much has Thames paid us this year?", { tool: "received", clientId: "c-thames", from: "2026-07-01", to: "2026-11-02" }],
    ["Which ePRCs are still missing?", { tool: "missing_paperwork" }],
    ["Is Al Noor's withholding certificate on file?", { tool: "missing_paperwork", clientId: "c-alnoor" }],
    ["What's our banking-channel share?", { tool: "banking_share" }],
    ["What did fees and conversion cost us?", { tool: "cost" }],
    ["Export proceeds by month", { tool: "proceeds" }],
    ["Where is INV-2026-029?", { tool: "invoice", invoiceId: "i-29" }],
    ["status of inv 2026 002", { tool: "invoice", invoiceId: "i-2" }],
    ["Al Noor", { tool: "owed", clientId: "c-alnoor" }],
    ["Write me a poem about taxes", null],
  ];
  for (const [q, want] of cases) {
    it(q, () => {
      const plan = planByRules(q, scope);
      if (want === null) expect(plan).toBeNull();
      else expect(plan).toMatchObject(want);
    });
  }

  it("names no client when two would fit equally", () => {
    const twins: AskScope = { ...scope, clients: [...scope.clients, { id: "c-al2", name: "Al Noor Logistics", kind: "business", aliases: [] }] };
    expect(planByRules("What does Al Noor owe?", twins)).toMatchObject({ tool: "owed", clientId: null });
    expect(planByRules("What does Al Noor Trading owe?", twins)).toMatchObject({ clientId: "c-alnoor" });
  });
});

describe("periods", () => {
  const p = (q: string) => parsePeriod(q, "2026-11-02");
  it("reads months, weeks, quarters and tax years", () => {
    expect(p("in October")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(p("in December")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(p("sept 2026")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(p("since August")).toEqual({ from: "2026-08-01", to: "2026-11-02" });
    expect(p("this month")).toEqual({ from: "2026-11-01", to: "2026-11-02" });
    expect(p("last month")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(p("last 30 days")).toEqual({ from: "2026-10-04", to: "2026-11-02" });
    expect(p("last week")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(p("this quarter")).toEqual({ from: "2026-10-01", to: "2026-11-02" });
    expect(p("this tax year")).toEqual({ from: "2026-07-01", to: "2026-11-02" });
    expect(p("last year")).toEqual({ from: "2025-07-01", to: "2026-06-30" });
    expect(p("tax year 2025-26")).toEqual({ from: "2025-07-01", to: "2026-06-30" });
  });
  it("doesn't take 'may' for a month unless it plainly is one", () => {
    expect(p("may I see what came in")).toBeNull();
    expect(p("what came in during May")).toEqual({ from: "2026-05-01", to: "2026-05-31" });
  });
});

describe("checking a model's choice", () => {
  it("accepts a query on a listed client, with real dates", () => {
    expect(planFromModel({ tool: "received", client: 4, from: "2026-10-01", to: "2026-10-31" }, scope)).toEqual({ plan: { tool: "received", clientId: "c-thames", invoiceId: null, from: "2026-10-01", to: "2026-10-31" } });
  });
  it("refuses made-up queries, clients, invoices and dates", () => {
    expect(planFromModel({ tool: "transfer_money" }, scope)).toHaveProperty("problem");
    expect(planFromModel({ tool: "owed", client: 9 }, scope)).toHaveProperty("problem");
    expect(planFromModel({ tool: "invoice", invoice_number: "INV-9999-999" }, scope)).toHaveProperty("problem");
    expect(planFromModel({ tool: "received", from: "2026-02-30" }, scope)).toHaveProperty("problem");
    expect(planFromModel({ tool: "received", from: "2026-10-31", to: "2026-10-01" }, scope)).toHaveProperty("problem");
  });
  it("treats no query as no answer, and drops what a query doesn't take", () => {
    expect(planFromModel({ tool: null }, scope)).toEqual({ none: true });
    expect(planFromModel({ tool: "banking_share", client: 1, from: "2026-01-01" }, scope)).toEqual({ plan: { tool: "banking_share", clientId: null, invoiceId: null, from: null, to: null } });
  });
});

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-ask-")));
let db: Db;
let deps: EngineDeps;
let wsId = "";

describe.skipIf(!dbUp)("answers from the demo office's books", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-ask` })).workspaceId;
    const r = await runWorkspace(deps, wsId, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("says what Al Noor owes, invoice by invoice, linked", async () => {
    const w = await loadContext(db, wsId);
    const r = await askBooks(db, w, "What does Al Noor owe?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chosenBy).toEqual({ by: "rules" });
    expect(r.answer.headline).toBe("USD 750.00");
    expect(r.answer.lines).toHaveLength(1);
    expect(r.answer.lines[0]).toMatchObject({ label: "INV-2026-029", value: "USD 750.00" });
    expect(r.answer.lines[0]!.href).toMatch(/^\/invoices\/[0-9a-f-]{36}$/);
  });

  it("agrees with Insights on overdue invoices, cost and the banking share", async () => {
    const w = await loadContext(db, wsId);
    const d = dashboard(await loadBooks(db, w), w);
    const overdue = await askBooks(db, w, "What's overdue?");
    expect(overdue.ok && overdue.answer.lines.map((l) => l.label)).toEqual(d.owed.mostOverdue.map((x) => x.number));
    const cost = await askBooks(db, w, "What did getting paid cost?");
    expect(cost.ok && cost.answer.headline).toBe(`PKR ${Number(d.cost.total.costPkr).toLocaleString("en", { minimumFractionDigits: 2 })}`);
    const share = await askBooks(db, w, "banking share?");
    expect(share.ok && share.answer.headline).toBe(`${d.proceeds.sharePct}%`);
  });

  it("lists October's money in without counting own transfers", async () => {
    const w = await loadContext(db, wsId);
    const r = await askBooks(db, w, "How much did we receive in October 2026?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.title).toBe("Money received, October 2026");
    expect(r.answer.lines.every((l) => !/^.* · PAYONEER INC$/.test(l.label))).toBe(true);
    expect(r.answer.notes.join(" ")).toMatch(/own accounts/);
  });

  it("tells an invoice's story, with its payments and open flags", async () => {
    const w = await loadContext(db, wsId);
    const r = await askBooks(db, w, "Where is INV-2026-029?");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.headline).toBe("USD 750.00 still owed");
    expect(r.answer.lines.some((l) => l.group === "Payments" && l.value === "USD 6,750.00")).toBe(true);
    expect(r.answer.lines.some((l) => l.group === "Open flags" && l.href?.startsWith("/flags/"))).toBe(true);
  });

  it("asks a model only when the rules find nothing, checks its choice, and records the call", async () => {
    const w = await loadContext(db, wsId);
    const b = await loadBooks(db, w);
    const thames = askScope(b, w).clients.findIndex((c) => c.name === "Thames Ledger Ltd") + 1;
    let asked = 0;
    const planner: AskPlanner = {
      model: "test-model",
      async plan() {
        asked++;
        return { raw: { tool: "received", client: thames, from: "2026-07-01", to: "2026-11-02" }, calls: [{ purpose: "assistant", model: "test-model", inputTokens: 10, outputTokens: 5, costUsd: "0.000001", latencyMs: 1, ok: true }] };
      },
    };
    const byRules = await askBooks(db, w, "What does Al Noor owe?", planner);
    expect(byRules.ok && byRules.chosenBy).toEqual({ by: "rules" });
    expect(asked).toBe(0);

    const byModel = await askBooks(db, w, "Tell me about the London accounting firm's money this year", planner);
    expect(asked).toBe(1);
    expect(byModel.ok && byModel.chosenBy).toEqual({ by: "model", model: "test-model" });
    expect(byModel.ok && byModel.answer.title).toMatch(/^Received from Thames Ledger Ltd/);
    const calls = await db.select().from(modelCall).where(and(eq(modelCall.workspaceId, wsId), eq(modelCall.purpose, "assistant")));
    expect(calls).toHaveLength(1);

    const liar: AskPlanner = { model: "test-model", plan: async () => ({ raw: { tool: "owed", client: 99 }, calls: [] }) };
    const refused = await askBooks(db, w, "Tell me about the London accounting firm", liar);
    expect(refused).toMatchObject({ ok: false, reason: "not_understood" });
    expect(!refused.ok && refused.modelNote).toMatch(/refused: it named a client that isn't in this workspace/);
  });

  it("refuses empty and overlong questions", async () => {
    const w = await loadContext(db, wsId);
    expect(await askBooks(db, w, "   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(await askBooks(db, w, "x".repeat(301))).toMatchObject({ ok: false, reason: "too_long" });
  });
});
