import type { ReactNode } from "react";

/**
 * The app's icons: one stroke weight on a 24px grid, drawn here so they need no package.
 * Decorative by default (aria-hidden); the text beside each one says what it is.
 */
const P = {
  home: <path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.25v-6h-5.5v6H5A1.5 1.5 0 0 1 3.5 19z" />,
  chart: <path d="M4 20h16M7 16.5v-5M12 16.5V7M17 16.5V10" />,
  sparkle: <path d="M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3zM18.5 15.5l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75z" />,
  invoice: <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5M9 12.5h6M9 16h4" />,
  card: <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h14A1.5 1.5 0 0 1 20.5 7v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17zM3.5 10h17M7 14.5h4" />,
  users: <path d="M15.5 19.5v-1.2a3.8 3.8 0 0 0-3.8-3.8H6.3a3.8 3.8 0 0 0-3.8 3.8v1.2M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM21.5 19.5v-1.2a3.8 3.8 0 0 0-2.9-3.7M15.6 4.8a3.2 3.2 0 0 1 0 6" />,
  bank: <path d="M3.5 9 12 4.5 20.5 9M4.5 9h15M6 9v8M10 9v8M14 9v8M18 9v8M3.5 20h17" />,
  shield: <path d="M12 3.5 5 6.3v5.2c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.3zM9 12l2.2 2.2L15.2 10" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  calendar: <path d="M4.5 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM4.5 10h15M8.5 3.5v3M15.5 3.5v3" />,
  calendarCheck: <path d="M4.5 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM4.5 10h15M8.5 3.5v3M15.5 3.5v3M9.3 15l1.9 1.9 3.6-3.6" />,
  briefcase: <path d="M4 8.5h16v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM9 8.5V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5v2M4 13h16" />,
  run: <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM10.2 8.8v6.4l5.3-3.2z" />,
  sliders: (
    <>
      <path d="M4 7h8.5M16.5 7H20M4 17h3.5M11.5 17H20" />
      <circle cx="14.5" cy="7" r="2" />
      <circle cx="9.5" cy="17" r="2" />
    </>
  ),
  checklist: <path d="M10 6.5h10M10 12h10M10 17.5h10M4 6.5l1.2 1.2L7.5 5.4M4 12l1.2 1.2 2.3-2.3M4 17.5l1.2 1.2 2.3-2.3" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M3 12h2.2M18.8 12H21M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
    </>
  ),
  history: <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.5 4v4h4M12 8v4.2l2.8 1.8" />,
  bell: <path d="M6.2 9a5.8 5.8 0 0 1 11.6 0c0 6.2 2.7 8 2.7 8h-17s2.7-1.8 2.7-8zM10.2 20.2a2 2 0 0 0 3.6 0" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v1.8M12 19.4v1.8M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M2.8 12h1.8M19.4 12h1.8M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3" />
    </>
  ),
  moon: <path d="M20.2 13.3A8.3 8.3 0 1 1 10.7 3.8a6.5 6.5 0 0 0 9.5 9.5z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  arrowRight: <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />,
  arrowUp: <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />,
  arrowDown: <path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5" />,
  mail: <path d="M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.3 2.4 2.4 4.6-4.9" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5M12 16.2v.1" />
    </>
  ),
  warning: <path d="M12 4.2 2.8 19.8h18.4zM12 10v4.2M12 17v.1" />,
  upload: <path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14" />,
  trend: <path d="m3.5 16.5 5.5-5.5 4 4 7.5-7.5M15 7.5h5.5V13" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bolt: <path d="M13.2 3 5 13.5h6.2L10.5 21l8.5-10.5h-6.3z" />,
  pie: <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5v9.7zM14 3.3a8.2 8.2 0 0 1 6.7 6.7H14z" />,
  doc: <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  logout: <path d="M9.5 20.5h-4a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h4M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />,
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5M12 3.5C9.6 5.9 8.5 8.8 8.5 12s1.1 6.1 3.5 8.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  user: <path d="M18.5 20v-1.3a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20M12 11.5a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof P;

export function Icon({ name, className, strokeWidth = 1.7, title }: { name: IconName; className?: string; strokeWidth?: number; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {P[name]}
    </svg>
  );
}
