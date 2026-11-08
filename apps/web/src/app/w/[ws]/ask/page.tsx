import { askPlannerFromEnv } from "@ebo/ai";
import { getDb } from "@ebo/db";
import { ASK_QUESTION_MAX, ASK_TOOL_LABEL, ASK_TOOLS, askBooks, askScope, exampleQuestions, loadBooks, loadContext, type AskLine, type AskResult } from "@ebo/engine";
import Link from "next/link";
import { Badge, Card, cx, Notice, PageHeader } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Ask your books" };

const TOOL_ABOUT: Record<(typeof ASK_TOOLS)[number], string> = {
  owed: "Open invoices and their balances, for everyone or one client.",
  overdue: "What's past its due date, oldest first.",
  received: "Payments in a month, a quarter or the tax year, with the invoices they paid.",
  proceeds: "Export proceeds credited to your Pakistani accounts, month by month.",
  banking_share: "How much of this year's proceeds came through Pakistani banks.",
  missing_paperwork: "ePRCs and withholding certificates still to come from the bank.",
  cost: "Bank fees and conversion losses, by route and by client.",
  days_to_pay: "How long each client takes to pay, against their terms.",
  invoice: "One invoice from issue to payment, with anything open on it.",
};

const TONE_TEXT = { bad: "text-danger", warn: "text-warning", good: "text-success" } as const;

