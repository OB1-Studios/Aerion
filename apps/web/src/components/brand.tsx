/* eslint-disable @next/next/no-img-element -- small fixed-size brand files; plain <img> keeps them out of the image optimiser */
import Link from "next/link";
import { cx } from "./ui";

/**
 * Aerion's logo, as supplied (brand/source): the folded-ribbon A and the AERION wordmark. The files
 * in public/brand are cut from that artwork without redrawing it (brand/README.md); "reversed" is
 * the same artwork turned light for dark green, where the sidebar sits.
 */
const MARK = { w: 321, h: 236 };
const WORD = { w: 780, h: 128 };
const FULL = { w: 1143, h: 236 };

/** The A on its own. `tone="reversed"` for dark backgrounds. */
export function Mark({ className, tone = "auto" }: { className?: string; tone?: "auto" | "reversed" }) {
  if (tone === "reversed") return <img src="/brand/aerion-mark-reversed.png" alt="" width={MARK.w} height={MARK.h} className={cx("h-auto", className)} />;
  return (
    <>
      <img src="/brand/aerion-mark.png" alt="" width={MARK.w} height={MARK.h} className={cx("h-auto dark:hidden", className)} />
      <img src="/brand/aerion-mark-reversed.png" alt="" width={MARK.w} height={MARK.h} className={cx("hidden h-auto dark:block", className)} />
    </>
  );
}

function Wordmark({ className, tone }: { className?: string; tone: "auto" | "reversed" }) {
  if (tone === "reversed") return <img src="/brand/aerion-wordmark-white.png" alt="Aerion" width={WORD.w} height={WORD.h} className={cx("h-auto", className)} />;
  return (
    <>
      <img src="/brand/aerion-wordmark.png" alt="Aerion" width={WORD.w} height={WORD.h} className={cx("h-auto dark:hidden", className)} />
      <img src="/brand/aerion-wordmark-white.png" alt="" width={WORD.w} height={WORD.h} className={cx("hidden h-auto dark:block", className)} />
    </>
  );
}

const focus = "rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

/** Mark and wordmark side by side: headers on light pages. */
export function Logo({ href, size = "md", tone = "auto", className }: { href?: string; size?: "sm" | "md" | "lg"; tone?: "auto" | "reversed"; className?: string }) {
  const s = { sm: ["w-8", "w-[88px]"], md: ["w-10", "w-[108px]"], lg: ["w-14", "w-[150px]"] }[size];
  const body = (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <span className={cx("inline-block shrink-0", s[0])}>
        <Mark tone={tone} className="w-full" />
      </span>
      <span className={cx("inline-block shrink-0", s[1])}>
        <Wordmark tone={tone} className="w-full" />
      </span>
    </span>
  );
  return href ? (
    <Link href={href} className={cx("inline-flex", focus)}>
      {body}
    </Link>
  ) : (
    body
  );
}

/** The mark over the wordmark, light on dark green: the top of the sidebar. */
export function LogoStacked({ href }: { href: string }) {
  return (
    <Link href={href} className="flex flex-col items-center gap-2.5 rounded-md py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
      <Mark tone="reversed" className="w-[60px]" />
      <Wordmark tone="reversed" className="w-[112px]" />
    </Link>
  );
}

const FULL_ALT = "Aerion: Financial intelligence. Greater control.";

/** The whole lockup with the line under it, for the front page and sign-in. */
export function LogoFull({ className, tone = "auto" }: { className?: string; tone?: "auto" | "reversed" }) {
  if (tone === "reversed") return <img src="/brand/aerion-logo-reversed.png" alt={FULL_ALT} width={FULL.w} height={FULL.h} className={cx("h-auto", className)} />;
  return (
    <>
      <img src="/brand/aerion-logo.png" alt={FULL_ALT} width={FULL.w} height={FULL.h} className={cx("h-auto dark:hidden", className)} />
      <img src="/brand/aerion-logo-reversed.png" alt={FULL_ALT} width={FULL.w} height={FULL.h} className={cx("hidden h-auto dark:block", className)} />
    </>
  );
}

/** Faint flowing lines, like the mark's ribbon, at the foot of a dark green panel. Decorative. */
export function Curves({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 264 220" preserveAspectRatio="none" className={cx("pointer-events-none absolute inset-x-0 bottom-0 w-full text-white", className)} fill="none" stroke="currentColor" strokeWidth="1">
      {["M-10 120C60 80 130 150 280 70", "M-10 140C70 100 140 170 280 92", "M-10 160C80 120 150 190 280 114", "M-10 180C90 140 160 210 280 136"].map((d) => (
        <path key={d} d={d} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
