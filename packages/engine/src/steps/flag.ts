import { evaluateFlags, type FlagCandidate } from "@ebo/core";
import { flag } from "@ebo/db";
import { eq } from "drizzle-orm";
import { audit } from "../context";
import { flagSnapshot, loadBooks } from "../books";
import { bump, type Step } from "./types";

/**
 * Flag: evaluate every rule against the books as they are now (core/flags.ts), then
 * upsert by stable key. A flag whose condition no longer holds is resolved by this run;
 * one a person dismissed stays dismissed.
 */
export const flagStep: Step = {
  name: "flag",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const books = await loadBooks(db, c.w);
    const snapshot = flagSnapshot(books, c.w);
    const candidates = evaluateFlags(snapshot);
    const existing = await db.select().from(flag).where(eq(flag.workspaceId, wsId));
    const byKey = new Map(existing.map((f) => [f.key, f]));
    const now = new Date();
    const opened: FlagCandidate[] = [];
    const reopened: string[] = [];
    let updated = 0;

    for (const f of candidates) {
      const row = byKey.get(f.key);
      const fields = { kind: f.kind, severity: f.severity, subjectType: f.subject.type, subjectId: f.subject.id, summary: f.summary, evidence: f.evidence, ruleKeys: f.ruleKeys, updatedAt: now };
      if (!row) {
        await db.insert(flag).values({ workspaceId: wsId, key: f.key, status: "open", runId: c.runId, ...fields });
        opened.push(f);
      } else if (row.status === "resolved") {
        await db.update(flag).set({ ...fields, status: "open", resolvedAt: null, resolvedByRunId: null, runId: c.runId }).where(eq(flag.id, row.id));
        reopened.push(f.key);
      } else {
        await db.update(flag).set(fields).where(eq(flag.id, row.id)); // open, actioned or dismissed: refresh the numbers only
        updated++;
      }
    }

    const live = new Set(candidates.map((f) => f.key));
    const resolved = existing.filter((f) => (f.status === "open" || f.status === "actioned") && !live.has(f.key));
    for (const f of resolved) {
      await db.update(flag).set({ status: "resolved", resolvedAt: now, resolvedByRunId: c.runId, updatedAt: now }).where(eq(flag.id, f.id));
    }
    await audit(db, [
      ...opened.map((f) => ({ workspaceId: wsId, actorType: "agent" as const, actorId: c.runId, action: "flag.opened", objectType: "flag", objectId: f.key, details: { kind: f.kind, severity: f.severity, summary: f.summary } })),
      ...resolved.map((f) => ({ workspaceId: wsId, actorType: "agent" as const, actorId: c.runId, action: "flag.resolved", objectType: "flag", objectId: f.key, details: { kind: f.kind, summary: f.summary } })),
    ]);
    bump(c, "flags_opened", opened.length + reopened.length);
    bump(c, "flags_resolved", resolved.length);
    c.counts.flags_open = candidates.filter((f) => byKey.get(f.key)?.status !== "dismissed").length;

    const high = candidates.filter((f) => f.severity === "high").length;
    c.report.push(
      `${candidates.length} open flag${candidates.length === 1 ? "" : "s"}${high ? ` (${high} high)` : ""}: ${opened.length + reopened.length} new, ${resolved.length} resolved since the last run.`,
    );
    if (snapshot.bankingShare) c.report.push(`Banking-channel share this tax year: ${snapshot.bankingShare.sharePct}%.`);
    return {
      opened: opened.map((f) => ({ key: f.key, kind: f.kind, severity: f.severity, summary: f.summary })),
      reopened,
      resolved: resolved.map((f) => ({ key: f.key, kind: f.kind, summary: f.summary })),
      unchanged: updated,
      bankingShare: snapshot.bankingShare ? { sharePct: snapshot.bankingShare.sharePct, numeratorUsd: snapshot.bankingShare.numeratorUsd, denominatorUsd: snapshot.bankingShare.denominatorUsd, walletSpentUsd: snapshot.bankingShare.walletSpentUsd, walletHeldUsd: snapshot.bankingShare.walletHeldUsd } : null,
      taxYearProceedsPkr: snapshot.taxYearProceedsPkr,
    };
  },
};
