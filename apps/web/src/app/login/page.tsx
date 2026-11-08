import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

const DEMO_ACCOUNTS = [
  ["sana@ravicodeworks.example", "Owner, Ravi Code Works"],
  ["hamza@ravicodeworks.example", "Finance, Ravi Code Works"],
  ["qureshi@qureshi-associates.example", "Accountant, both workspaces"],
  ["ayesha@ayeshabuilds.example", "Freelancer"],
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; email?: string }> }) {
  const q = await searchParams;
  const next = q.next?.startsWith("/invite/") ? q.next : undefined;
  const session = await getSession();
  if (session && !(session.user as { isAnonymous?: boolean | null }).isAnonymous) redirect(next ?? "/workspaces");
  return (
    <AuthShell
      title="Sign in"
      sub={
        <>
          New to Aerion?{" "}
          <Link href={next ? `/signup?${new URLSearchParams({ next, ...(q.email ? { email: q.email } : {}) })}` : "/signup"} className="link font-medium">
            Create an account
          </Link>{" "}
          or{" "}
          <Link href="/" className="link font-medium">
            try the demo
          </Link>
          .
        </>
      }
      below={
        <details className="rounded-[10px] border border-line bg-panel text-sm">
          <summary className="cursor-pointer list-none px-4 py-3 font-medium text-ink [&::-webkit-details-marker]:hidden">Shared demo accounts ▾</summary>
          <div className="border-t border-line px-4 py-3">
            <p className="text-muted">These share one copy of the fictional demo data. For a private copy, use &ldquo;Try the demo&rdquo; on the home page.</p>
            <ul className="mt-2 space-y-1.5">
              {DEMO_ACCOUNTS.map(([email, role]) => (
                <li key={email} className="flex flex-wrap justify-between gap-x-3">
                  <code className="text-xs text-ink">{email}</code>
                  <span className="ml-auto text-right text-xs text-muted">{role}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      }
    >
      <LoginForm next={next} email={q.email} />
    </AuthShell>
  );
}
