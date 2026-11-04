import { getDb } from "@ebo/db";
import { findInvitation } from "@ebo/engine";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { ROLE_LABEL } from "@/lib/format";
import { getSession } from "@/lib/session";
import { acceptInvite, signOut } from "../../actions";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const q = await searchParams;
  const [inv, session] = await Promise.all([findInvitation(getDb(), token), getSession()]);
  const me = session && !(session.user as { isAnonymous?: boolean | null }).isAnonymous ? session.user : null;
  const here = `/invite/${token}`;
  const auth = (path: string) => `${path}?${new URLSearchParams({ next: here, ...(inv ? { email: inv.email } : {}) })}`;

  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center px-4 py-10">
      <Link href="/" className="mb-6 text-sm text-muted hover:text-ink">
        ← IT Export Back Office
      </Link>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        {!inv ? (
          <>
            <h1 className="text-lg font-semibold">This link doesn&apos;t work</h1>
            <p className="mt-2 text-sm text-muted">The invitation may have been replaced or withdrawn. Ask the person who invited you for a new link.</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Join {inv.workspaceName}</h1>
            <p className="mt-2 text-sm text-muted">
              {inv.invitedByName ?? "An owner"} invited <b className="text-ink">{inv.email}</b> to join as <b className="text-ink">{ROLE_LABEL[inv.role]}</b>.
            </p>
            {q.error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-100">{q.error.slice(0, 200)}</p> : null}
            {inv.problem ? (
              <p className="mt-4 text-sm text-ink">{inv.problem}</p>
            ) : !me ? (
              <div className="mt-5 space-y-2">
                <Link href={auth("/signup")} className="btn btn-primary w-full">
                  Create an account with {inv.email}
                </Link>
                <Link href={auth("/login")} className="btn btn-secondary w-full">
                  I have an account: sign in
                </Link>
              </div>
            ) : me.email.toLowerCase() !== inv.email ? (
              <div className="mt-4 space-y-3 text-sm">
                <p>
                  You&apos;re signed in as <b>{me.email}</b>. Sign out, then open this link again and sign in with {inv.email}.
                </p>
                <form action={signOut}>
                  <SubmitButton variant="secondary">Sign out</SubmitButton>
                </form>
              </div>
            ) : (
              <form action={acceptInvite.bind(null, token)} className="mt-5">
                <SubmitButton pendingText="Joining…" className="w-full">
                  Join {inv.workspaceName}
                </SubmitButton>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
