import Link from "next/link";
import type { ReactNode } from "react";
import { Logo, Mark } from "@/components/brand";
import { SubmitButton } from "@/components/submit-button";
import { getSession } from "@/lib/session";
import { startDemo } from "./actions";

export const metadata = { title: { absolute: "Aerion · The finance back office for Pakistan's IT exporters" } };

const WEEK = [
  ["Plan", "Looks at what has arrived and what is still open, and writes down why it does each step."],
  ["Collect", "Bank credit advices and client emails from your mailbox; statements, Payoneer and marketplace exports you upload; pasted bank SMS."],
  ["Read", "Classifies each document and reads its fields. Every value quotes the line it came from; anything unsure goes to a person."],
  ["Match", "Ties each payment to its invoice by reference, payer and amount, and explains bank fees and exchange-rate differences."],
  ["Check", "Re-checks every rule: short payments, purpose codes, missing certificates, unconfirmed claims, lookalike domains."],
  ["Draft", "Writes the follow-ups from templates: to clients, to the bank, and tasks for your team. Code fills in every number."],
  ["Approve", "You read, edit and approve each email. Or choose autopilot for routine ones, with a window to cancel."],
  ["Follow up", "Next week's run sees what the replies fixed, closes those flags, and chases what is still open."],
] as const;

const CATCHES = [
  ["Short payments", "USD 6,750 against a USD 7,500 invoice, with the breakdown ready to send."],
  ["Wrong purpose codes", "A payment coded as home remittance, caught before the bank issues the ePRC."],
  ["Missing paperwork", "Every credit's ePRC and withholding certificate, requested in one email per bank."],
  ["“We paid” with no money", "A client's claim with no matching credit after the wait, answered with a request for the MT103."],
  ["Payment-detail fraud", "A lookalike domain asking to change your bank details, flagged; nothing in the books changes."],
  ["Overdue invoices", "Reminders on a schedule, and an easier route offered when a client is stuck."],
] as const;

const TRUST = [
  ["It never moves money", "Aerion reads, matches, records and reminds. Payments, refunds and conversions stay with your bank and your wallets."],
  ["Code decides, models read", "A language model may read a document, never decide. Matching, totals, flags and the banking-channel share are plain code on your records."],
  ["Every number checked twice", "Each amount, date and invoice number in an email is traced to the records when it is drafted, and again just before it is sent."],
  ["A person approves", "Supervised by default: nothing reaches a client or a bank without approval. Every action, by people or by Aerion, is in the audit log."],
  ["Your data stays yours", "Two-factor sign-in, roles for owners, finance, accountants and viewers, nightly encrypted backups, and a full export or deletion whenever you ask."],
  ["Honest about its rules", "Purpose codes, wait times and tax rates live in a rules library with sources. Until an adviser confirms them, they are marked unverified."],
] as const;

