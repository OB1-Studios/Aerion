import { addDays, dateInZone, daysBetween, formatMoney, type Grouping } from "@ebo/core";
import { demoInboxItem, document, draftAction, flag, getDb, message, receivingAccount, run, task, transaction } from "@ebo/db";
import { dashboard, isMoneyIn, loadAgenda, loadBooks, loadContext, monthlyFlows, receivedBetween, type AgendaItem } from "@ebo/engine";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, min } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { Curves } from "@/components/brand";
import { ChartTable, GroupedColumns, type GroupedColumn } from "@/components/charts";
import { Icon, type IconName } from "@/components/icons";
import { MoreMenu } from "@/components/more-menu";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardLink, cx, Empty, Notice, Stat, Status, type Tone } from "@/components/ui";
import { clock, money, shortDay, templateName } from "@/lib/format";
import { flagKindLabel } from "@/lib/labels";
import { compact, rupees, valueAxis } from "@/lib/scale";
import { canAct, requireWorkspace } from "@/lib/session";
import { approveAll, approveDraft, completeTask, rejectDraft, runNow } from "../actions";

export const metadata = { title: "Dashboard" };

type Priority = "high" | "medium" | "info";
const PRIORITY: Record<Priority, { order: number; label: string; tone: Tone }> = {
  high: { order: 0, label: "High", tone: "red" },
  medium: { order: 1, label: "Medium", tone: "amber" },
  info: { order: 2, label: "Info", tone: "blue" },
};
const ACTIONS_SHOWN = 6;

/** "PKR 11.9M" or, in lakh grouping, "PKR 1.19 Cr": three significant figures for a headline. */
const headline = (x: string, g: Grouping) => (Math.abs(Number(x)) < 1000 ? rupees(x, g) : `PKR ${compact(Number(x), g)}`);

const inDays = (n: number) => (n < 0 ? `${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`);
const sinceDays = (n: number) => (n <= 0 ? "Today" : n === 1 ? "Yesterday" : `${n} days ago`);

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

interface ActionItem {
  key: string;
  priority: Priority;
  icon: IconName;
  title: ReactNode;
  sub: ReactNode;
  primary: ReactNode;
  menu?: ReactNode;
}

interface Activity {
  key: string;
  at: number;
  date: string;
  icon: IconName;
  text: ReactNode;
  href: string;
  badge: { tone: Tone; label: string };
}

const menuLink = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-ink hover:bg-sunken";

