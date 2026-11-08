import { getDb } from "@ebo/db";
import { findInvitation } from "@ebo/engine";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
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
    <AuthShell
      title={!inv ? "This link doesn't work" : `Join ${inv.workspaceName}`}
      sub={
        !inv ? (
          "The invitation may have been replaced or withdrawn. Ask the person who invited you for a new link."
        ) : (
          <>
            {inv.invitedByName ?? "An owner"} invited <b className="text-ink">{inv.email}</b> to join as <b className="text-ink">{ROLE_LABEL[inv.role]}</b>.
          </>
        )
      }
    >
      {inv ? (
        <>
          {q.error ? <p className="mb-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-ink">{q.error.slice(0, 200)}</p> : null}
          {inv.problem ? (
            <p className="text-sm text-ink">{inv.problem}</p>
          ) : !me ? (
            <div className="space-y-2">
              <Link href={auth("/signup")} className="btn btn-primary w-full">
                Create an account with {inv.email}
              </Link>
              <Link href={auth("/login")} className="btn btn-secondary w-full">
                I have an account: sign in
              </Link>
            </div>
          ) : me.email.toLowerCase() !== inv.email ? (
            <div className="space-y-3 text-sm">
              <p>
                You&apos;re signed in as <b>{me.email}</b>. Sign out, then open this link again and sign in with {inv.email}.
              </p>
              <form action={signOut}>
                <SubmitButton variant="secondary">Sign out</SubmitButton>
              </form>
            </div>
          ) : (
            <form action={acceptInvite.bind(null, token)}>
              <SubmitButton pendingText="Joining…" className="w-full">
                Join {inv.workspaceName}
              </SubmitButton>
            </form>
          )}
        </>
      ) : (
        <Link href="/" className="btn btn-secondary">
          Go to the home page
        </Link>
      )}
    </AuthShell>
  );
}