export default async function Landing() {
  const session = await getSession();
  const signedIn = !!session;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur supports-[backdrop-filter]:bg-canvas/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo href="/" />
          <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
            <a href="#how" className="btn btn-ghost hidden md:inline-flex">
              How it works
            </a>
            <a href="#trust" className="btn btn-ghost hidden md:inline-flex">
              Security
            </a>
            <Link href={signedIn ? "/workspaces" : "/login"} className="btn btn-ghost">
              {signedIn ? "Open Aerion" : "Sign in"}
            </Link>
            {!signedIn ? (
              <Link href="/signup" className="btn btn-primary hidden sm:inline-flex">
                Create an account
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center">
          <div>
            <p className="eyebrow text-accent">For Pakistani software houses and IT freelancers</p>
            <h1 className="mt-4 font-display text-[40px] font-semibold leading-[1.08] tracking-[-0.015em] text-ink sm:text-5xl">Every export payment matched, explained and on file.</h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">
              PayPal and Stripe don&rsquo;t pay out to Pakistan, so every SWIFT wire, Payoneer and Wise payment brings paperwork that decides how your income is taxed. Aerion does that work each week: it reads your bank
              advices and client emails, matches money to invoices, keeps your ePRCs and certificates on file, and drafts the follow-ups for you to approve.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <form action={startDemo}>
                <SubmitButton pendingText="Setting up your copy…" className="h-11 px-5 text-[15px]">
                  Try the demo
                </SubmitButton>
              </form>
              <Link href={signedIn ? "/workspaces" : "/signup"} className="btn btn-secondary h-11 px-5 text-[15px]">
                {signedIn ? "Go to your workspaces" : "Set up your business"}
              </Link>
            </div>
            <p className="mt-4 max-w-lg text-xs leading-relaxed text-muted">The demo is a private copy of two fictional workspaces, a 22-person software house and a freelancer, deleted after 7 days. Every name, number and document in it is simulated.</p>
          </div>

          <Ledger />
        </section>

        <section className="border-y border-line bg-panel">
          <div className="mx-auto grid max-w-6xl gap-px bg-line sm:grid-cols-3">
            {[
              ["The routes that work", "SWIFT to a PKR account or an ESFCA, Payoneer, Wise and marketplaces. Aerion suggests the cheapest one that works for each client."],
              ["The paperwork that counts", "The purpose code on each remittance, its ePRC and withholding certificate, and the share of income that came through banks."],
              ["The time it takes", "Today someone checks all of it by hand, across bank emails, exports and spreadsheets, every week and again at year end."],
            ].map(([t, d]) => (
              <div key={t} className="bg-panel px-4 py-8 sm:px-6">
                <h2 className="text-sm font-semibold text-ink">{t}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
          <SectionHead eyebrow="How a week runs" title="Every Monday at 09:00, and whenever new mail arrives">
            One run takes your workspace from what came in to what needs a person. You see every step it took, and why.
          </SectionHead>
          <ol className="mt-10 grid gap-x-10 gap-y-0 md:grid-cols-2">
            {WEEK.map(([name, text], i) => (
              <li key={name} className="flex gap-4 border-t border-line py-5">
                <span className="w-7 shrink-0 font-display text-lg font-semibold tabular-nums text-brass">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-semibold text-ink">{name}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="bg-[#121a16] text-[#e9e6dc]">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="eyebrow text-[#c99a5b]">What it catches</p>
            <h2 className="mt-3 max-w-2xl font-display text-[32px] font-semibold leading-tight">The problems that cost money when nobody notices them in time.</h2>
            <ul className="mt-10 grid gap-px overflow-hidden rounded-[10px] bg-[#26302b] sm:grid-cols-2 lg:grid-cols-3">
              {CATCHES.map(([t, d]) => (
                <li key={t} className="bg-[#151d19] p-6">
                  <h3 className="font-semibold text-[#f4f1e8]">{t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#a8b0aa]">{d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="trust" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
          <SectionHead eyebrow="Why a business can trust it" title="Automation that knows where its authority ends">
            Aerion does the repetitive work. The decisions that matter stay with you, and everything it does is on the record.
          </SectionHead>
          <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {TRUST.map(([t, d]) => (
              <li key={t} className="border-l-2 border-accent/50 pl-4">
                <h3 className="font-semibold text-ink">{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t border-line bg-panel">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 md:grid-cols-2">
            <Audience title="For software houses" points={["Roles for the director, finance staff, your accountant and viewers", "Month-end close with a checklist and a report for the director", "ESFCA balances, conversions and the retention rule", "Two-factor sign-in required for anyone who approves"]}>
              Finance staff prepare, the director approves, the accountant gets the year-end pack.
            </Audience>
            <Audience title="For freelancers" points={["Retainer invoices drafted on your billing day", "Purpose-code checks on Wise, Payoneer and SWIFT credits", "What PSEB registration would save, estimated", "One zip for your accountant at year end"]}>
              Your clients, invoices and payment paperwork in one place, with one click to approve.
            </Audience>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-8 rounded-[14px] border border-line bg-panel p-8 sm:p-10 md:flex-row md:items-center">
            <div className="max-w-xl">
              <h2 className="font-display text-[28px] font-semibold leading-tight text-ink">See a week of it in two minutes.</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">Run the workflow on a fictional software house: ten new bank documents and emails, four problems worth catching, six emails to approve.</p>
            </div>
            <form action={startDemo}>
              <SubmitButton pendingText="Setting up your copy…" className="h-11 px-5 text-[15px]">
                Try the demo
              </SubmitButton>
            </form>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted sm:px-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-md">
            <Logo size="sm" />
            <p className="mt-3 text-xs leading-relaxed">
              Named after the Aerarium, the public treasury of ancient Rome. Hosted on Vultr in Singapore: Cloud Compute, Managed PostgreSQL and Object Storage. When AI reading is on, Vultr Serverless Inference reads documents in Vultr&rsquo;s US data centres.
            </p>
          </div>
          <div className="max-w-sm text-xs leading-relaxed">
            <p>
              Aerion is in an early pilot. It is not tax advice: rules such as purpose codes, wait times and tax rates are marked unverified until an adviser confirms them. It never holds or moves money.
            </p>
            <p className="mt-3 flex gap-4">
              <Link href="/login" className="link">
                Sign in
              </Link>
              <Link href="/signup" className="link">
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <p className="eyebrow text-accent">{eyebrow}</p>
      <h2 className="mt-3 font-display text-[32px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h2>
      <p className="mt-3 leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Audience({ title, points, children }: { title: string; points: string[]; children: ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
      <ul className="mt-5 space-y-2.5 text-sm text-ink">
        {points.map((p) => (
          <li key={p} className="flex gap-3">
            <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rotate-45 bg-brass" />
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A ledger slip of the demo's first Monday run: the figures are the demo's own, marked simulated. */
function Ledger() {
  const rows: Array<[string, string, "bad" | null]> = [
    ["Payments matched and explained", "7", null],
    ["Transfers between own accounts", "2", null],
    ["Short payment caught", "USD 750", "bad"],
    ["Purpose code to correct", "1", "bad"],
    ["Payment claimed, not received", "1", "bad"],
    ["Lookalike-domain email flagged", "1", "bad"],
    ["Certificates to request", "2", null],
  ];
  return (
    <figure className="relative rounded-[14px] border border-line bg-panel p-6 shadow-[0_1px_0_var(--line),0_24px_48px_-24px_rgb(23_32_28/0.25)] sm:p-8">
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="eyebrow">Monday run</div>
          <div className="mt-1 font-display text-xl font-semibold text-ink">2 November 2026, 09:00</div>
          <div className="mt-0.5 text-xs text-muted">Ravi Code Works (Pvt) Ltd · simulated</div>
        </div>
        <Mark className="size-8 text-brass" />
      </div>
      <dl className="divide-y divide-dashed divide-line">
        {rows.map(([k, v, tone]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className={`font-medium tabular-nums ${tone === "bad" ? "text-rose-700 dark:text-rose-400" : "text-ink"}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex items-center justify-between gap-4 border-t-2 border-double border-line-strong pt-3 text-sm">
        <span className="font-medium text-ink">Emails drafted for approval</span>
        <span className="font-semibold tabular-nums text-ink">6</span>
      </div>
      <figcaption className="mt-5 flex items-center gap-2 text-xs text-muted">
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">✓ 23 numbers checked</span>
        Every amount and date in the six emails traced to the records.
      </figcaption>
    </figure>
  );
}
