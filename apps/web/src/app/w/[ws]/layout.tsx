import { client, document, draftAction, flag, getDb, receivingAccount, task, transaction } from "@ebo/db";
import { syncNotifications } from "@ebo/engine";
import { and, count, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Curves, Logo, LogoStacked } from "@/components/brand";
import { Icon } from "@/components/icons";
import { MobileNav, WorkspaceNav, type NavGroup } from "@/components/nav";
import { Bell, SearchBox, ThemeToggle } from "@/components/shell";
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
  // Grouped by the work (the brief's information architecture, on the routes that exist): today,
  // money in and out, records, oversight, the automation, administration. Notifications live on the bell.
  const groups: NavGroup[] = [
    {
      items: [
        { href: `${base}/inbox`, label: "Dashboard", icon: "home", count: drafts + tasks + review + unmatched, urgent: true },
        { href: `${base}/dashboard`, label: "Financial overview", icon: "chart" },
      ],
    },
    {
      label: "Money in and out",
      items: [
        { href: `${base}/invoices`, label: "Invoices & receivables", icon: "invoice" },
        { href: `${base}/payments`, label: "Payments & matching", icon: "card", count: unmatched },
        ...(esfcas ? [{ href: `${base}/accounts/esfca`, label: "ESFCA account", icon: "bank" as const }] : []),
      ],
    },
    {
      label: "Records",
      items: [
        { href: `${base}/documents`, label: "Documents", icon: "folder", count: review },
        { href: `${base}/clients`, label: "Clients", icon: "users" },
      ],
    },
    {
      label: "Oversight",
      items: [
        { href: `${base}/flags`, label: "Compliance flags", icon: "shield", count: flags },
        // Month-end close is for offices; a freelancer can still open it from the address.
        ...(ws.kind === "freelancer" ? [] : [{ href: `${base}/close`, label: "Month-end close", icon: "calendarCheck" as const }]),
        { href: `${base}/export`, label: "Tax-year file", icon: "briefcase" },
        { href: `${base}/audit`, label: "Audit history", icon: "history" },
      ],
    },
    {
      label: "Intelligence and automation",
      items: [
        { href: `${base}/ask`, label: "Ask your books", icon: "sparkle" },
        { href: `${base}/runs`, label: "Run history", icon: "run" },
        { href: `${base}/rules`, label: "Rules library", icon: "sliders" },
      ],
    },
    {
      label: "Administration",
      items: [
        { href: `${base}/setup`, label: "Setup", icon: "checklist", count: setupLeft, urgent: setupLeft > 0 },
        { href: `${base}/settings`, label: "Settings & users", icon: "gear" },
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
  const who = user.isAnonymous ? "Demo visitor" : user.name || user.email;
  const initials =
    who
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "A";

  // The workspace and the person, at the foot of the sidebar; the menu opens upwards.
  const footer = (
    <div className="space-y-2">
      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sidebar-ink hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-gold [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-[#5fd39a]" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{ws.name}</span>
              <span className="block truncate text-[11px] text-sidebar-muted">{ws.kind === "company" ? "Software house" : "Freelancer"}</span>
            </span>
          </span>
          <Icon name="chevronDown" className="size-4 shrink-0 text-sidebar-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="absolute inset-x-0 bottom-full z-50 mb-2 rounded-lg border border-line bg-panel p-1.5 text-sm text-ink shadow-pop">
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
      <div className="flex items-center gap-3 px-1">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-[#f4f1e8] text-sm font-bold text-[#1f4a3c]">
          {initials}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-sidebar-ink">{who}</span>
          <span className="block truncate text-xs text-sidebar-muted">{ROLE_LABEL[role]}</span>
        </span>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-[16.5rem]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[16.5rem] flex-col bg-[linear-gradient(180deg,var(--sidebar),var(--sidebar-deep))] lg:flex">
        <Curves className="h-56 opacity-[0.08]" />
        <div className="relative flex shrink-0 justify-center px-4 pb-4 pt-6">
          <LogoStacked href={`${base}/inbox`} />
        </div>
        {/* The links scroll on short screens; the workspace and the person stay at the foot. */}
        <div className="scroll-sidebar relative min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <WorkspaceNav groups={groups} />
        </div>
        <div className="relative shrink-0 border-t border-white/10 px-4 pb-4 pt-3">{footer}</div>
      </aside>

      <div className="sticky top-0 z-30 flex items-center gap-2 bg-sidebar px-2 py-2 shadow-[0_1px_0_rgb(0_0_0/0.15)] lg:hidden">
        <MobileNav groups={groups} header={<Logo href={`${base}/inbox`} tone="reversed" size="sm" />} footer={footer} />
        <div className="min-w-0 flex-1">
          <Logo href={`${base}/inbox`} tone="reversed" size="sm" />
        </div>
        <Bell href={`${base}/notifications`} unread={unread} onDark />
        <ThemeToggle onDark />
      </div>

      {ws.isDemo ? (
        <div className="border-b border-violet-line bg-violet-soft">
          <div className="mx-auto flex max-w-[92rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm text-ink sm:px-6 lg:px-10">
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="rounded-full bg-violet px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white dark:text-[#1a1430]">Demo</span>
              <span>
                Simulated clock <b className="font-semibold tabular-nums">{clock(ws.demoClock, ws.timezone)}</b> PKT
              </span>
              <span className="text-xs text-muted">{ws.expiresAt ? `Your private copy, deleted after ${clock(ws.expiresAt, ws.timezone)}` : "Fictional data, shared demo"}</span>
            </span>
            {acts ? (
              <div className="ml-auto flex flex-wrap gap-2">
                <form action={runNow.bind(null, slug)}>
                  <SubmitButton pendingText="Starting…" className="h-8 px-3">
                    Run now
                  </SubmitButton>
                </form>
                {scheduled ? (
                  <form action={nextHour.bind(null, slug)}>
                    <SubmitButton variant="secondary" pendingText="Moving clock…" className="h-8 px-3">
                      +1 hour
                    </SubmitButton>
                  </form>
                ) : null}
                <form action={nextWeek.bind(null, slug)}>
                  <SubmitButton variant="secondary" pendingText="Moving clock…" className="h-8 px-3">
                    Next Monday →
                  </SubmitButton>
                </form>
                <form action={resetDemo.bind(null, slug)}>
                  <SubmitButton variant="secondary" pendingText="Resetting…" className="h-8 px-3" confirm="Reset this demo workspace to its starting point? Everything done in it so far is undone.">
                    Reset
                  </SubmitButton>
                </form>
              </div>
            ) : (
              <span className="ml-auto text-xs text-muted">{ROLE_LABEL[role]}: view only</span>
            )}
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-[92rem] px-4 sm:px-6 lg:px-10">
        <div className="flex items-center justify-end gap-2 pb-1 pt-4 lg:pt-6">
          <div className="w-full sm:max-w-[26rem]">
            <Suspense fallback={<div className="h-11 rounded-full border border-line bg-panel" />}>
              <SearchBox base={base} />
            </Suspense>
          </div>
          <div className="hidden items-center gap-1.5 lg:flex">
            <Bell href={`${base}/notifications`} unread={unread} />
            <ThemeToggle />
          </div>
        </div>
        <main className="min-w-0 pb-16 pt-4">
          {hint ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-line bg-warning-soft px-4 py-3 text-sm text-ink">
              <span>{hint.text}</span>
              <Link href={hint.href} className="font-semibold text-accent underline">
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
