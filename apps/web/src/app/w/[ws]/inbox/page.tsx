import { demoInboxItem, document, draftAction, flag, getDb, message, receivingAccount, run, runStep, task, transaction } from "@ebo/db";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, min } from "drizzle-orm";
import Link from "next/link";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Empty, Notice, PageHeader, Stat, Status, severityTone } from "@/components/ui";
import { ago, clock, day, money, templateName } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { approveAll, completeTask, rejectDraft, approveDraft, runNow } from "../actions";

export const metadata = { title: "Inbox" };

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

export default async function Inbox({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const now = ws.demoClock ?? new Date();
  const base = `/w/${slug}`;

  const [drafts, pendingSend, tasks, review, unmatched, runs, arrived, upcoming, sent, flags] = await Promise.all([
    db.select().from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["draft", "blocked"]))).orderBy(asc(draftAction.createdAt), asc(draftAction.subject)),
    db.select().from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["scheduled", "approved"]))).orderBy(asc(draftAction.scheduledFor)),
    db.select().from(task).where(and(eq(task.workspaceId, ws.id), eq(task.status, "open"))).orderBy(asc(task.dueOn), asc(task.createdAt)),
    db.select().from(document).where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))).orderBy(desc(document.receivedAt)),
    db
      .select({ tx: transaction, account: receivingAccount.label })
      .from(transaction)
      .leftJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
      .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.matchStatus, "unmatched")))
      .orderBy(desc(transaction.valueDate)),
    db.select().from(run).where(eq(run.workspaceId, ws.id)).orderBy(desc(run.startedAt)).limit(1),
    db.select({ n: count() }).from(demoInboxItem).where(and(eq(demoInboxItem.workspaceId, ws.id), isNull(demoInboxItem.pulledAt), lte(demoInboxItem.deliverAt, now))),
    db.select({ n: count(), next: min(demoInboxItem.deliverAt) }).from(demoInboxItem).where(and(eq(demoInboxItem.workspaceId, ws.id), isNull(demoInboxItem.pulledAt), gt(demoInboxItem.deliverAt, now))),
    db.select().from(message).where(and(eq(message.workspaceId, ws.id), eq(message.direction, "out"))).orderBy(desc(message.sentAt)).limit(6),
    db.select({ id: flag.id, severity: flag.severity, status: flag.status, kind: flag.kind }).from(flag).where(eq(flag.workspaceId, ws.id)),
  ]);
  const lastRun = runs[0];
  const [shareStep] = lastRun
    ? await db.select({ output: runStep.output }).from(runStep).where(and(eq(runStep.runId, lastRun.id), eq(runStep.step, "flag"))).limit(1)
    : [];
  const share = (shareStep?.output as { bankingShare?: { sharePct: string } | null } | undefined)?.bankingShare;
  const flagById = new Map(flags.map((f) => [f.id, f]));
  // "Actioned" flags are still open: the email went out and the agent is waiting for the fix.
  const openFlags = flags.filter((f) => f.status === "open" || f.status === "actioned");
  const waitingOnReply = openFlags.filter((f) => f.status === "actioned").length;
  const highOpen = openFlags.filter((f) => f.severity === "high").length;
  const acts = canAct(role);
  const waitingN = Number(arrived[0]?.n ?? 0);
  const upcomingN = Number(upcoming[0]?.n ?? 0);
  const needsPerson = drafts.length + tasks.length + review.length + unmatched.length;
  const worst = (ids: string[]) => ids.map((id) => flagById.get(id)?.severity).filter((s): s is "high" | "medium" | "info" => !!s).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0];

  const flash = sp.sent
    ? (await db.select({ subject: draftAction.subject }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.id, sp.sent))))[0]?.subject
    : null;

  const running = lastRun?.status === "queued" || lastRun?.status === "running";

  return (
    <>
      <RunPoller active={running} everyMs={2000} />
      {running ? (
        <Notice tone="violet">
          A run is in progress.{" "}
          <Link href={`${base}/runs/${lastRun!.id}`} className="underline">
            Watch the timeline
          </Link>
          ; this page updates when it finishes.
        </Notice>
      ) : null}
      <PageHeader
        title="Inbox"
        sub={lastRun ? <>Last run {ws.isDemo ? `at ${clock(lastRun.clockAt, ws.timezone)}` : ago(lastRun.startedAt)}: {needsPerson ? `${needsPerson} thing${needsPerson === 1 ? " needs" : "s need"} a person.` : "nothing needs a person."}</> : "No run yet."}
        actions={
          acts && drafts.filter((d) => d.status === "draft").length > 1 ? (
            <form action={approveAll.bind(null, slug)}>
              <SubmitButton variant="secondary" pendingText="Sending…">
                Approve and send all {drafts.filter((d) => d.status === "draft").length}
              </SubmitButton>
            </form>
          ) : null
        }
      />

      {flash ? <Notice tone="green">Sent: {flash}. Recorded in the demo mailbox (nothing leaves the demo).</Notice> : null}
      {sp.sentAll ? <Notice tone="green">Sent {sp.sentAll} email{sp.sentAll === "1" ? "" : "s"}. Each one passed the numbers check again before sending.</Notice> : null}
      {sp.reset ? <Notice tone="violet">The demo is back at its starting point.</Notice> : null}

      {!lastRun || (waitingN > 0 && lastRun.status !== "running" && lastRun.status !== "queued") ? (
        <section className="mb-6 rounded-xl border border-accent/30 bg-accent/5 p-5">
          <h2 className="font-semibold text-ink">{lastRun ? "New items have arrived" : sp.welcome ? "Welcome: this is your own copy of the demo" : "Ready for the weekly run"}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            It&apos;s {clock(now, ws.timezone)}. {waitingN} item{waitingN === 1 ? " has" : "s have"} arrived since the last run: bank credit advices, client emails and wallet exports.
            {!lastRun ? " Run the workflow and watch it plan, read every document, match the money to invoices, raise flags and draft the follow-ups." : ""}
            {!lastRun ? (ws.approvalPolicy.mode === "autopilot" ? " Under autopilot, routine emails that pass every check go out on their own." : " Nothing is sent without your approval.") : ""}
          </p>
          {acts ? (
            <form action={runNow.bind(null, slug)} className="mt-3">
              <SubmitButton pendingText="Starting the run…">Run the workflow now</SubmitButton>
            </form>
          ) : null}
        </section>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Emails to approve" value={drafts.length} hint={pendingSend.length ? `${pendingSend.length} scheduled` : ws.approvalPolicy.mode === "autopilot" ? "autopilot: these need a person" : "supervised: you approve each one"} tone={drafts.length ? "warn" : undefined} />
        <Stat label="Open flags" value={openFlags.length} hint={[highOpen ? `${highOpen} high` : "none high", waitingOnReply ? `${waitingOnReply} waiting on a reply` : null].filter(Boolean).join(" · ")} tone={highOpen ? "bad" : undefined} />
        <Stat label="Tasks and checks" value={tasks.length + review.length + unmatched.length} hint="for a person" />
        <Stat label="Banking-channel share" value={share ? `${share.sharePct}%` : "—"} hint="this tax year, minimum 80%" tone={share ? (Number(share.sharePct) >= 85 ? "good" : "warn") : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title={`Emails waiting for approval (${drafts.length})`} pad={false}>
            {drafts.length ? (
              <ul className="divide-y divide-line">
                {drafts.map((d) => {
                  const sev = worst(d.flagIds);
                  return (
                    <li key={d.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1 basis-64">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span>{templateName(d.template)}</span>
                          {sev ? <Badge tone={severityTone(sev)}>{sev}</Badge> : null}
                          {d.status === "blocked" ? <Status value="blocked" label={d.rejectedReason ? "held: the invoice changed" : "blocked by the numbers check"} /> : d.numbersCheck?.ok ? <Badge tone="green">✓ {d.numbersCheck.found.length} {d.numbersCheck.found.length === 1 ? "number" : "numbers"} checked</Badge> : null}
                        </div>
                        <Link href={`${base}/drafts/${d.id}`} className="mt-1 block font-medium text-ink hover:text-accent">
                          {d.subject}
                        </Link>
                        <div className="truncate text-xs text-muted">To {d.toAddress}</div>
                      </div>
                      <div className="flex gap-2">
                        <Link href={`${base}/drafts/${d.id}`} className="btn btn-secondary">
                          Review
                        </Link>
                        {acts && d.status === "draft" ? (
                          <form action={approveDraft.bind(null, slug, d.id)}>
                            <SubmitButton pendingText="Sending…">Approve &amp; send</SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="p-4">
                <Empty>{lastRun ? "No emails waiting. Drafts appear here after a run." : "Run the workflow to draft this week's emails."}</Empty>
              </div>
            )}
          </Card>

          {pendingSend.length ? (
            <Card title="Going out on their own (autopilot)" pad={false}>
              <ul className="divide-y divide-line">
                {pendingSend.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <Link href={`${base}/drafts/${d.id}`} className="font-medium text-ink hover:text-accent">
                        {d.subject}
                      </Link>
                      <div className="text-xs text-muted">
                        {d.status === "approved" ? "Sends with the next run" : `Sends at ${clock(d.scheduledFor, ws.timezone)} unless cancelled`} · {templateName(d.template)}
                      </div>
                    </div>
                    {acts && d.status === "scheduled" ? (
                      <div className="flex gap-2">
                        <form action={rejectDraft.bind(null, slug, d.id)}>
                          <input type="hidden" name="reason" value="Cancelled before sending" />
                          <SubmitButton variant="danger" pendingText="Cancelling…">
                            Cancel
                          </SubmitButton>
                        </form>
                        <form action={approveDraft.bind(null, slug, d.id)}>
                          <SubmitButton pendingText="Sending…">Send now</SubmitButton>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title={`Tasks (${tasks.length})`} pad={false}>
            {tasks.length ? (
              <ul className="divide-y divide-line">
                {tasks.map((t) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-64">
                        <div className="font-medium text-ink">{t.title}</div>
                        {t.detail ? <p className="mt-1 whitespace-pre-line text-sm text-muted">{t.detail}</p> : null}
                        <div className="mt-1 text-xs text-muted">
                          {t.dueOn ? `Due ${day(t.dueOn)}` : null}
                          {t.flagId ? (
                            <>
                              {t.dueOn ? " · " : null}
                              <Link className="link" href={`${base}/flags/${t.flagId}`}>
                                see the flag
                              </Link>
                            </>
                          ) : null}
                        </div>
                      </div>
                      {acts ? (
                        <form action={completeTask.bind(null, slug, t.id)} className="flex gap-2">
                          <input name="note" placeholder="Note (optional)" className="input w-40" />
                          <SubmitButton variant="secondary" pendingText="Saving…">
                            Done
                          </SubmitButton>
                        </form>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <Empty>No open tasks.</Empty>
              </div>
            )}
          </Card>

          {review.length || unmatched.length ? (
            <Card title="Needs a person to check" pad={false}>
              <ul className="divide-y divide-line">
                {review.map((d) => (
                  <li key={d.id} className="px-4 py-3 text-sm">
                    <Link href={`${base}/documents/${d.id}`} className="font-medium text-ink hover:text-accent">
                      {d.originalName ?? "Document"}
                    </Link>
                    <div className="text-xs text-muted">{(d.reviewReasons ?? []).join(" ") || "The reader wasn't sure about this document."}</div>
                  </li>
                ))}
                {unmatched.map(({ tx, account }) => (
                  <li key={tx.id} className="px-4 py-3 text-sm">
                    <Link href={`${base}/payments/${tx.id}`} className="font-medium text-ink hover:text-accent">
                      {money(tx.amount, tx.currency)} from {tx.payerName ?? "unknown payer"}
                    </Link>
                    <div className="text-xs text-muted">
                      {day(tx.valueDate)} · {account} · no invoice matches by reference, payer and amount
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {lastRun ? (
            <Card title="Last run" actions={<Link href={`${base}/runs/${lastRun.id}`} className="link text-sm">Timeline →</Link>}>
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <Status value={lastRun.status} /> {clock(lastRun.clockAt, ws.timezone)}
              </div>
              {lastRun.summary ? (
                <ul className="list-disc space-y-1 pl-4 text-sm text-ink">
                  {lastRun.summary.split("\n").map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{lastRun.status === "queued" ? "Waiting for the worker…" : "In progress…"}</p>
              )}
            </Card>
          ) : null}

          <Card title="Mailbox">
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between">
                <span className="text-muted">Arrived, not yet read</span>
                <b className="tabular-nums">{waitingN}</b>
              </li>
              {ws.isDemo ? (
                <li className="flex justify-between gap-3">
                  <span className="text-muted">Still to come this demo</span>
                  <b className="tabular-nums">{upcomingN}</b>
                </li>
              ) : null}
            </ul>
            {ws.isDemo && upcomingN ? (
              <p className="mt-2 text-xs text-muted">
                Replies arrive during the week after you send the emails they answer (next item {clock(upcoming[0]?.next ?? null, ws.timezone)}). Use <b>Next Monday</b> to move the clock on.
              </p>
            ) : null}
          </Card>

          <Card title="Sent recently" pad={false}>
            {sent.length ? (
              <ul className="divide-y divide-line">
                {sent.map((m) => (
                  <li key={m.id} className="px-4 py-2.5 text-sm">
                    <div className="truncate text-ink">{m.subject}</div>
                    <div className="truncate text-xs text-muted">
                      To {m.toAddress} · {clock(m.sentAt, ws.timezone)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-sm text-muted">Nothing sent yet.</div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

