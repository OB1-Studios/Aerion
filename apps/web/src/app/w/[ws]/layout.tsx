import { client, document, draftAction, flag, getDb, receivingAccount, task, transaction } from "@ebo/db";
import { and, count, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { WorkspaceNav } from "@/components/nav";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui";
import { clock, ROLE_LABEL } from "@/lib/format";
import { canAct, myWorkspaces, requireWorkspace } from "@/lib/session";
import { signOut } from "../../actions";
import { nextHour, nextWeek, resetDemo, runNow } from "./actions";

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { user, ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const [drafts, tasks, review, unmatched, flags, scheduled, mine, accounts, clients] = await Promise.all([
    db.select({ n: count() }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["draft", "blocked"]))).then(n),
    db.select({ n: count() }).from(task).where(and(eq(task.workspaceId, ws.id), eq(task.status, "open"))).then(n),
    db.select({ n: count() }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))).then(n),
    db.select({ n: count() }).from(transaction).where(and(eq(transaction.workspaceId, ws.id), eq(transaction.matchStatus, "unmatched"))).then(n),
    db.select({ n: count() }).from(flag).where(and(eq(flag.workspaceId, ws.id), inArray(flag.status, ["open", "actioned"]))).then(n),
    db.select({ n: count() }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.status, "scheduled"))).then(n),
    myWorkspaces(user.id),
    db.select({ n: count() }).from(receivingAccount).where(and(eq(receivingAccount.workspaceId, ws.id), eq(receivingAccount.active, true))).then(n),
    db.select({ n: count() }).from(client).where(eq(client.workspaceId, ws.id)).then(n),
  ]);
  const base = `/w/${slug}`;
  const items = [
    { href: `${base}/inbox`, label: "Inbox", count: drafts + tasks + review + unmatched },
    { href: `${base}/dashboard`, label: "Dashboard" },
    { href: `${base}/runs`, label: "Runs" },
    { href: `${base}/flags`, label: "Flags", count: flags },
    { href: `${base}/payments`, label: "Payments" },
    { href: `${base}/invoices`, label: "Invoices" },
    { href: `${base}/clients`, label: "Clients" },
    { href: `${base}/documents`, label: "Documents" },
    { href: `${base}/export`, label: "Tax-year file" },
    { href: `${base}/rules`, label: "Rules" },
    { href: `${base}/setup`, label: "Setup", count: !ws.isDemo ? Number(!accounts) + Number(!clients) : 0 },
    { href: `${base}/settings`, label: "Settings" },
    { href: `${base}/audit`, label: "Audit log" },
  ];
  const acts = canAct(role);
  // Real workspaces start empty: point at the next thing to set up.
  const hint = ws.isDemo
    ? null
    : !accounts && role === "owner"
      ? { text: "Add the account clients pay into, so invoices can say how to pay.", href: `${base}/setup#accounts`, cta: "Finish setting up" }
      : !clients && acts
        ? { text: "Add your first client to start invoicing.", href: `${base}/clients/new`, cta: "Add a client" }
        : null;
  const others = mine.filter((w) => w.slug !== slug);

  return (
    <div className="min-h-dvh">
      {ws.isDemo ? (
        <div className="border-b border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-100">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Badge tone="violet">demo</Badge>
              <span>
                Simulated clock: <b className="tabular-nums">{clock(ws.demoClock, ws.timezone)}</b> PKT
              </span>
            </span>
            {ws.expiresAt ? <span className="text-xs opacity-75">Your private copy, deleted after {clock(ws.expiresAt, ws.timezone)}</span> : <span className="text-xs opacity-75">Fictional data, shared demo</span>}
            {acts ? (
              <div className="ml-auto flex flex-wrap gap-2">
                <form action={runNow.bind(null, slug)}>
                  <SubmitButton pendingText="Starting…">Run now</SubmitButton>
                </form>
                {scheduled ? (
                  <form action={nextHour.bind(null, slug)}>
                    <SubmitButton variant="secondary" pendingText="Moving clock…">
                      +1 hour
                    </SubmitButton>
                  </form>
                ) : null}
                <form action={nextWeek.bind(null, slug)}>
                  <SubmitButton variant="secondary" pendingText="Moving clock…">
                    Next Monday →
                  </SubmitButton>
                </form>
                <form action={resetDemo.bind(null, slug)}>
                  <SubmitButton variant="secondary" pendingText="Resetting…">
                    Reset
                  </SubmitButton>
                </form>
              </div>
            ) : (
              <span className="ml-auto text-xs opacity-75">{ROLE_LABEL[role]}: view only</span>
            )}
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-6">
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="flex items-center justify-between gap-2 lg:block">
            <Link href={`${base}/inbox`} className="block min-w-0">
              <div className="truncate font-semibold text-ink">{ws.name}</div>
              <div className="text-xs text-muted">
                {ws.kind === "company" ? "Software house" : "Freelancer"} · {ROLE_LABEL[role]}
              </div>
            </Link>
            <details className="relative lg:mt-3">
              <summary className="cursor-pointer list-none text-xs text-muted hover:text-ink">{user.isAnonymous ? "Visitor" : user.name} ▾</summary>
              <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-line bg-panel p-2 text-sm shadow-lg lg:left-0 lg:right-auto">
                {others.map((w) => (
                  <Link key={w.slug} href={`/w/${w.slug}/inbox`} className="block rounded px-2 py-1.5 hover:bg-canvas">
                    Switch to {w.name}
                  </Link>
                ))}
                {user.isAnonymous ? (
                  <Link href="/signup" className="block rounded px-2 py-1.5 hover:bg-canvas">
                    Create an account
                  </Link>
                ) : (
                  <Link href="/workspaces/new" className="block rounded px-2 py-1.5 hover:bg-canvas">
                    New workspace
                  </Link>
                )}
                <form action={signOut}>
                  <button className="w-full rounded px-2 py-1.5 text-left hover:bg-canvas">Sign out</button>
                </form>
              </div>
            </details>
          </div>
          <WorkspaceNav items={items} />
        </aside>
        <main className="min-w-0">
          {hint ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <span>{hint.text}</span>
              <Link href={hint.href} className="font-medium underline">
                {hint.cta}
              </Link>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
