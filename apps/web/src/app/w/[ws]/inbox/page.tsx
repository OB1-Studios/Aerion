import { formatMoney, type Grouping } from "@ebo/core";
import { demoInboxItem, document, draftAction, flag, getDb, message, receivingAccount, run, task, transaction } from "@ebo/db";
import { dashboard, loadAgenda, loadBooks, loadContext, type AgendaItem } from "@ebo/engine";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, min } from "drizzle-orm";
import Link from "next/link";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, cx, Empty, Notice, PageHeader, Stat, Status, severityTone } from "@/components/ui";
import { ago, clock, day, dayIn, money, templateName } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { approveAll, completeTask, rejectDraft, approveDraft, runNow } from "../actions";

export const metadata = { title: "Today" };

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

/** "PKR 11.9M" or, in lakh grouping, "PKR 1.19 Cr": three significant figures for a headline. */
function headline(x: string, g: Grouping): string {
  const v = Number(x);
  const units: Array<[number, string]> = g === "lakh" ? [[1e7, " Cr"], [1e5, " L"]] : [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const u = units.find(([n]) => Math.abs(v) >= n);
  return u ? `PKR ${Number((v / u[0]).toPrecision(3))}${u[1]}` : formatMoney(v.toFixed(2), "PKR", { grouping: g, decimals: 0 });
}

const when = (n: number) => (n < 0 ? `${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

function agendaHref(base: string, i: AgendaItem) {
  switch (i.ref.type) {
    case "invoice":
      return `${base}/invoices/${i.ref.id}`;
    case "client":
      return `${base}/clients/${i.ref.id}`;
    case "close":
      return `${base}/close/${i.ref.id}`;
    case "setup":
      return `${base}/setup`;
  }
}

const AGENDA_KIND: Record<AgendaItem["kind"], string> = { invoice_due: "Due", retainer: "Retainer", pseb: "PSEB", close: "Month-end" };

export default async function Today({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const now = ws.demoClock ?? new Date();
  const base = `/w/${slug}`;
  const g: Grouping = ws.numberGrouping;

  const w = await loadContext(db, ws.id);
  const books = await loadBooks(db, w);
  const [drafts, pendingSend, tasks, review, unmatched, runs, arrived, upcoming, sent, flags, coming] = await Promise.all([
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
    db.select().from(message).where(and(eq(message.workspaceId, ws.id), eq(message.direction, "out"))).orderBy(desc(message.sentAt)).limit(5),
    db.select({ id: flag.id, severity: flag.severity, status: flag.status, kind: flag.kind }).from(flag).where(eq(flag.workspaceId, ws.id)),
    loadAgenda(db, w, books),
  ]);
  // The position comes from the books, so it's right before the first run as well as after.
  const d = dashboard(books, w);
  const lastRun = runs[0];
  const flagById = new Map(flags.map((f) => [f.id, f]));
  // "Actioned" flags are still open: the email went out and the agent is waiting for the fix.
  const openFlags = flags.filter((f) => f.status === "open" || f.status === "actioned");
  const waitingOnReply = openFlags.filter((f) => f.status === "actioned").length;
  const highOpen = openFlags.filter((f) => f.severity === "high").length;
  const acts = canAct(role);
  const waitingN = Number(arrived[0]?.n ?? 0);
  const upcomingN = Number(upcoming[0]?.n ?? 0);
  const approvable = drafts.filter((x) => x.status === "draft").length;
  const toCheck = review.length + unmatched.length;
  const needsPerson = drafts.length + tasks.length + toCheck;
  const worst = (ids: string[]) => ids.map((id) => flagById.get(id)?.severity).filter((s): s is "high" | "medium" | "info" => !!s).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0];
  const share = d.proceeds.sharePct;

  const flash = sp.sent
    ? (await db.select({ subject: draftAction.subject }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.id, sp.sent))))[0]?.subject
    : null;

  const running = lastRun?.status === "queued" || lastRun?.status === "running";
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: ws.timezone }).format(now);

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
        eyebrow={today}
        title="Today"
        sub={
          lastRun ? (
            <>
              Last run {ws.isDemo ? `at ${clock(lastRun.clockAt, ws.timezone)}` : ago(lastRun.startedAt)}.{" "}
              {needsPerson ? (
                <>
                  <b className="font-medium text-ink">{needsPerson}</b> thing{needsPerson === 1 ? " needs" : "s need"} a person; the rest is handled or waiting on others.
                </>
              ) : (
                "Nothing needs a person right now."
              )}
            </>
          ) : (
            "No run yet. Your position below is from the records already in Aerion."
          )
        }
        actions={
          acts && approvable > 1 ? (
            <form action={approveAll.bind(null, slug)}>
              <SubmitButton variant="secondary" pendingText="Sending…" confirm={`Send all ${approvable} emails now? Each is checked against the records again before it goes.`}>
                Approve and send all {approvable}
              </SubmitButton>
            </form>
          ) : null
        }
      />

      {flash ? <Notice tone="green">Sent: {flash}.{ws.isDemo ? " Recorded in the demo mailbox (nothing leaves the demo)." : ""}</Notice> : null}
      {sp.sentAll ? <Notice tone="green">Sent {sp.sentAll} email{sp.sentAll === "1" ? "" : "s"}. Each one passed the numbers check again before sending.</Notice> : null}
      {sp.reset ? <Notice tone="violet">The demo is back at its starting point.</Notice> : null}

      {!lastRun || (waitingN > 0 && !running) ? (
        <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[10px] border border-accent/25 bg-accent-soft/60 px-5 py-4">
          <div className="min-w-0 max-w-3xl">
            <h2 className="font-semibold text-ink">{lastRun ? "New items have arrived" : sp.welcome ? "Welcome: this is your own copy of the demo" : "Ready for the weekly run"}</h2>
            <p className="mt-1 text-sm text-muted">
              {ws.isDemo
                ? `${waitingN} item${waitingN === 1 ? " has" : "s have"} arrived since the last run: bank credit advices, client emails and wallet exports.`
                : "Aerion runs every Monday at 09:00 and whenever new mail arrives in the connected mailbox. You can also run it now, after uploading documents."}
              {!lastRun ? " The run reads every document, matches the money to invoices, raises flags and drafts the follow-ups." : ""}
              {!lastRun ? (ws.approvalPolicy.mode === "autopilot" ? " Under autopilot, routine emails that pass every check go out on their own." : " Nothing is sent without your approval.") : ""}
            </p>
          </div>
          {acts ? (
            <form action={runNow.bind(null, slug)}>
              <SubmitButton pendingText="Starting the run…">Run the workflow now</SubmitButton>
            </form>
          ) : null}
        </section>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Needs you"
          value={needsPerson}
          href="#needs"
          tone={needsPerson ? "warn" : undefined}
          hint={needsPerson ? [drafts.length ? `${drafts.length} to approve` : null, tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : null, toCheck ? `${toCheck} to check` : null].filter(Boolean).join(" · ") : "all clear"}
        />
        <Stat label="Owed to you" value={d.owed.open ? headline(d.owed.totalPkr, g) : "Nothing"} href={`${base}/invoices`} hint={d.owed.open ? `${d.owed.open} open invoice${d.owed.open === 1 ? "" : "s"} at today's rates` : "no open invoices"} />
        <Stat
          label="Overdue"
          value={d.owed.overdue ? headline(d.owed.overduePkr, g) : "None"}
          href={`${base}/invoices?show=overdue`}
          tone={d.owed.overdue ? "bad" : "good"}
          hint={d.owed.overdue ? `${d.owed.overdue} invoice${d.owed.overdue === 1 ? "" : "s"}, oldest ${d.owed.mostOverdue[0]?.daysLate ?? 0} days late` : "every open invoice is within terms"}
        />
        <Stat
          label="Banking-channel share"
          value={share ? `${share}%` : "—"}
          href={`${base}/export`}
          tone={share ? (Number(share) >= 85 ? "good" : "warn") : undefined}
          hint={`tax year ${d.year.label} so far · minimum 80%`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div id="needs" className="min-w-0 scroll-mt-4 space-y-6">
          <Card
            title="Emails waiting for your approval"
            sub={ws.approvalPolicy.mode === "autopilot" ? "Autopilot: these are the ones that always need a person." : "Supervised: nothing goes out until you approve it."}
            actions={<span className="text-sm tabular-nums text-muted">{drafts.length}</span>}
            pad={false}
          >
            {drafts.length ? (
              <ul className="divide-y divide-line">
                {drafts.map((x) => {
                  const sev = worst(x.flagIds);
                  return (
                    <li key={x.id} className="flex flex-wrap items-start gap-3 px-4 py-3.5">
                      <div className="min-w-0 flex-1 basis-64">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          <span>{templateName(x.template)}</span>
                          {sev ? <Badge tone={severityTone(sev)}>{sev === "high" ? "High risk" : sev === "medium" ? "Medium risk" : "Info"}</Badge> : null}
                          {x.model === "person" ? <Badge tone="green" title="A person rewrote this email">Edited</Badge> : null}
                          {x.status === "blocked" ? (
                            <Badge tone="red" title={x.rejectedReason ?? "A number in the text doesn't match the records"}>
                              Held: {x.rejectedReason ? "the records changed" : "a number doesn't match"}
                            </Badge>
                          ) : x.numbersCheck?.ok ? (
                            <Badge tone="green" title="Every amount, date and invoice number in the text was matched to the records">
                              ✓ {x.numbersCheck.found.length} {x.numbersCheck.found.length === 1 ? "number" : "numbers"} checked
                            </Badge>
                          ) : null}
                        </div>
                        <Link href={`${base}/drafts/${x.id}`} className="mt-1 block font-medium text-ink hover:text-accent">
                          {x.subject}
                        </Link>
                        <div className="truncate text-xs text-muted">To {x.toAddress}</div>
                      </div>
                      <div className="flex gap-2">
                        <Link href={`${base}/drafts/${x.id}`} className="btn btn-secondary">
                          Review
                        </Link>
                        {acts && x.status === "draft" ? (
                          <form action={approveDraft.bind(null, slug, x.id)}>
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
                <Empty>{lastRun ? "No emails waiting. The next run drafts what's needed." : "Run the workflow to draft this week's emails."}</Empty>
              </div>
            )}
          </Card>

          {pendingSend.length ? (
            <Card title="Going out on their own" sub="Autopilot sends these at the time shown unless someone cancels." pad={false}>
              <ul className="divide-y divide-line">
                {pendingSend.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <Link href={`${base}/drafts/${x.id}`} className="font-medium text-ink hover:text-accent">
                        {x.subject}
                      </Link>
                      <div className="text-xs text-muted">
                        {x.status === "approved" ? "Sends with the next run" : `Sends at ${clock(x.scheduledFor, ws.timezone)} unless cancelled`} · {templateName(x.template)}
                      </div>
                    </div>
                    {acts && x.status === "scheduled" ? (
                      <div className="flex gap-2">
                        <form action={rejectDraft.bind(null, slug, x.id)}>
                          <input type="hidden" name="reason" value="Cancelled before sending" />
                          <SubmitButton variant="danger" pendingText="Cancelling…">
                            Cancel
                          </SubmitButton>
                        </form>
                        <form action={approveDraft.bind(null, slug, x.id)}>
                          <SubmitButton pendingText="Sending…">Send now</SubmitButton>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Tasks for a person" sub="What software can't do: calls, checks with the bank or the accountant." actions={<span className="text-sm tabular-nums text-muted">{tasks.length}</span>} pad={false}>
            {tasks.length ? (
              <ul className="divide-y divide-line">
                {tasks.map((t) => (
                  <li key={t.id} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-64">
                        <div className="font-medium text-ink">{t.title}</div>
                        {t.detail ? <p className="mt-1 whitespace-pre-line text-sm text-muted">{t.detail}</p> : null}
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                          {t.dueOn ? <span>Due {day(t.dueOn)}</span> : null}
                          {t.flagId ? (
                            <Link className="link" href={`${base}/flags/${t.flagId}`}>
                              See the flag
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      {acts ? (
                        <form action={completeTask.bind(null, slug, t.id)} className="flex w-full gap-2 sm:w-auto">
                          <input name="note" aria-label="Note (optional)" placeholder="Note (optional)" className="input min-w-0 flex-1 sm:w-44" />
                          <SubmitButton variant="secondary" pendingText="Saving…">
                            Mark done
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

          {toCheck ? (
            <Card title="Needs a person to check" sub="Documents the reader wasn't sure about, and money that matched no invoice." actions={<span className="text-sm tabular-nums text-muted">{toCheck}</span>} pad={false}>
              <ul className="divide-y divide-line">
                {review.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0 flex-1 basis-64">
                      <Link href={`${base}/documents/${x.id}`} className="font-medium text-ink hover:text-accent">
                        {x.originalName ?? "Document"}
                      </Link>
                      <div className="text-xs text-muted">{(x.reviewReasons ?? []).join(" ") || "The reader wasn't sure about this document."}</div>
                    </div>
                    <Link href={`${base}/documents/${x.id}`} className="btn btn-secondary">
                      Check
                    </Link>
                  </li>
                ))}
                {unmatched.map(({ tx, account }) => (
                  <li key={tx.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0 flex-1 basis-64">
                      <Link href={`${base}/payments/${tx.id}`} className="font-medium text-ink hover:text-accent">
                        <span className="tabular-nums">{money(tx.amount, tx.currency)}</span> from {tx.payerName ?? "unknown payer"}
                      </Link>
                      <div className="text-xs text-muted">
                        {day(tx.valueDate)} · {account} · no invoice matches by reference, payer and amount
                      </div>
                    </div>
                    <Link href={`${base}/payments/${tx.id}`} className="btn btn-secondary">
                      Place it
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <p className="text-xs text-muted">
            {openFlags.length ? (
              <>
                <Link href={`${base}/flags`} className="link">
                  {openFlags.length} open flag{openFlags.length === 1 ? "" : "s"}
                </Link>
                {highOpen ? `, ${highOpen} high` : ""}
                {waitingOnReply ? `; ${waitingOnReply} waiting on a reply after the email went out` : ""}. Flags close on their own when the records show the problem is fixed.
              </>
            ) : (
              "No open flags."
            )}
          </p>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Coming up" sub="Next 14 days, from the records" pad={false}>
            {coming.length ? (
              <ul className="divide-y divide-line">
                {coming.map((i) => {
                  const date = new Date(`${i.date}T00:00:00Z`);
                  return (
                    <li key={i.key}>
                      <Link href={agendaHref(base, i)} className="flex items-start gap-3 px-4 py-3 hover:bg-sunken">
                        <div className={cx("w-11 shrink-0 rounded-md border py-1 text-center leading-none", i.inDays < 0 ? "border-rose-300 text-rose-700 dark:border-rose-900 dark:text-rose-300" : i.inDays <= 2 ? "border-amber-300 text-amber-800 dark:border-amber-900 dark:text-amber-300" : "border-line text-ink")}>
                          <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</div>
                          <div className="mt-0.5 text-base font-semibold tabular-nums">{date.getUTCDate()}</div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium text-ink">{i.title}</span>
                            {i.amount ? <span className="whitespace-nowrap text-xs tabular-nums text-ink">{formatMoney(i.amount.value, i.amount.currency, { grouping: g })}</span> : null}
                          </div>
                          <div className="truncate text-xs text-muted">{i.detail}</div>
                          <div className="mt-0.5 text-[11px] text-muted">
                            {AGENDA_KIND[i.kind]} · {when(i.inDays)}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="p-4 text-sm text-muted">Nothing falls due in the next two weeks.</div>
            )}
          </Card>

          {d.owed.mostOverdue.length ? (
            <Card title="Overdue invoices" actions={<Link href={`${base}/invoices?show=overdue`} className="link text-sm">All overdue →</Link>} pad={false}>
              <ul className="divide-y divide-line">
                {d.owed.mostOverdue.slice(0, 5).map((o) => (
                  <li key={o.id}>
                    <Link href={`${base}/invoices/${o.id}`} className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-sunken">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink">{o.number}</span>
                        <span className="block truncate text-xs text-muted">{o.client}</span>
                      </span>
                      <span className="text-right">
                        <span className="block whitespace-nowrap text-sm tabular-nums text-ink">{formatMoney(o.balance, o.currency, { grouping: g })}</span>
                        <span className="block text-xs text-rose-700 dark:text-rose-400">{o.daysLate} day{o.daysLate === 1 ? "" : "s"} late</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {lastRun ? (
            <Card title="Last run" actions={<Link href={`${base}/runs/${lastRun.id}`} className="link text-sm">Timeline →</Link>}>
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <Status value={lastRun.status} /> {clock(lastRun.clockAt, ws.timezone)}
              </div>
              {lastRun.summary ? (
                <ul className="list-disc space-y-1 pl-4 text-sm text-ink marker:text-muted">
                  {lastRun.summary.split("\n").map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{lastRun.status === "queued" ? "Waiting for the worker…" : "In progress…"}</p>
              )}
            </Card>
          ) : null}

          {ws.isDemo ? (
            <Card title="Demo mailbox">
              <ul className="space-y-1 text-sm">
                <li className="flex justify-between">
                  <span className="text-muted">Arrived, not yet read</span>
                  <b className="tabular-nums">{waitingN}</b>
                </li>
                <li className="flex justify-between gap-3">
                  <span className="text-muted">Still to come this demo</span>
                  <b className="tabular-nums">{upcomingN}</b>
                </li>
              </ul>
              {upcomingN ? (
                <p className="mt-2 text-xs text-muted">
                  Replies arrive during the week after you send the emails they answer (next item {clock(upcoming[0]?.next ?? null, ws.timezone)}). Use <b>Next Monday</b> to move the clock on.
                </p>
              ) : null}
            </Card>
          ) : null}

          <Card title="Sent recently" pad={false}>
            {sent.length ? (
              <ul className="divide-y divide-line">
                {sent.map((m) => (
                  <li key={m.id} className="px-4 py-2.5 text-sm">
                    <div className="truncate text-ink" title={m.subject ?? undefined}>
                      {m.subject}
                    </div>
                    <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
                      <span className="min-w-0 truncate">To {m.toAddress}</span>
                      <span className="shrink-0 tabular-nums" title={clock(m.sentAt, ws.timezone)}>
                        {dayIn(m.sentAt, ws.timezone)}
                      </span>
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
