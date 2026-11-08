import { dateInZone, formatMoney } from "@ebo/core";
import { getDb, run } from "@ebo/db";
import { AGE_BANDS, closeView, isMonth, loadContext, type CheckLine, type CheckState, type CloseItem } from "@ebo/engine";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, ReasonForm } from "@/components/action-form";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Card, KeyValues, Notice, PageHeader, Table, cx } from "@/components/ui";
import { day } from "@/lib/format";
import { canAct, canExport, requireWorkspace } from "@/lib/session";
import { closeMonthAction, reopenMonthAction, uploadSampleStatements } from "../actions";

export const metadata = { title: "Month-end close" };

const BAND_LABEL = {
  current: "Not yet due",
  "1-30": "1–30 days late",
  "31-60": "31–60",
  "61-90": "61–90",
  "90+": "Over 90",
} as const;
const STATE_TEXT: Record<CheckState, string> = {
  done: "Done",
  waiting: "Waiting",
  todo: "To do",
};

function Mark({ state }: { state: CheckState }) {
  const tone = state === "done" ? "bg-success text-white dark:text-canvas" : state === "waiting" ? "bg-warning-soft text-ink ring-1 ring-warning-line" : "bg-danger text-white dark:text-canvas";
  const glyph = state === "done" ? "✓" : state === "waiting" ? "…" : "!";
  return (
    <span aria-hidden className={cx("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold", tone)}>
      {glyph}
    </span>
  );
}

