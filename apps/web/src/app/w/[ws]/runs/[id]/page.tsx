import { formatMoney, periodLabel } from "@ebo/core";
import { getDb, modelCall, run, runStep, user, type RunStepName } from "@ebo/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RunPoller } from "@/components/run-poller";
import { Badge, Card, PageHeader, Status, Table, cx, severityTone } from "@/components/ui";
import { clock, day, duration, humanize, templateName } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { documentKindLabel, intentLabel, runCountLabel, SEVERITY_LABEL } from "@/lib/labels";

export const metadata = { title: "Run" };

const STEPS: Array<{ step: RunStepName; label: string; does: string }> = [
  { step: "plan", label: "Plan", does: "Look at what is waiting and decide what this run will do." },
  { step: "pull", label: "Pull", does: "Bring in new emails, bank alerts, wallet exports and uploads." },
  { step: "read", label: "Read", does: "Classify and extract every document and email; check each field against the source text." },
  { step: "reconcile", label: "Reconcile", does: "Link transfers between our accounts, match money to invoices, explain fees and FX." },
  { step: "flag", label: "Flag", does: "Re-check every rule; open new flags and close the ones that cleared." },
  { step: "draft", label: "Draft", does: "Draft the retainer invoices that are due, then write emails and tasks from templates; check every number against the records." },
  { step: "send", label: "Send", does: "Send what a person approved or the policy allows." },
  { step: "follow_up", label: "Follow up", does: "Close claims and promises; list what needs a person." },
];

type Out = Record<string, unknown>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** What a run did with each document, in words. */
const DOC_ACTION: Record<string, string> = { created: "payment recorded", corrected: "payment corrected", already_imported: "already imported", certificate_on_file: "filed as a certificate" };