export default async function Dashboard({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { user, ws, role } = await requireWorkspace(slug);
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
    db.select({ id: flag.id, severity: flag.severity, status: flag.status, kind: flag.kind, summary: flag.summary, resolvedAt: flag.resolvedAt }).from(flag).where(eq(flag.workspaceId, ws.id)),
    loadAgenda(db, w, books),
  ]);
  // The position comes from the books, so it's right before the first run as well as after.
  const d = dashboard(books, w);
  const flows = monthlyFlows(books, w, 6);
  const last30 = receivedBetween(books, w, addDays(w.today, -29), w.today);
  const prev30 = receivedBetween(books, w, addDays(w.today, -59), addDays(w.today, -30));
  const change = Number(prev30.pkr) > 0 ? ((Number(last30.pkr) - Number(prev30.pkr)) / Number(prev30.pkr)) * 100 : null;

  const lastRun = runs[0];
  const flagById = new Map(flags.map((f) => [f.id, f]));
  // "Actioned" flags are still open: the email went out and Aerion is waiting for the fix.
  const openFlags = flags.filter((f) => f.status === "open" || f.status === "actioned");
  const waitingOnReply = openFlags.filter((f) => f.status === "actioned").length;
  const highOpen = openFlags.filter((f) => f.severity === "high").length;
  const acts = canAct(role);
  const waitingN = Number(arrived[0]?.n ?? 0);
  const upcomingN = Number(upcoming[0]?.n ?? 0);
  const approvable = drafts.filter((x) => x.status === "draft").length;
  const toCheck = review.length + unmatched.length;
  const needsPerson = drafts.length + tasks.length + toCheck;
  const worst = (ids: string[]): Priority | undefined =>
    ids
      .map((id) => flagById.get(id)?.severity)
      .filter((s): s is Priority => !!s)
      .sort((a, b) => PRIORITY[a].order - PRIORITY[b].order)[0];

  const flash = sp.sent
    ? (await db.select({ subject: draftAction.subject }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.id, sp.sent))))[0]?.subject
    : null;

  const running = lastRun?.status === "queued" || lastRun?.status === "running";
  const fullDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: ws.timezone }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: ws.timezone }).format(now));
  const firstName = user.isAnonymous ? null : (user.name ?? "").trim().split(/\s+/)[0] || null;
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}${firstName ? `, ${firstName}` : ""}`;

  // ── Action Center: everything that needs a person, highest priority first, one main action each.
  const items: ActionItem[] = [
    ...drafts.map((x): ActionItem => {
      const flagId = x.flagIds[0];
      return {
        key: `d-${x.id}`,
        priority: worst(x.flagIds) ?? "info",
        icon: "mail",
        title: x.subject,
        sub: (
          <>
            <span className="min-w-0 max-w-full truncate">
              {templateName(x.template)} · to {x.toAddress}
            </span>
            {x.status === "blocked" ? (
              <span className="basis-full font-semibold text-danger">Held: {x.rejectedReason ? "the records changed" : "a number doesn't match"}</span>
            ) : x.numbersCheck?.ok ? (
              <span className="basis-full font-semibold text-success">
                ✓ {x.numbersCheck.found.length} {x.numbersCheck.found.length === 1 ? "number" : "numbers"} checked against the records
                {x.model === "person" ? " · edited by a person" : ""}
              </span>
            ) : x.model === "person" ? (
              <span className="basis-full font-semibold text-success">Edited by a person</span>
            ) : null}
          </>
        ),
        primary: (
          <Link href={`${base}/drafts/${x.id}`} className="btn btn-primary h-8 px-3.5">
            Review
          </Link>
        ),
        menu:
          (acts && x.status === "draft") || flagId ? (
            <>
              {acts && x.status === "draft" ? (
                <form action={approveDraft.bind(null, slug, x.id)}>
                  <SubmitButton pendingText="Sending…" className="w-full" confirm="Send this email now? Its numbers are checked against the records once more before it goes.">
                    Approve and send now
                  </SubmitButton>
                </form>
              ) : null}
              {flagId ? (
                <Link href={`${base}/flags/${flagId}`} className={cx(menuLink, "mt-1")}>
                  <Icon name="shield" className="size-4 text-muted" /> The problem it answers
                </Link>
              ) : null}
            </>
          ) : undefined,
      };
    }),
    ...tasks.map((t): ActionItem => {
      const sev = t.flagId ? flagById.get(t.flagId)?.severity : undefined;
      return {
        key: `t-${t.id}`,
        priority: (sev as Priority | undefined) ?? "medium",
        icon: "user",
        title: t.title,
        sub: (
          <>
            {t.detail ? <span className="min-w-0 max-w-full basis-full truncate">{t.detail}</span> : null}
            <span className="basis-full">{t.dueOn ? `Due ${shortDay(t.dueOn)} · a task for a person` : "A task for a person"}</span>
          </>
        ),
        primary: t.flagId ? (
          <Link href={`${base}/flags/${t.flagId}`} className="btn btn-primary h-8 px-3.5">
            Open
          </Link>
        ) : acts ? (
          <form action={completeTask.bind(null, slug, t.id)}>
            <SubmitButton pendingText="Saving…" className="h-8 px-3.5">
              Mark done
            </SubmitButton>
          </form>
        ) : null,
        menu: acts ? (
          <form action={completeTask.bind(null, slug, t.id)} className="space-y-2 p-1">
            <label className="block text-xs font-semibold text-muted" htmlFor={`note-${t.id}`}>
              Mark it done, with a note if you like
            </label>
            <input id={`note-${t.id}`} name="note" placeholder="What was done (optional)" className="input h-9" />
            <SubmitButton variant="secondary" pendingText="Saving…" className="w-full">
              Mark done
            </SubmitButton>
          </form>
        ) : undefined,
      };
    }),
    ...review.map(
      (x): ActionItem => ({
        key: `r-${x.id}`,
        priority: "medium",
        icon: "doc",
        title: x.originalName ?? "Document",
        sub: (x.reviewReasons ?? []).join(" ") || "The reader wasn't sure about this document.",
        primary: (
          <Link href={`${base}/documents/${x.id}`} className="btn btn-primary h-8 px-3.5">
            Check
          </Link>
        ),
      }),
    ),
    ...unmatched.map(
      ({ tx, account }): ActionItem => ({
        key: `u-${tx.id}`,
        priority: "medium",
        icon: "card",
        title: (
          <>
            <span className="tabular-nums">{money(tx.amount, tx.currency)}</span> from {tx.payerName ?? "an unknown payer"}
          </>
        ),
        sub: `${shortDay(tx.valueDate)} · ${account ?? "account"} · no invoice matches by reference, payer and amount`,
        primary: (
          <Link href={`${base}/payments/${tx.id}`} className="btn btn-primary h-8 px-3.5">
            Place it
          </Link>
        ),
      }),
    ),
  ].sort((a, b) => PRIORITY[a.priority].order - PRIORITY[b.priority].order);
  const showAll = sp.all === "1";
  const shown = showAll ? items : items.slice(0, ACTIONS_SHOWN);

  // ── Financial overview: invoiced against received, the last six months, in PKR.
  const axis = valueAxis(Math.max(1, ...flows.flatMap((f) => [Number(f.invoicedPkr), Number(f.receivedPkr)])), g);
  const monthLong = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const columns: GroupedColumn[] = flows.map((f) => ({
    key: f.month,
    label: f.label,
    short: f.label.slice(0, 1),
    values: [Number(f.invoicedPkr), Number(f.receivedPkr)],
    partial: f.partial,
    aria: `${monthLong(f.month)}${f.partial ? " so far" : ""}: invoiced ${rupees(f.invoicedPkr, g)}, received ${rupees(f.receivedPkr, g)}`,
    tip: {
      value: `${monthLong(f.month)}${f.partial ? ", so far" : ""}`,
      lines: [`Invoiced ${rupees(f.invoicedPkr, g)} · ${f.invoices} invoice${f.invoices === 1 ? "" : "s"}`, `Received ${rupees(f.receivedPkr, g)} · ${f.payments} payment${f.payments === 1 ? "" : "s"}`],
    },
  }));
  const anyFlow = flows.some((f) => f.invoices || f.payments);
  const unpriced = flows.some((f) => f.unpriced);

  // ── Recent activity, from the records themselves (on the workspace's clock).
  const invoiceById = new Map(books.invoices.map((i) => [i.id, i]));
  const clientName = new Map(books.clients.map((c) => [c.id, c.name]));
  const paidBy = new Map<string, { numbers: string[]; client?: string }>();
  for (const m of books.matches) {
    const i = invoiceById.get(m.invoiceId);
    if (!i) continue;
    const cur = paidBy.get(m.transactionId) ?? { numbers: [] };
    cur.numbers.push(i.number);
    cur.client ??= clientName.get(i.clientId);
    paidBy.set(m.transactionId, cur);
  }
  const noon = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
  const activity: Activity[] = [
    ...books.transactions
      .filter(isMoneyIn)
      .sort((a, b) => b.valueDate.localeCompare(a.valueDate))
      .slice(0, 5)
      .map((t): Activity => {
        const paid = paidBy.get(t.id);
        const from = paid?.client ?? t.payerName;
        return {
          key: `p-${t.id}`,
          at: noon(t.valueDate),
          date: t.valueDate,
          icon: "card",
          text: (
            <>
              <span className="tabular-nums">{money(t.amount, t.currency)}</span> received{from ? ` from ${from}` : ""}
              {paid ? ` for ${paid.numbers.join(", ")}` : ""}
            </>
          ),
          href: `${base}/payments/${t.id}`,
          badge: paid ? { tone: "green", label: "Matched" } : t.matchStatus === "unmatched" ? { tone: "amber", label: "To place" } : { tone: "gray", label: "Recorded" },
        };
      }),
    ...sent.map(
      (m): Activity => ({
        key: `m-${m.id}`,
        at: m.sentAt?.getTime() ?? 0,
        date: m.sentAt ? dateInZone(m.sentAt, ws.timezone) : w.today,
        icon: "mail",
        text: <>Email sent: {m.subject}</>,
        href: `${base}/search?${new URLSearchParams({ q: (m.subject ?? "").slice(0, 60) })}`,
        badge: { tone: "violet", label: "Sent" },
      }),
    ),
    ...books.invoices
      .filter((i) => i.status !== "draft" && i.status !== "void")
      .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn))
      .slice(0, 5)
      .map(
        (i): Activity => ({
          key: `i-${i.id}`,
          at: noon(i.issuedOn) - 1,
          date: i.issuedOn,
          icon: "invoice",
          text: (
            <>
              Invoice {i.number} issued to {clientName.get(i.clientId) ?? "a client"}
            </>
          ),
          href: `${base}/invoices/${i.id}`,
          badge: { tone: "blue", label: "Issued" },
        }),
      ),
    ...flags
      .filter((f) => f.status === "resolved" && f.resolvedAt)
      .sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime())
      .slice(0, 5)
      .map(
        (f): Activity => ({
          key: `f-${f.id}`,
          at: f.resolvedAt!.getTime(),
          date: dateInZone(f.resolvedAt!, ws.timezone),
          icon: "checkCircle",
          text: <>Resolved on its own: {flagKindLabel(f.kind).toLowerCase()}</>,
          href: `${base}/flags/${f.id}`,
          badge: { tone: "green", label: "Resolved" },
        }),
      ),
  ]
    .filter((a) => a.date <= w.today)
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);

  // ── Insights, worked out from the records (not by a model), each with the way to the evidence.
  const late = d.owed.mostOverdue[0];
  const lateDraft = late ? drafts.find((x) => x.subject?.includes(late.number)) : undefined;
  const insights: Array<{ key: string; text: ReactNode; href: string; cta: string }> = [];
  if (late)
    insights.push({
      key: "late",
      text: (
        <>
          <b className="font-semibold text-white">{late.client}</b> is {late.daysLate} day{late.daysLate === 1 ? "" : "s"} late on {late.number}, with <span className="tabular-nums">{formatMoney(late.balance, late.currency, { grouping: g })}</span> still to pay.
          {lateDraft ? " A reminder is drafted and waiting for your approval." : ""}
        </>
      ),
      href: lateDraft ? `${base}/drafts/${lateDraft.id}` : `${base}/invoices/${late.id}`,
      cta: lateDraft ? "Review the reminder" : "Open the invoice",
    });
  if (change != null && Math.round(Math.abs(change)) >= 1)
    insights.push({
      key: "flow",
      text: (
        <>
          Money received in the last 30 days is <b className="font-semibold text-white">{Math.abs(change).toFixed(0)}% {change >= 0 ? "higher" : "lower"}</b> than in the 30 days before: {headline(last30.pkr, g)} against {headline(prev30.pkr, g)}.
        </>
      ),
      href: `${base}/payments`,
      cta: "See the payments",
    });
  if (!insights.length) insights.push({ key: "calm", text: <>Nothing is overdue, and nothing unusual stands out in the records.</>, href: `${base}/dashboard`, cta: "Financial overview" });

  return (
    <>
      <RunPoller active={running} everyMs={2000} />
      {running ? (
        <Notice tone="violet">
          A run is in progress.{" "}
          <Link href={`${base}/runs/${lastRun!.id}`} className="font-semibold underline">
            Watch the timeline
          </Link>
          ; this page updates when it finishes.
        </Notice>
      ) : null}

      <div className="mb-7 border-l-2 border-terracotta/80 pl-4 sm:pl-5">
        <div className="eyebrow mb-1.5">{fullDate}</div>
        <h1 className="font-display text-[34px] leading-[1.1] text-ink sm:text-[42px]">{greeting}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          Here&apos;s what&apos;s happening with {ws.name}&apos;s finances today.{" "}
          {lastRun ? (
            <>
              Last run {clock(lastRun.clockAt, ws.timezone)}:{" "}
              {needsPerson ? (
                <>
                  <b className="font-semibold text-ink">{needsPerson}</b> thing{needsPerson === 1 ? " needs" : "s need"} a person, the rest is handled or waiting on others.
                </>
              ) : (
                "nothing needs a person right now."
              )}{" "}
              <Link href={`${base}/runs/${lastRun.id}`} className="link whitespace-nowrap">
                See the run
              </Link>
            </>
          ) : null}
        </p>
      </div>

      {flash ? <Notice tone="green">Sent: {flash}.{ws.isDemo ? " Recorded in the demo mailbox (nothing leaves the demo)." : ""}</Notice> : null}
      {sp.sentAll ? <Notice tone="green">Sent {sp.sentAll} email{sp.sentAll === "1" ? "" : "s"}. Each one passed the numbers check again before sending.</Notice> : null}
      {sp.reset ? <Notice tone="violet">The demo is back at its starting point.</Notice> : null}

      {!lastRun || (waitingN > 0 && !running) ? (
        <section className="mb-7 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/20 bg-accent-soft/70 px-5 py-4">
          <div className="flex min-w-0 max-w-3xl gap-3">
            <Icon name="run" className="mt-0.5 size-6 shrink-0 text-accent" />
            <div>
              <h2 className="font-display text-lg text-ink">{lastRun ? "New items have arrived" : sp.welcome ? "Welcome: this is your own copy of the demo" : "Ready for the weekly run"}</h2>
              <p className="mt-1 text-sm text-ink/80">
                {ws.isDemo
                  ? `${waitingN} item${waitingN === 1 ? " has" : "s have"} arrived since the last run: bank credit advices, client emails and wallet exports.`
                  : "Aerion runs every Monday at 09:00 and whenever new mail arrives in the connected mailbox. You can also run it now, after uploading documents."}
                {!lastRun ? " The run reads every document, matches the money to invoices, raises flags and drafts the follow-ups." : ""}
                {!lastRun ? (ws.approvalPolicy.mode === "autopilot" ? " Under autopilot, routine emails that pass every check go out on their own." : " Nothing is sent without your approval.") : ""}
              </p>
            </div>
          </div>
          {acts ? (
            <form action={runNow.bind(null, slug)}>
              <SubmitButton pendingText="Starting the run…">Run the workflow now</SubmitButton>
            </form>
          ) : null}
        </section>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon="trend"
          tone="brand"
          label="Owed to you"
          value={d.owed.open ? headline(d.owed.totalPkr, g) : "Nothing"}
          href={`${base}/invoices`}
          hint={d.owed.open ? `${d.owed.open} open invoice${d.owed.open === 1 ? "" : "s"}, at today's reference rates` : "No open invoices"}
        />
        <Stat
          icon="card"
          tone="gold"
          label="Received, last 30 days"
          value={headline(last30.pkr, g)}
          href={`${base}/payments`}
          hint={
            change == null ? (
              `${last30.payments} payment${last30.payments === 1 ? "" : "s"}`
            ) : (
              <span className="inline-flex items-center gap-1">
                <Icon name={change >= 0 ? "arrowUp" : "arrowDown"} className={cx("size-3.5", change >= 0 ? "text-success" : "text-danger")} strokeWidth={2.2} />
                <b className={cx("font-semibold", change >= 0 ? "text-success" : "text-danger")}>{Math.abs(change).toFixed(0)}%</b> vs the 30 days before
              </span>
            )
          }
          spark={{ values: flows.map((f) => Number(f.receivedPkr)), label: `Received by month, ${flows[0]?.label} to ${flows.at(-1)?.label}` }}
        />
        <Stat
          icon="alert"
          tone={d.owed.overdue ? "bad" : "good"}
          label="Overdue"
          value={d.owed.overdue ? headline(d.owed.overduePkr, g) : "None"}
          href={`${base}/invoices?show=overdue`}
          hint={d.owed.overdue ? `${d.owed.overdue} invoice${d.owed.overdue === 1 ? "" : "s"}, oldest ${d.owed.mostOverdue[0]?.daysLate ?? 0} days late` : "Every open invoice is within terms"}
        />
        <Stat
          icon="checkCircle"
          tone="violet"
          label="Needs you"
          value={needsPerson}
          href="#actions"
          hint={needsPerson ? [drafts.length ? `${drafts.length} email${drafts.length === 1 ? "" : "s"} to approve` : null, tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : null, toCheck ? `${toCheck} to check` : null].filter(Boolean).join(" · ") : "All clear"}
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card
          id="actions"
          icon="bolt"
          title="Action Center"
          sub={ws.approvalPolicy.mode === "autopilot" ? "Autopilot: what still needs a person." : "Your attention is needed on these. Nothing goes out until you approve it."}
          pad={false}
          className="overflow-visible!"
          actions={
            <>
              {acts && approvable > 1 ? (
                <form action={approveAll.bind(null, slug)}>
                  <SubmitButton variant="secondary" pendingText="Sending…" className="h-8 px-3" confirm={`Send all ${approvable} emails now? Each is checked against the records again before it goes.`}>
                    Approve and send all {approvable}
                  </SubmitButton>
                </form>
              ) : null}
              {items.length > ACTIONS_SHOWN ? <CardLink href={showAll ? `${base}/inbox#actions` : `${base}/inbox?all=1#actions`}>{showAll ? "Show fewer" : `View all ${items.length}`}</CardLink> : null}
            </>
          }
        >
          {shown.length ? (
            <ul className="divide-y divide-line">
              {shown.map((it) => (
                <li key={it.key} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-5 py-3.5 sm:flex-nowrap">
                  <span className="w-[4.5rem] shrink-0">
                    <Badge tone={PRIORITY[it.priority].tone}>{PRIORITY[it.priority].label}</Badge>
                  </span>
                  <Icon name={it.icon} className="hidden size-5 shrink-0 text-muted sm:block" />
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <div className="truncate text-[14.5px] font-semibold text-ink">{it.title}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-1 text-xs text-muted">{it.sub}</div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {it.primary}
                    {it.menu ? <MoreMenu label="More actions">{it.menu}</MoreMenu> : <span className="size-9" />}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-5">
              <Empty>{lastRun ? "Nothing needs you right now. The next run drafts what's needed." : "Run the workflow to draft this week's emails and tasks."}</Empty>
            </div>
          )}
          <div className="border-t border-line px-5 py-3 text-xs text-muted">
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
            {ws.isDemo && upcomingN && !drafts.length ? ` Replies arrive in the week after the emails go out (next ${clock(upcoming[0]?.next ?? null, ws.timezone)}); press Next Monday to move the clock on.` : ""}
          </div>
        </Card>

        <Card
          icon="pie"
          title="Financial overview"
          sub="Invoiced and received, the last six months, in PKR"
          actions={<CardLink href={`${base}/dashboard`}>Full overview</CardLink>}
        >
          {anyFlow ? (
            <>
              <GroupedColumns
                columns={columns}
                series={[
                  { label: "Invoiced", color: "var(--series-1)" },
                  { label: "Received", color: "var(--series-2)" },
                ]}
                ticks={axis.ticks}
                top={axis.top}
                tickLabel={axis.label}
                height={190}
              />
              <p className="mt-4 text-xs leading-relaxed text-muted">
                Invoices at the reference rate on their date; money as credited, or at its value date&apos;s rate.
                {d.proceeds.sharePct ? (
                  <>
                    {" "}
                    Banking-channel share this tax year:{" "}
                    <Link href={`${base}/export`} className="link">
                      {d.proceeds.sharePct}%
                    </Link>{" "}
                    (minimum 80%).
                  </>
                ) : null}
                {unpriced ? " Some amounts had no reference rate and are left out." : ""}
              </p>
              <ChartTable head={["Month", "Invoiced (PKR)", "Received (PKR)"]} num={[1, 2]}>
                {flows.map((f) => (
                  <tr key={f.month}>
                    <td>
                      {monthLong(f.month)}
                      {f.partial ? " (so far)" : ""}
                    </td>
                    <td className="text-right tabular-nums">{rupees(f.invoicedPkr, g)}</td>
                    <td className="text-right tabular-nums">{rupees(f.receivedPkr, g)}</td>
                  </tr>
                ))}
              </ChartTable>
            </>
          ) : (
            <Empty>No invoices or payments in the last six months yet.</Empty>
          )}
        </Card>
      </div>

      {pendingSend.length ? (
        <Card title="Going out on their own" sub="Autopilot sends these at the time shown unless someone cancels." pad={false} icon="clock" className="mb-6">
          <ul className="divide-y divide-line">
            {pendingSend.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <Link href={`${base}/drafts/${x.id}`} className="font-semibold text-ink hover:text-accent">
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
                      <SubmitButton variant="danger" pendingText="Cancelling…" className="h-8 px-3">
                        Cancel
                      </SubmitButton>
                    </form>
                    <form action={approveDraft.bind(null, slug, x.id)}>
                      <SubmitButton pendingText="Sending…" className="h-8 px-3">
                        Send now
                      </SubmitButton>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.85fr)]">
        <Card icon="history" title="Recent activity" sub="From the records, newest first" pad={false} actions={<CardLink href={`${base}/audit`}>Audit history</CardLink>}>
          {activity.length ? (
            <ol className="px-5 py-2">
              {activity.map((a, i) => (
                <li key={a.key} className="relative flex items-start gap-3 py-2.5">
                  <span aria-hidden className="relative flex w-3 shrink-0 justify-center self-stretch">
                    <span className={cx("absolute top-[11px] size-2.5 rounded-full", i === 0 ? "bg-accent" : "bg-line-strong")} />
                    {i < activity.length - 1 ? <span className="absolute bottom-[-12px] top-[22px] w-px bg-line" /> : null}
                  </span>
                  <Icon name={a.icon} className="mt-[2px] hidden size-[18px] shrink-0 text-muted sm:block" />
                  <div className="min-w-0 flex-1">
                    <Link href={a.href} className="block text-sm text-ink hover:text-accent">
                      {a.text}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">{sinceDays(daysBetween(a.date, w.today))}</span>
                  </div>
                  <Badge tone={a.badge.tone}>{a.badge.label}</Badge>
                </li>
              ))}
            </ol>
          ) : (
            <div className="p-5 text-sm text-muted">Nothing recorded yet.</div>
          )}
        </Card>

        <Card icon="calendar" title="Upcoming deadlines" sub="What falls due next, from the records" pad={false}>
          {coming.length ? (
            <ul className="px-5 py-2">
              {coming.slice(0, 6).map((i) => {
                const date = new Date(`${i.date}T00:00:00Z`);
                return (
                  <li key={i.key}>
                    <Link href={agendaHref(base, i)} className="group flex items-center gap-3 rounded-md py-2.5">
                      <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-ink">
                        {date.getUTCDate()} {date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink group-hover:text-accent">{i.title}</span>
                        <span className="block truncate text-xs text-muted">
                          {i.amount ? `${formatMoney(i.amount.value, i.amount.currency, { grouping: g })} · ` : ""}
                          {i.detail}
                        </span>
                      </span>
                      <Badge tone={i.inDays < 0 ? "red" : i.inDays <= 3 ? "amber" : "blue"}>{inDays(i.inDays)}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-5 text-sm text-muted">Nothing falls due in the next two weeks.</div>
          )}
        </Card>

        <section className="relative flex flex-col overflow-hidden rounded-xl bg-[linear-gradient(160deg,var(--sidebar),var(--sidebar-deep))] p-5 text-sidebar-ink shadow-card lg:col-span-2 xl:col-span-1">
          <Curves className="h-36 opacity-[0.09]" />
          <div className="relative flex items-center gap-2.5">
            <Icon name="sparkle" className="size-[22px] text-gold" strokeWidth={1.8} />
            <h2 className="font-display text-[19px] text-white">{insights.length > 1 ? "Insights" : "Insight"}</h2>
          </div>
          <ul className="relative mt-3 space-y-4">
            {insights.map((x, i) => (
              <li key={x.key} className={cx(i > 0 && "border-t border-white/10 pt-4")}>
                <p className="text-[15px] leading-relaxed text-sidebar-ink">{x.text}</p>
                {/* A lighter gold than the token, so the link keeps its contrast on the green. */}
                <Link href={x.href} className="mt-1.5 inline-flex items-center gap-1 rounded text-sm font-semibold text-[#e2c690] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
                  {x.cta} <Icon name="arrowRight" className="size-4" strokeWidth={2} />
                </Link>
              </li>
            ))}
          </ul>
          <p className="relative mt-4 text-xs text-sidebar-muted">Worked out by Aerion from your records, not guessed by a model.</p>
          <div className="relative mt-auto pt-5">
            <Link href={`${base}/ask`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gold/70 px-3.5 text-sm font-semibold text-[#e2c690] hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-gold">
              Ask your books <Icon name="arrowRight" className="size-4" strokeWidth={2} />
            </Link>
          </div>
        </section>
      </div>

      {lastRun ? (
        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted">
          <Status value={lastRun.status} /> Last run {clock(lastRun.clockAt, ws.timezone)}
          {ws.isDemo ? ` · demo mailbox: ${waitingN} waiting, ${upcomingN} still to come` : ""}
        </p>
      ) : null}
    </>
  );
}