function Lines({ lines, base }: { lines: CheckLine[]; base: string }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span aria-hidden className={cx("mt-[0.45rem] size-1.5 shrink-0 rounded-full", l.state === "todo" ? "bg-danger" : l.state === "waiting" ? "bg-warning" : "bg-success")} />
          <span className="min-w-0">
            <span className="sr-only">{STATE_TEXT[l.state]}: </span>
            {l.text}{" "}
            {l.path ? (
              <Link href={`${base}/${l.path}`} className="link whitespace-nowrap">
                Open
              </Link>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Item({ item, base, extra }: { item: CloseItem; base: string; extra?: React.ReactNode }) {
  const todo = item.lines.filter((l) => l.state === "todo");
  const waiting = item.lines.filter((l) => l.state === "waiting");
  const done = item.lines.filter((l) => l.state === "done");
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <Mark state={item.state} />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="font-medium text-ink">{item.title}</h3>
            <span className={cx("text-xs font-medium", item.state === "done" ? "text-success" : item.state === "waiting" ? "text-warning" : "text-danger")}>{STATE_TEXT[item.state]}</span>
          </div>
          <p className="text-sm text-muted">{item.summary}</p>
        </div>
        {todo.length ? <Lines lines={todo} base={base} /> : null}
        {done.length ? <Lines lines={done} base={base} /> : null}
        {waiting.length ? (
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted hover:text-ink">
              {waiting.length} waiting on someone else <span className="group-open:hidden">(show)</span>
            </summary>
            <div className="mt-2">
              <Lines lines={waiting} base={base} />
            </div>
          </details>
        ) : null}
        {extra}
      </div>
    </li>
  );
}

export default async function CloseMonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string; month: string }>;
  searchParams: Promise<{
    closed?: string;
    reopened?: string;
    samples?: string;
    run?: string;
  }>;
}) {
  const { ws: slug, month } = await params;
  const q = await searchParams;
  if (!isMonth(month)) notFound();
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const w = await loadContext(db, ws.id);
  const [v, latest] = await Promise.all([
    closeView(db, w, month),
    q.run
      ? db
          .select({ status: run.status })
          .from(run)
          .where(and(eq(run.workspaceId, ws.id), eq(run.id, q.run)))
          .orderBy(desc(run.startedAt))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const running = !!latest[0] && ["queued", "running"].includes(latest[0].status);
  const base = `/w/${slug}`;
  const g = { grouping: ws.numberGrouping };
  const money = (a: string, c: string) => formatMoney(a, c, g);
  const rec = v.record;
  const closed = rec?.status === "closed";
  const report = rec?.reportDocumentId ? `/api/w/${slug}/documents/${rec.reportDocumentId}` : null;
  const closedOn = rec?.closedAt ? day(dateInZone(new Date(rec.closedAt), ws.timezone)) : null;
  const waiting = v.items.reduce((n, i) => n + i.lines.filter((l) => l.state === "waiting").length, 0);
  // The demo can make last month's statements from its own books.
  const lastMonth = (() => {
    const [y, m] = w.today.split("-").map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  })();
  const statements = v.items.find((i) => i.key === "statements");
  const offerSample = ws.isDemo && canAct(role) && !closed && month === lastMonth && statements?.lines.some((l) => l.text.startsWith("No "));

  return (
    <>
      <RunPoller active={running} />
      <PageHeader
        title={`Month-end close: ${v.label}`}
        sub={`${day(v.start)} to ${day(v.end)}.`}
        actions={
          <Link href={`${base}/close`} className="btn btn-secondary">
            All months
          </Link>
        }
      />

      {q.closed && closed ? (
        <Notice>
          {v.label} is closed.{" "}
          {report ? (
            <a href={report} className="font-medium underline underline-offset-2">
              Open the report (PDF)
            </a>
          ) : null}
        </Notice>
      ) : null}
      {q.reopened && !closed ? <Notice tone="amber">{v.label} is open again. Its earlier report stays on file; closing it again makes a new one.</Notice> : null}
      {q.samples ? (
        <Notice tone="violet">
          Uploaded {q.samples} SIMULATED bank statement
          {q.samples === "1" ? "" : "s"} for {v.label}. {running ? "The agent is reading them now; this page updates as it goes." : "Read."}{" "}
          {q.run ? (
            <Link href={`${base}/runs/${q.run}`} className="link">
              See the run
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {closed && !q.closed ? (
        <Notice tone={v.changedSinceClose ? "amber" : "green"}>
          {rec?.closedByName ? `Closed by ${rec.closedByName}` : "Closed"}
          {closedOn ? ` on ${closedOn}` : ""}.{" "}
          {report ? (
            <a href={report} className="font-medium underline underline-offset-2">
              Open the report (PDF)
            </a>
          ) : (
            "It was closed before the demo began, so there's no report from the app."
          )}
          {v.changedSinceClose ? ` Something in ${v.label} has changed since it was closed. The owner can reopen it, so it can be closed again with a new report.` : ""}
        </Notice>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card title="Checklist" pad={false}>
            <ul className="divide-y divide-line">
              {v.items.map((i) => (
                <Item
                  key={i.key}
                  item={i}
                  base={base}
                  extra={
                    i.key === "statements" && offerSample ? (
                      <form action={uploadSampleStatements.bind(null, slug, month)} className="flex flex-wrap items-center gap-3 pt-1">
                        <SubmitButton variant="secondary" pendingText="Uploading…">
                          Upload sample statements for {v.label}
                        </SubmitButton>
                        <span className="text-xs text-muted">SIMULATED, made from this workspace&apos;s books with the month&apos;s payroll, rent and bills added.</span>
                      </form>
                    ) : null
                  }
                />
              ))}
            </ul>
          </Card>
          <Card title={`${v.label} in numbers`}>
            <KeyValues
              rows={[
                ["Money received", v.numbers.received.length ? v.numbers.received.map((r) => `${money(r.amount, r.currency)} (${r.count})`).join(", ") : "Nothing came in"],
                ["Banked in Pakistan", money(v.numbers.bankedPkr, "PKR")],
                ["Invoices issued", v.numbers.issued.length ? v.numbers.issued.map((r) => `${r.count} for ${money(r.amount, r.currency)}`).join(", ") : "None"],
                ["Owed at month end", v.numbers.owed.length ? v.numbers.owed.map((r) => `${money(r.amount, r.currency)} on ${r.invoices} invoice${r.invoices === 1 ? "" : "s"}`).join(", ") : "Nothing"],
                ...v.numbers.statements.map((s): [string, string] => [`${s.account} statement`, `${money(s.balance, s.currency)} on ${day(s.on)}`]),
              ]}
            />
            {v.numbers.owed.length ? (
              <div className="-mx-4 mt-4 border-t border-line">
                <Table dense head={["Owed by age", ...AGE_BANDS.map((b) => BAND_LABEL[b])]}>
                  {v.numbers.owed.map((r) => (
                    <tr key={r.currency}>
                      <td className="font-medium">{r.currency}</td>
                      {AGE_BANDS.map((b) => (
                        <td key={b} className="whitespace-nowrap text-right tabular-nums">
                          {r.bands[b] === "0.00" ? <span className="text-muted">–</span> : money(r.bands[b], r.currency).replace(`${r.currency} `, "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Table>
              </div>
            ) : null}
            <p className="mt-3 text-xs text-muted">
              From the records as of {day(w.today)}. &ldquo;Owed at month end&rdquo; counts only what had come in by {day(v.end)}.
            </p>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-4">
          <Card title={closed ? "Closed" : "Close the month"}>
            {closed ? (
              role === "owner" ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted">Reopen it if something in {v.label} has to change. The reason goes in the audit log.</p>
                  <ReasonForm action={reopenMonthAction.bind(null, slug, month)} label="Reopen" pendingText="Reopening…" placeholder="The bank sent a corrected ePRC" />
                </div>
              ) : (
                <p className="text-sm text-muted">Only the workspace owner can reopen a closed month.</p>
              )
            ) : v.canClose && canExport(role) ? (
              <ActionForm
                action={closeMonthAction.bind(null, slug, month)}
                label={`Close ${v.label}`}
                pendingText="Closing and writing the report…"
                title="Not closed:"
                hint={`Makes the month-end report (PDF) for the director and records who closed it.${waiting ? ` The ${waiting} item${waiting === 1 ? "" : "s"} still waiting go in the report.` : ""}`}
              />
            ) : (
              <p className="text-sm text-ink">{v.blocked ?? "Your role can see the close but not close a month."}</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
