import Link from "next/link";
import { cx } from "./ui";

/**
 * Aerion's mark: the front of a treasury temple (pediment, three columns, base), after the
 * Aerarium, Rome's public treasury in the Temple of Saturn. One colour, drawn on a 24px grid.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 2.25 21.5 7.75v1.5h-19v-1.5z" />
      <rect x="4.25" y="10.75" width="2.75" height="8" rx="0.4" />
      <rect x="10.625" y="10.75" width="2.75" height="8" rx="0.4" />
      <rect x="17" y="10.75" width="2.75" height="8" rx="0.4" />
      <rect x="2.5" y="19.75" width="19" height="2" rx="0.4" />
    </svg>
  );
}

/** The mark on its plate, with the wordmark beside it. */
export function Logo({ href, size = "md", className }: { href?: string; size?: "sm" | "md"; className?: string }) {
  const body = (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <span className={cx("grid place-items-center rounded-md bg-ink text-brass", size === "sm" ? "size-7" : "size-8")}>
        <Mark className={size === "sm" ? "size-4" : "size-[18px]"} />
      </span>
      <span className={cx("font-display font-semibold tracking-[0.01em] text-ink", size === "sm" ? "text-[17px]" : "text-lg")}>Aerion</span>
    </span>
  );
  return href ? (
    <Link href={href} className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {body}
    </Link>
  ) : (
    body
  );
}
