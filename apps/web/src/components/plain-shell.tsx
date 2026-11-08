import type { ReactNode } from "react";
import { Logo } from "./brand";

/** Pages outside a workspace (your workspaces, your account): the logo, a few actions, the page. */
export function PlainShell({ children, actions, width = "max-w-3xl" }: { children: ReactNode; actions?: ReactNode; width?: string }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-panel/60">
        <div className={`mx-auto flex ${width} flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6`}>
          <Logo href="/workspaces" size="sm" />
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main className={`mx-auto ${width} px-4 py-8 sm:px-6 sm:py-10`}>{children}</main>
    </div>
  );
}
