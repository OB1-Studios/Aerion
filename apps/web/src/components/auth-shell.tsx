import Link from "next/link";
import type { ReactNode } from "react";
import { Curves, Logo, LogoFull } from "./brand";

const PROMISES = [
  ["Never moves money", "Aerion records, matches and reminds. Payments stay with your bank and wallets."],
  ["Every number checked", "Amounts, dates and invoice numbers in every email are traced to your records twice."],
  ["You approve what goes out", "Nothing reaches a client or a bank without a person's say, unless you choose otherwise."],
] as const;

/**
 * The frame for signing in, signing up and joining: the dark green Aerion panel on wide screens,
 * the form on its own. The panel stays dark green in both themes, so the logo is the reversed one.
 */
export function AuthShell({ title, sub, children, below, wide }: { title: string; sub?: ReactNode; children: ReactNode; below?: ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-[linear-gradient(165deg,var(--sidebar),var(--sidebar-deep))] px-10 py-12 text-sidebar-ink lg:flex lg:flex-col">
        <Curves className="h-72 opacity-[0.08]" />
        <Link href="/" className="relative self-start rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold">
          <LogoFull tone="reversed" className="w-[260px]" />
        </Link>
        <div className="relative mt-auto max-w-sm">
          <p className="font-display text-[30px] leading-tight text-white">The finance back office for Pakistan&rsquo;s IT exporters.</p>
          <ul className="mt-8 space-y-5">
            {PROMISES.map(([t, d]) => (
              <li key={t} className="border-l-2 border-gold/60 pl-4">
                <div className="text-sm font-semibold text-white">{t}</div>
                <p className="mt-0.5 text-sm leading-relaxed text-sidebar-muted">{d}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-sidebar-muted">Named after the Aerarium, the public treasury of ancient Rome.</p>
      </aside>
      <div className="flex min-w-0 flex-col px-4 py-6 sm:px-8 sm:py-8">
        <div className="lg:hidden">
          <Logo href="/" />
        </div>
        <div className={`mx-auto my-auto w-full ${wide ? "max-w-xl" : "max-w-md"} py-10`}>
          <h1 className="border-l-2 border-terracotta/80 pl-4 font-display text-[30px] leading-tight text-ink">{title}</h1>
          {sub ? <div className="mt-3 text-sm leading-relaxed text-muted">{sub}</div> : null}
          <div className="mt-6">{children}</div>
          {below ? <div className="mt-6">{below}</div> : null}
        </div>
      </div>
    </main>
  );
}
