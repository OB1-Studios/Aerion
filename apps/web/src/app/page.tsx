import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { getSession } from "@/lib/session";
import { startDemo } from "./actions";

const STEPS = [
  ["Plan", "Looks at what arrived and what is still open before doing anything."],
  ["Pull", "Brings in bank alerts, client emails, Payoneer and marketplace exports."],
  ["Read", "Classifies and extracts every document; each field is checked against the source text."],
  ["Reconcile", "Matches money to invoices by reference, payer and amount, and explains fees and FX."],
  ["Flag", "Short payments, wrong purpose codes, missing ePRCs, unpaid claims, impersonation."],
  ["Draft", "Writes the follow-up emails from templates; every number is verified against the records."],
  ["Send", "Supervised by default: a person approves each email. Autopilot is a setting."],
  ["Follow up", "Next week's run closes what the replies fixed and chases what they didn't."],
];

export default async function Landing() {
  const session = await getSession();
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <nav className="mb-12 flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">₨</span>
          IT Export Back Office
        </div>
        <div className="flex flex-wrap gap-2">
          {!session ? (
            <Link href="/signup" className="btn btn-secondary hidden sm:inline-flex">
              Create an account
            </Link>
          ) : null}
          <Link href={session ? "/workspaces" : "/login"} className="btn btn-secondary">
            {session ? "Open app" : "Sign in"}
          </Link>
        </div>
      </nav>

      <section className="grid gap-10 md:grid-cols-[1.2fr_1fr] md:items-center">
        <div>
          <p className="mb-3 text-sm font-medium text-accent">For Pakistani software houses and freelancers</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Every export payment matched, explained and on file, every Monday.</h1>
          <p className="mt-4 text-base text-muted">
            An agent that runs your finance back office end to end: it reads bank advices and client emails, matches money to invoices, tracks ePRCs and withholding certificates, catches short payments,
            wrong purpose codes and fake &ldquo;new bank details&rdquo; emails, and drafts the follow-ups. You approve; it does the rest. Deployed on Vultr.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <form action={startDemo}>
              <SubmitButton pendingText="Setting up your copy…">Try the demo</SubmitButton>
            </form>
            <Link href="/login" className="btn btn-secondary">
              Sign in with a demo account
            </Link>
          </div>
          <p className="mt-3 text-sm">
            Ready to use it for real?{" "}
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Create an account
            </Link>{" "}
            and set up your own workspace.
          </p>
          <p className="mt-3 text-xs text-muted">The demo gives you a private copy of two fictional workspaces (a 22-person software house and a freelancer) that expires in 7 days. All names, numbers and documents are simulated.</p>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Monday run, 2 Nov 2026</div>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex justify-between gap-3"><span>Payments matched and explained</span><b className="tabular-nums">7</b></li>
            <li className="flex justify-between gap-3"><span>Problems caught in new payments</span><b className="tabular-nums text-rose-600">3</b></li>
            <li className="flex justify-between gap-3"><span>Overdue invoice chased</span><b className="tabular-nums">1</b></li>
            <li className="flex justify-between gap-3"><span>Missing ePRC / certificate requests</span><b className="tabular-nums">2</b></li>
            <li className="flex justify-between gap-3"><span>Impersonation attempt caught</span><b className="tabular-nums text-rose-600">1</b></li>
            <li className="flex justify-between gap-3 border-t border-line pt-2"><span>Emails drafted, numbers verified</span><b className="tabular-nums">6</b></li>
          </ul>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-lg font-semibold">One workflow, from planning to output</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([name, text], i) => (
            <li key={name} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-xs font-medium text-muted">Step {i + 1}</div>
              <div className="mt-1 font-medium">{name}</div>
              <p className="mt-1 text-sm text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12 grid gap-3 sm:grid-cols-3">
        {[
          ["Numbers you can trust", "Models never write numbers. Templates hold placeholders; code fills and checks every amount and date against the evidence before anything is sent."],
          ["Emails are data, not orders", "Inbound email is classified into intents and never followed. A forged “our bank details changed” email raises a flag; nothing in the books changes."],
          ["Built on Vultr", "App and worker on a Vultr VM, Managed PostgreSQL with daily backups, Object Storage for documents, Serverless Inference for reading, provisioned through the Vultr API."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-xl border border-line bg-panel p-4">
            <div className="font-medium">{t}</div>
            <p className="mt-1 text-sm text-muted">{d}</p>
          </div>
        ))}
      </section>
      <footer className="mt-16 border-t border-line pt-6 text-xs text-muted">Hackathon build. Rules (purpose codes, tax rates, wait times) are marked unverified until checked. Not tax advice.</footer>
    </main>
  );
}