export default async function RunPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const [row] = await db
    .select({ r: run, who: user.name, anon: user.isAnonymous })
    .from(run)
    .leftJoin(user, eq(user.id, run.triggeredBy))
    .where(and(eq(run.workspaceId, ws.id), eq(run.id, id)));
  if (!row) notFound();
  const r = row.r;
  const [steps, calls] = await Promise.all([
    db.select().from(runStep).where(eq(runStep.runId, r.id)).orderBy(asc(runStep.position)),
    db.select().from(modelCall).where(eq(modelCall.runId, r.id)).orderBy(asc(modelCall.createdAt)),
  ]);
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const active = r.status === "queued" || r.status === "running";
  const base = `/w/${slug}`;

  return (
    <>
      <RunPoller active={active} />
      <PageHeader
        title={`Run as of ${clock(r.clockAt, ws.timezone)}`}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={r.status} />
            <span>{r.kind === "on_arrival" ? "Started when new mail arrived" : r.triggeredBy ? `Started by ${row.anon ? "a visitor" : (row.who ?? "a person")}` : "Started by the Monday schedule"}</span>
            {r.finishedAt ? <span>· took {duration(r.startedAt, r.finishedAt)}</span> : null}
          </span>
        }
        actions={
          <Link href={`${base}/runs`} className="btn btn-secondary">
            All runs
          </Link>
        }
      />

      {r.status === "queued" ? <p className="mb-4 text-sm text-muted">Waiting for the worker to pick this run up…</p> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ol className="relative space-y-3">
          {STEPS.map((info, i) => {
            const s = byStep.get(info.step);
            const state = s?.status ?? (active ? "waiting" : "skipped");
            return (
              <li key={info.step} className="relative pl-10">
                <span
                  className={cx(
                    "absolute left-0 top-3 grid size-7 place-items-center rounded-full border text-xs font-semibold",
                    state === "succeeded" && "border-success-line bg-success-soft text-success",
                    state === "running" && "animate-pulse border-info-line bg-info-soft text-info",
                    state === "failed" && "border-danger-line bg-danger-soft text-danger",
                    (state === "waiting" || state === "skipped") && "border-line bg-panel text-muted",
                  )}
                >
                  {state === "succeeded" ? "✓" : state === "failed" ? "!" : i + 1}
                </span>
                {i < STEPS.length - 1 ? <span className="absolute bottom-[-0.75rem] left-3.5 top-10 w-px bg-line" aria-hidden /> : null}
                <div className="rounded-xl border border-line bg-panel shadow-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
                    <div>
                      <span className="font-semibold text-ink">{info.label}</span>
                      <span className="ml-2 text-xs text-muted">{info.does}</span>
                    </div>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {s?.finishedAt ? duration(s.startedAt, s.finishedAt) : null}
                      <Status value={state === "waiting" ? "pending" : state} label={state.charAt(0).toUpperCase() + state.slice(1)} />
                    </span>
                  </div>
                  <div className="px-4 pb-3 pt-2 text-sm">
                    {s?.error ? <p className="text-danger">{s.error}</p> : null}
                    {s?.status === "succeeded" ? <StepDetail step={info.step} out={s.output} base={base} tz={ws.timezone} /> : null}
                    {s?.status === "succeeded" ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted hover:text-ink">Step output (JSON)</summary>
                        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-canvas p-3 text-xs">{JSON.stringify(s.output, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="space-y-6">
          <Card title="Report">
            {r.summary ? (
              <ul className="list-disc space-y-1.5 pl-4 text-sm text-ink">
                {r.summary.split("\n").map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{active ? "Written when the run finishes." : "—"}</p>
            )}
            {r.error ? <p className="mt-2 text-sm text-danger">{r.error}</p> : null}
          </Card>
          <Card title="Counts">
            {Object.keys(r.counts).length ? (
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                {Object.entries(r.counts)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted" title={k}>
                        {runCountLabel(k)}
                      </dt>
                      <dd className="text-right tabular-nums text-ink">{v}</dd>
                    </div>
                  ))}
              </dl>
            ) : (
              <p className="text-sm text-muted">—</p>
            )}
          </Card>
          <Card title="Model calls" pad={false}>
            {calls.length ? (
              <Table dense head={["Purpose", "Model", "Tokens", "ms"]}>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td>{c.purpose}</td>
                    <td className="max-w-32 truncate text-xs">{c.model}</td>
                    <td className="tabular-nums text-xs">
                      {c.inputTokens}+{c.outputTokens}
                    </td>
                    <td className={cx("tabular-nums text-xs", !c.ok && "text-danger")}>{c.ok ? c.latencyMs : "failed"}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="p-4 text-sm text-muted">None: documents were read by the built-in layout rules (no AI key configured), so this run cost nothing.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Lines({ children }: { children: ReactNode }) {
  return <ul className="space-y-1">{children}</ul>;
}

function StepDetail({ step, out, base, tz }: { step: RunStepName; out: Out; base: string; tz: string }) {
  switch (step) {
    case "plan": {
      const w = (out.waiting ?? {}) as Record<string, number>;
      return (
        <p className="text-muted">
          {w.arrived ?? 0} new item{w.arrived === 1 ? "" : "s"} in the mailbox · {w.pendingTx ?? 0} unreconciled payment{w.pendingTx === 1 ? "" : "s"} · {w.openInvoices ?? 0} open invoices · {w.openFlags ?? 0} open flags · policy{" "}
          <b className="text-ink">{(out.policy as { mode?: string } | undefined)?.mode ?? "supervised"}</b>
        </p>
      );
    }
    case "pull": {
      const delivered = arr<{ channel: string; from: string | null; subject: string | null; files: string[] }>(out.delivered);
      const waiting = arr<{ subject: string | null; needs: string }>(out.waiting);
      return (
        <>
          {delivered.length ? (
            <Lines>
              {delivered.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <Badge tone="gray">{d.channel}</Badge>
                  <span className="min-w-0 truncate">
                    {d.subject ?? d.files.join(", ")}
                    {d.from ? <span className="text-muted"> · {d.from}</span> : null}
                  </span>
                </li>
              ))}
            </Lines>
          ) : (
            <p className="text-muted">Nothing new.</p>
          )}
          {waiting.length ? (
            <p className="mt-2 text-xs text-muted">
              Not here yet: {waiting.length} repl{waiting.length === 1 ? "y" : "ies"} that only come after we send the {[...new Set(waiting.map((w) => templateName(w.needs)))].join(", ")} email.
            </p>
          ) : null}
        </>
      );
    }
    case "read": {
      const docs = arr<{ document: string; kind?: string; status: string; reasons?: string[]; action?: string; rows?: number; created?: number }>(out.documents);
      const all = arr<{ from: string; subject: string | null; intent: string; effects?: string[]; forwardedFrom?: string | null }>(out.emails);
      // Bank alerts and notifications carry the documents read above; list only emails that say something.
      const emails = all.filter((m) => m.intent !== "other" || m.effects?.length);
      const quiet = all.length - emails.length;
      return (
        <div className="space-y-3">
          {docs.length ? (
            <Lines>
              {docs.map((d, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <Status value={d.status} />
                  <span className="min-w-0 truncate">{d.document}</span>
                  <span className="text-xs text-muted">
                    {d.kind ? documentKindLabel(d.kind) : ""}
                    {d.action === "imported" ? ` · ${d.created} of ${d.rows} rows new` : d.action ? ` · ${DOC_ACTION[d.action] ?? humanize(d.action).toLowerCase()}` : ""}
                  </span>
                  {d.reasons?.length ? <span className="w-full pl-1 text-xs text-warning">{d.reasons.join(" ")}</span> : null}
                </li>
              ))}
            </Lines>
          ) : null}
          {emails.length ? (
            <Lines>
              {emails.map((m, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={m.intent === "bank_detail_change" ? "red" : m.intent === "other" ? "gray" : "blue"}>{intentLabel(m.intent)}</Badge>
                  <span className="min-w-0 truncate">{m.subject}</span>
                  <span className="text-xs text-muted">
                    {m.forwardedFrom ? `forwarded; originally from ${m.forwardedFrom}` : m.from}
                    {m.effects?.length ? ` · recorded ${m.effects.map((e) => e.split(":").slice(0, 2).join(" ")).join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </Lines>
          ) : null}
          {quiet ? <p className="text-xs text-muted">{quiet} more email{quiet === 1 ? "" : "s"} (bank alerts and notifications) carried the documents above and asked for nothing.</p> : null}
          {!docs.length && !all.length ? <p className="text-muted">Nothing to read.</p> : null}
        </div>
      );
    }
    case "reconcile": {
      const matched = arr<{ transactionId: string; invoice: string; tier: string; received: string; fee: string | null; explanation: string[]; unexplained: string | null }>(out.matched);
      const transfers = arr<{ what: string }>(out.transfers);
      const unmatched = arr<{ transactionId: string; amount: string; payer: string | null; explanation: string[] }>(out.unmatched);
      return (
        <div className="space-y-2">
          {matched.length ? (
            <Lines>
              {matched.map((m, i) => (
                <li key={i}>
                  <Link href={`${base}/payments/${m.transactionId}`} className="font-medium text-ink hover:text-accent">
                    {m.received} → {m.invoice}
                  </Link>{" "}
                  <span className="text-xs text-muted">
                    {m.tier === "A" ? "by reference and payer" : "by payer and amount"}
                    {m.fee ? ` · fee ${m.fee}` : ""}
                    {m.unexplained ? ` · ${m.unexplained} unexplained` : ""}
                  </span>
                  {m.explanation?.length ? <div className="text-xs text-muted">{m.explanation[0]!.replace(/ \(tier [AB]\)/, "")}</div> : null}
                </li>
              ))}
            </Lines>
          ) : null}
          {transfers.length ? <p className="text-xs text-muted">Transfers between our own accounts: {transfers.map((t) => t.what).join("; ")}.</p> : null}
          {unmatched.map((u, i) => (
            <p key={i} className="text-xs text-warning">
              Unmatched: {u.amount} from {u.payer ?? "unknown"}. {u.explanation?.[0]}
            </p>
          ))}
          {!matched.length && !transfers.length && !unmatched.length ? <p className="text-muted">No new money to match.</p> : null}
        </div>
      );
    }
    case "flag": {
      const opened = arr<{ key: string; kind: string; severity: string; summary: string }>(out.opened);
      const resolved = arr<{ key: string; kind: string; summary: string }>(out.resolved);
      const share = out.bankingShare as { sharePct: string } | null | undefined;
      return (
        <div className="space-y-2">
          {opened.length ? (
            <Lines>
              {opened.map((f) => (
                <li key={f.key} className="flex items-baseline gap-2">
                  <Badge tone={severityTone(f.severity)}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Badge>
                  <span>{f.summary}</span>
                </li>
              ))}
            </Lines>
          ) : null}
          {resolved.length ? (
            <Lines>
              {resolved.map((f) => (
                <li key={f.key} className="flex items-baseline gap-2">
                  <Badge tone="green">resolved</Badge>
                  <span className="text-muted">{f.summary}</span>
                </li>
              ))}
            </Lines>
          ) : null}
          {!opened.length && !resolved.length ? <p className="text-muted">No change: {String(out.unchanged ?? 0)} flags still open as before.</p> : null}
          {share ? <p className="text-xs text-muted">Banking-channel share this tax year: {share.sharePct}%.</p> : null}
        </div>
      );
    }
    case "draft": {
      const created = arr<{ key: string; template: string | null; to: string | null; subject: string; decision?: { mode: string } }>(out.created);
      const tasks = arr<string>(out.tasks);
      const cancelled = arr<string>(out.cancelled);
      const retainers = arr<{ contractId: string; client: string; period: string; amount: string; currency: string; invoiceId: string | null; number: string | null; problem: string | null }>(out.retainers);
      return (
        <div className="space-y-2">
          {retainers.length ? (
            <Lines>
              {retainers.map((r) => (
                <li key={`${r.contractId}:${r.period}`} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={r.invoiceId ? "violet" : "red"}>{r.invoiceId ? "invoice drafted" : "couldn't draft"}</Badge>
                  {r.invoiceId ? (
                    <Link href={`${base}/invoices/${r.invoiceId}`} className="font-medium text-ink hover:text-accent">
                      {r.number}
                    </Link>
                  ) : null}
                  <span className="min-w-0">
                    {r.client}&apos;s retainer for {periodLabel(r.period)}, {formatMoney(r.amount, r.currency)}
                  </span>
                  {r.problem ? <span className="text-xs text-danger">{r.problem}</span> : null}
                </li>
              ))}
            </Lines>
          ) : null}
          {created.length ? (
            <Lines>
              {created.map((d) => (
                <li key={d.key} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={d.decision?.mode === "blocked" ? "red" : d.decision?.mode === "approve" ? "amber" : "blue"}>{d.decision?.mode === "approve" ? "to approve" : (d.decision?.mode ?? "draft")}</Badge>
                  <span className="min-w-0">{d.subject}</span>
                  <span className="text-xs text-muted">to {d.to}</span>
                </li>
              ))}
            </Lines>
          ) : null}
          {tasks.length ? <p className="text-xs text-muted">Tasks for a person: {tasks.join("; ")}.</p> : null}
          {cancelled.length ? <p className="text-xs text-muted">{cancelled.length} draft{cancelled.length === 1 ? "" : "s"} cancelled because the problem was resolved.</p> : null}
          {!created.length && !tasks.length && !cancelled.length && !retainers.length ? <p className="text-muted">Nothing new to write.</p> : null}
        </div>
      );
    }
    case "send": {
      const sent = arr<string>(out.sent);
      const failed = arr<{ subject: string | null; reason?: string }>(out.failed);
      return (
        <div className="space-y-1">
          {sent.map((s, i) => (
            <p key={i}>
              <Badge tone="green">sent</Badge> {s}
            </p>
          ))}
          {failed.map((f, i) => (
            <p key={i} className="text-danger">
              Not sent: {f.subject} ({f.reason})
            </p>
          ))}
          <p className="text-xs text-muted">
            {String(out.awaitingApproval ?? 0)} waiting for approval{out.scheduled ? ` · ${String(out.scheduled)} scheduled` : ""} · mailbox: {out.mailer === "demo" ? "demo (recorded, not delivered)" : String(out.mailer)}
          </p>
        </div>
      );
    }
    case "follow_up": {
      const need = (out.needsPerson ?? {}) as { approvals?: number; tasks?: number; documents?: unknown[]; payments?: number };
      const watching = (out.watching ?? {}) as { openClaims?: number; openPromises?: Array<{ promisedOn: string }> };
      return (
        <p className="text-muted">
          Needs a person: {need.approvals ?? 0} approvals, {need.tasks ?? 0} tasks, {need.documents?.length ?? 0} documents, {need.payments ?? 0} payments. Watching {watching.openClaims ?? 0} payment claim{watching.openClaims === 1 ? "" : "s"}
          {watching.openPromises?.length ? ` and ${watching.openPromises.length} promise${watching.openPromises.length === 1 ? "" : "s"} to pay (${watching.openPromises.map((p) => day(p.promisedOn)).join(", ")})` : ""}. Next weekly run{" "}
          {typeof out.nextWeeklyRun === "string" ? day(out.nextWeeklyRun) : "next Monday"}, 09:00 {tz === "Asia/Karachi" ? "PKT" : tz}.
        </p>
      );
    }
  }
}
