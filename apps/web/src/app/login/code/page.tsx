import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
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
    <main className="mx-auto grid min-h-dvh max-w-md content-center px-4 py-10">
      <Link href="/" className="mb-6 text-sm text-muted hover:text-ink">
        ← IT Export Back Office
      </Link>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{backup ? "Use a backup code" : "Enter your sign-in code"}</h1>
        {pending ? (
          <>
            <p className="mt-1 text-sm text-muted">{backup ? "One of the codes you kept when you set up two-factor sign-in. Each works once." : "Open your authenticator app and type the six-digit code for IT Export Back Office."}</p>
            <CodeForm next={next} backup={backup} />
            <p className="mt-4 text-sm">
              <Link href={here(!backup)} className="link">
                {backup ? "Use the authenticator app instead" : "Lost your phone? Use a backup code"}
              </Link>
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm">
            This sign-in has expired, or it's already finished.{" "}
            <Link href={next ? `/login?${new URLSearchParams({ next })}` : "/login"} className="link">
              Sign in again
            </Link>
            .
          </p>
        )}
      </div>
    </main>
  );
}
