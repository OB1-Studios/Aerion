import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getSession } from "@/lib/session";
import { CodeForm } from "./code-form";

export const metadata = { title: "Sign-in code" };

/** The second step of signing in, for accounts with two-factor sign-in. The password step leads here. */
export default async function SignInCodePage({ searchParams }: { searchParams: Promise<{ next?: string; backup?: string }> }) {
  const q = await searchParams;
  const next = q.next?.startsWith("/invite/") ? q.next : undefined;
  const session = await getSession();
  if (session && !(session.user as { isAnonymous?: boolean | null }).isAnonymous) redirect(next ?? "/workspaces");
  // The auth library keeps the half-finished sign-in in this cookie for 10 minutes.
  const pending = (await cookies()).getAll().some((c) => c.name.endsWith("better-auth.two_factor"));
  const backup = q.backup === "1";
  const here = (useBackup: boolean) => {
    const p = new URLSearchParams({ ...(next ? { next } : {}), ...(useBackup ? { backup: "1" } : {}) }).toString();
    return `/login/code${p ? `?${p}` : ""}`;
  };

  return (
    <AuthShell title={backup ? "Use a backup code" : "Enter your sign-in code"} sub={pending ? (backup ? "One of the codes you kept when you set up two-factor sign-in. Each works once." : "Open your authenticator app and type the six-digit code for Aerion.") : undefined}>
      {pending ? (
        <>
          <CodeForm next={next} backup={backup} />
          <p className="mt-4 text-sm">
            <Link href={here(!backup)} className="link">
              {backup ? "Use the authenticator app instead" : "Lost your phone? Use a backup code"}
            </Link>
          </p>
        </>
      ) : (
        <p className="text-sm">
          This sign-in has expired, or it&apos;s already finished.{" "}
          <Link href={next ? `/login?${new URLSearchParams({ next })}` : "/login"} className="link">
            Sign in again
          </Link>
          .
        </p>
      )}
    </AuthShell>
  );
}
