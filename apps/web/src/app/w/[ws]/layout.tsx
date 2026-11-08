import { client, document, draftAction, flag, getDb, receivingAccount, task, transaction } from "@ebo/db";
import { syncNotifications } from "@ebo/engine";
import { and, count, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/brand";
import { MobileNavWithLabel, WorkspaceNav, type NavGroup } from "@/components/nav";
import { Bell, SearchBox } from "@/components/shell";
import { SubmitButton } from "@/components/submit-button";
import { clock, ROLE_LABEL } from "@/lib/format";
import { canAct, myWorkspaces, requireWorkspace } from "@/lib/session";
import { signOut } from "../../actions";
import { nextHour, nextWeek, resetDemo, runNow } from "./actions";

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { user, ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const [drafts, tasks, review, unmatched, flags, scheduled, mine, accounts, clients, esfcas] = await Promise.all([
    db.select({ n: count() }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["draft", "blocked"]))).then(n),
    db.select({ n: count() }).from(task).where(and(eq(task.workspaceId, ws.id), eq(task.status, "open"))).then(n),
    db.select({ n: count() }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))).then(n),
    db.select({ n: count() }).from(transaction).where(and(eq(transaction.workspaceId, ws.id), eq(transaction.matchStatus, "unmatched"))).then(n),
    db.select({ n: count() }).from(flag).where(and(eq(flag.workspaceId, ws.id), inArray(flag.status, ["open", "actioned"]))).then(n),
    db.select({ n: count() }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.status, "scheduled"))).then(n),
    myWorkspaces(user.id),
    db.select({ n: count() }).from(receivingAccount).where(and(eq(receivingAccount.workspaceId, ws.id), eq(receivingAccount.active, true))).then(n),
    db.select({ n: count() }).from(client).where(eq(client.workspaceId, ws.id)).then(n),
    db.select({ n: count() }).from(receivingAccount).where(and(eq(receivingAccount.workspaceId, ws.id), eq(receivingAccount.kind, "esfca"), eq(receivingAccount.active, true))).then(n),
  ]);
  // A failure here shouldn't take the page down: the count is only a pointer.
  const unread = await syncNotifications(db, ws, user.id, role).then(
    (r) => r.unread,
    (err) => {
      console.error("[notifications]", err instanceof Error ? err.message : "failed");
      return 0;
    },
  );
  const base = `/w/${slug}`;
  const setupLeft = !ws.isDemo ? Number(!accounts) + Number(!clients) : 0;
  // Grouped the way the work is done: what needs you, getting paid, staying compliant, the automation, the workspace.
  // Notifications live on the bell beside the logo, not in this list.
  const groups: NavGroup[] = [
    {
      items: [
        { href: `${base}/inbox`, label: "Today", count: drafts + tasks + review + unmatched, urgent: true },
        { href: `${base}/dashboard`, label: "Insights" },
        { href: `${base}/ask`, label: "Ask your books" },
      ],
    },
    {
      label: "Receivables",
      items: [
        { href: `${base}/invoices`, label: "Invoices" },
        { href: `${base}/payments`, label: "Payments", count: unmatched },
        { href: `${base}/clients`, label: "Clients" },
        ...(esfcas ? [{ href: `${base}/accounts/esfca`, label: "ESFCA" }] : []),
      ],
    },
    {
      label: "Compliance",
      items: [
        { href: `${base}/flags`, label: "Flags", count: flags },
        { href: `${base}/documents`, label: "Documents", count: review },
        // Month-end close is for offices; a freelancer can still open it from the address.
        ...(ws.kind === "freelancer" ? [] : [{ href: `${base}/close`, label: "Month-end close" }]),
        { href: `${base}/export`, label: "Tax year" },
      ],
    },
    {
      label: "Automation",
      items: [
        { href: `${base}/runs`, label: "Runs" },
        { href: `${base}/rules`, label: "Rules" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { href: `${base}/setup`, label: "Setup", count: setupLeft, urgent: setupLeft > 0 },
        { href: `${base}/settings`, label: "Settings" },
        { href: `${base}/audit`, label: "Audit log" },
      ],
    },
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

  const workspaceCard = (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 hover:border-line-strong [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-ink">{ws.name}</span>
          <span className="block truncate text-xs text-muted">
            {ws.kind === "company" ? "Software house" : "Freelancer"} · {ROLE_LABEL[role]}
          </span>
        </span>
        <span aria-hidden className="text-xs text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="absolute inset-x-0 z-30 mt-1 rounded-lg border border-line bg-panel p-1.5 text-sm shadow-lg">
        <div className="truncate px-2 py-1.5 text-xs text-muted">Signed in as {user.isAnonymous ? "a visitor" : user.name}</div>
        {others.map((w) => (
          <Link key={w.slug} href={`/w/${w.slug}/inbox`} className="block truncate rounded px-2 py-1.5 hover:bg-sunken">
            Switch to {w.name}
          </Link>
        ))}
        {user.isAnonymous ? (
          <Link href="/signup" className="block rounded px-2 py-1.5 hover:bg-sunken">
            Create an account
          </Link>
        ) : (
          <>
            <Link href="/account" className="block rounded px-2 py-1.5 hover:bg-sunken">
              Your account and sign-in
            </Link>
            <Link href="/workspaces/new" className="block rounded px-2 py-1.5 hover:bg-sunken">
              New workspace
            </Link>
          </>
        )}
        <form action={signOut} className="mt-1 border-t border-line pt-1">
          <button className="w-full rounded px-2 py-1.5 text-left hover:bg-sunken">Sign out</button>
        </form>
      </div>
    </details>
  );

  return (
    <div className="min-h-dvh">
      {ws.isDemo ? (
        <div className="border-b border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-900 dark:bg-violet-950/70 dark:text-violet-100">
          <div className="mx-auto flex max-w-[88rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm sm:px-6">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="rounded-[5px] bg-violet-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white dark:bg-violet-500">Demo</span>
              <span>
                Simulated clock <b className="tabular-nums">{clock(ws.demoClock, ws.timezone)}</b> PKT
              </span>
              <span className="text-xs opacity-75">{ws.expiresAt ? `Your private copy, deleted after ${clock(ws.expiresAt, ws.timezone)}` : "Fictional data, shared demo"}</span>
            </span>
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
                  <SubmitButton variant="secondary" pendingText="Resetting…" confirm="Reset this demo workspace to its starting point? Everything done in it so far is undone.">
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

      <div className="mx-auto grid max-w-[88rem] grid-cols-1 gap-x-8 gap-y-4 px-4 py-4 sm:px-6 lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:py-6">
        <aside className="scroll-quiet min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pb-3 lg:pr-1">
          <div className="mb-4 flex items-center justify-between gap-3 lg:mb-5 lg:px-1">
            <Logo href={`${base}/inbox`} size="sm" />
            <Bell href={`${base}/notifications`} unread={unread} />
          </div>
          <div className="hidden lg:mb-3 lg:block">{workspaceCard}</div>
          <div className="mb-3 lg:mb-5">
            <Suspense fallback={<div className="h-9 rounded-md border border-line-strong bg-panel" />}>
              <SearchBox base={base} />
            </Suspense>
          </div>
          <WorkspaceNav groups={groups} />
          <MobileNavWithLabel groups={groups} header={workspaceCard} fallback="Menu" />
        </aside>
        <main className="min-w-0 pb-16">
          {hint ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
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