export default async function AskPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ q?: string }> }) {
  const { ws: slug } = await params;
  const { q = "" } = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const base = `/w/${slug}`;
  const db = getDb();
  const w = await loadContext(db, ws.id);
  // A model may choose the query only where the workspace allows AI, and only when a key is set.
  const planner = ws.aiReadingEnabled ? askPlannerFromEnv() : null;
  const asked = q.trim().length > 0;
  const books = await loadBooks(db, w);
  const result: AskResult | null = asked ? await askBooks(db, w, q, planner, books) : null;
  const examples = exampleQuestions(askScope(books, w));

  return (
    <>
      <PageHeader
        eyebrow="Intelligence & automation"
        title="Ask your books"
        sub="Ask about what's owed, what came in, missing paperwork, costs or one invoice. Aerion turns the question into one of a fixed set of queries and works out every figure from your records, so the numbers match the rest of the app. It never guesses an amount and never changes anything."
      />

      <form action={`${base}/ask`} method="get" className="mb-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="ask-q" className="sr-only">
          Your question
        </label>
        <input id="ask-q" name="q" defaultValue={q} maxLength={ASK_QUESTION_MAX} autoComplete="off" placeholder="What does a client owe? How much came in last month?" className="input h-11 flex-1 text-base" autoFocus={!asked} />
        <button className="btn btn-primary h-11 px-5">Ask</button>
      </form>
      <div className="mb-6 flex flex-wrap gap-1.5">
        {examples.map((e) => (
          <Link key={e} href={`${base}/ask?${new URLSearchParams({ q: e })}`} className="rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink">
            {e}
          </Link>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {result ? <Answer result={result} base={base} /> : <Intro />}
        </div>
        <aside className="space-y-4">
          <Card title="What it can answer" pad={false}>
            <ul className="divide-y divide-line text-sm">
              {ASK_TOOLS.map((t) => (
                <li key={t} className="px-4 py-2.5">
                  <div className="font-medium text-ink">{ASK_TOOL_LABEL[t]}</div>
                  <p className="text-xs leading-relaxed text-muted">{TOOL_ABOUT[t]}</p>
                </li>
              ))}
            </ul>
          </Card>
          <p className="px-1 text-xs leading-relaxed text-muted">
            {planner
              ? `Built-in rules read the question first. When they can't place it, ${planner.model} on Vultr Serverless Inference chooses the query from your client names and today's date, never amounts or documents, and Aerion checks its choice before using it.`
              : ws.aiReadingEnabled
                ? "Built-in rules read each question. No AI model is set up in this environment."
                : "Built-in rules read each question. AI is switched off for this workspace in Settings."}
          </p>
        </aside>
      </div>
    </>
  );
}

function Intro() {
  return (
    <Card>
      <p className="text-sm leading-relaxed text-ink">Type a question in your own words, or pick one above. Each answer shows how it was worked out and links every line to the record behind it, so you can check it.</p>
    </Card>
  );
}

function Answer({ result, base }: { result: AskResult; base: string }) {
  if (!result.ok) {
    return (
      <div>
        {result.reason === "too_long" ? (
          <Notice tone="amber">Keep the question under {ASK_QUESTION_MAX} characters.</Notice>
        ) : result.reason === "not_understood" ? (
          <Notice tone="amber">
            <p>
              Aerion couldn&apos;t match &ldquo;{result.question}&rdquo; to something it can work out from your records. Try naming a client, an invoice number or a month, or pick one of the questions above.
            </p>
            {result.modelNote ? <p className="mt-1 text-xs opacity-80">{result.modelNote}</p> : null}
          </Notice>
        ) : null}
        <Intro />
      </div>
    );
  }
  const { answer: a, chosenBy, plan } = result;
  const groups = new Map<string, AskLine[]>();
  for (const l of a.lines) groups.set(l.group ?? "", [...(groups.get(l.group ?? "") ?? []), l]);
  const link = (href: string) => `${base}${href}`;
  return (
    <section className="overflow-hidden rounded-[10px] border border-line bg-panel" aria-live="polite">
      <header className="border-b border-line px-5 py-4">
        <p className="text-sm text-muted">&ldquo;{result.question}&rdquo;</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          {chosenBy.by === "rules" ? (
            <Badge tone="gray" title="Matched by Aerion's built-in rules; no model involved">
              Read by rules
            </Badge>
          ) : (
            <Badge tone="blue" title="A model chose the query and its client, invoice or dates; Aerion checked the choice and computed the answer">
              Query chosen by {chosenBy.model}
            </Badge>
          )}
          <Badge tone="green" title="Every figure below is computed by code from your records">
            Figures from your records
          </Badge>
          <span>Query: {ASK_TOOL_LABEL[plan.tool]}</span>
        </div>
      </header>
      <div className="px-5 py-5">
        <div className="eyebrow mb-1.5">{a.title}</div>
        <div className="font-display text-[32px] leading-tight text-ink tabular-nums">{a.headline}</div>
        {a.sub ? <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{a.sub}</p> : null}
      </div>
      {a.lines.length ? (
        <div className="border-t border-line">
          {[...groups].map(([g, lines]) => (
            <div key={g || "lines"}>
              {g ? <div className="eyebrow border-b border-line bg-sunken/60 px-5 py-2">{g}</div> : null}
              <ul className="divide-y divide-line">
                {lines.map((l, i) => {
                  const body = (
                    <>
                      <span className="min-w-0">
                        <span className={cx("block break-words text-sm text-ink", l.href ? "group-hover:text-accent" : "")}>{l.label}</span>
                        {l.detail ? <span className="block text-xs leading-relaxed text-muted">{l.detail}</span> : null}
                      </span>
                      <span className={cx("shrink-0 text-right text-sm font-medium tabular-nums", l.tone ? TONE_TEXT[l.tone] : "text-ink")}>{l.value}</span>
                    </>
                  );
                  return (
                    <li key={`${l.label}-${i}`}>
                      {l.href ? (
                        <Link href={link(l.href)} className="group flex items-start justify-between gap-4 px-5 py-2.5 transition-colors hover:bg-sunken">
                          {body}
                        </Link>
                      ) : (
                        <div className="flex items-start justify-between gap-4 px-5 py-2.5">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {a.more ? (
            <div className="border-t border-line px-5 py-2.5 text-sm text-muted">
              And {a.more.count} more.{" "}
              <Link href={link(a.more.href)} className="link">
                {a.more.label} →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
      {a.notes.length || a.seeAlso ? (
        <footer className="border-t border-line bg-sunken/40 px-5 py-3 text-xs leading-relaxed text-muted">
          {a.notes.length ? (
            <ul className="space-y-1">
              {a.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {a.seeAlso ? (
            <Link href={link(a.seeAlso.href)} className="link mt-2 inline-block font-medium">
              {a.seeAlso.label} →
            </Link>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
