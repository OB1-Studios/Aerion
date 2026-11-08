import Link from "next/link";
import type { ReactNode } from "react";
import { Logo, Mark } from "./brand";

const PROMISES = [
  ["Never moves money", "Aerion records, matches and reminds. Payments stay with your bank and wallets."],
  ["Every number checked", "Amounts, dates and invoice numbers in every email are traced to your records twice."],
  ["You approve what goes out", "Nothing reaches a client or a bank without a person's say, unless you choose otherwise."],
] as const;

/**
 * The frame for signing in, signing up and joining: the Aerion panel on wide screens, the form
 * on its own card. The panel is always dark, so the brass mark reads the same in both themes.
 */
export function AuthShell({ title, sub, children, below, wide }: { title: string; sub?: ReactNode; children: ReactNode; below?: ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-[#121a16] px-10 py-12 text-[#e9e6dc] lg:flex lg:flex-col">
        <Link href="/" className="inline-flex items-center gap-3 self-start rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c99a5b]">
          <span className="grid size-9 place-items-center rounded-md bg-[#c99a5b]/12 text-[#c99a5b] ring-1 ring-[#c99a5b]/30">
            <Mark className="size-5" />
          </span>
          <span className="font-display text-xl font-semibold tracking-[0.01em]">Aerion</span>
        </Link>
        <div className="mt-auto max-w-sm">
          <p className="font-display text-[28px] font-semibold leading-tight">The treasury desk for Pakistan&rsquo;s IT exporters.</p>
          <ul className="mt-8 space-y-5">
            {PROMISES.map(([t, d]) => (
              <li key={t} className="border-l border-[#c99a5b]/40 pl-4">
                <div className="text-sm font-semibold text-[#f4f1e8]">{t}</div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#a8b0aa]">{d}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-12 text-xs text-[#7d877f]">Named after the Aerarium, the public treasury of ancient Rome.</p>
      </aside>
      <div className="flex min-w-0 flex-col px-4 py-8 sm:px-8">
        <div className="lg:hidden">
          <Logo href="/" />
        </div>
        <div className={`mx-auto my-auto w-full ${wide ? "max-w-xl" : "max-w-md"} py-10`}>
          <h1 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
          {sub ? <div className="mt-2 text-sm leading-relaxed text-muted">{sub}</div> : null}
          <div className="mt-6">{children}</div>
          {below ? <div className="mt-6">{below}</div> : null}
        </div>
      </div>
    </main>
  );
}
