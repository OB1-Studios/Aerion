import Link from "next/link";
import { Badge, Card, KeyValues, Notice } from "@/components/ui";
import { myWorkspaces, requireUser } from "@/lib/session";
import { twoFactorUnavailable, workspacesRequiringTwoFactor } from "@/lib/two-factor";
import { signOut } from "../actions";
import { renewBackupCodes, turnOffTwoFactor } from "./actions";
import { PasswordAction, TwoFactorSetup } from "./two-factor-forms";

export const metadata = { title: "Your account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ required?: string; done?: string }> }) {
  const q = await searchParams;
  const me = await requireUser();
  const [mine, required] = await Promise.all([myWorkspaces(me.id), workspacesRequiringTwoFactor(me.id)]);
  const on = !!me.twoFactorEnabled;
  const blocked = twoFactorUnavailable(me);
  const asked = q.required ? mine.find((w) => w.slug === q.required) : undefined;
  const back = asked && on ? { href: `/w/${asked.slug}/inbox`, text: `Back to ${asked.name}` } : { href: "/workspaces", text: "Your workspaces" };

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={back.href} className="text-sm text-muted hover:text-ink">
            ← {back.text}
          </Link>
          <h1 className="mt-1 text-lg font-semibold">Your account</h1>
        </div>
        <form action={signOut}>
          <button className="btn btn-secondary">Sign out</button>
        </form>
      </div>

      {asked && !on ? <Notice tone="amber">{asked.name} asks owners and finance to sign in with a code from an authenticator app as well as a password. Set it up below to carry on.</Notice> : null}
      {q.done === "on" && on ? (
        <Notice>
          Two-factor sign-in is on. From now on, signing in asks for a code from your authenticator app after your password.{" "}
          {asked ? (
            <Link href={`/w/${asked.slug}/inbox`} className="font-medium underline underline-offset-2">
              Back to {asked.name}
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {q.done === "off" && !on ? <Notice tone="amber">Two-factor sign-in is off. Signing in takes only your password.</Notice> : null}

      <Card title="Account">
        <KeyValues
          rows={[
            ["Name", me.isAnonymous ? "Visitor (demo)" : me.name],
            ["Email", me.isAnonymous ? "None: you're trying the demo" : me.email],
          ]}
        />
      </Card>

      <Card
        id="two-factor"
        title={
          <span className="flex items-center gap-2">
            Two-factor sign-in <Badge tone={on ? "green" : "gray"}>{on ? "On" : "Off"}</Badge>
          </span>
        }
      >
        {blocked ? (
          <div className="space-y-3 text-sm">
            <p>{blocked}</p>
            {me.isAnonymous ? (
              <Link href="/signup" className="btn btn-primary">
                Create an account
              </Link>
            ) : null}
          </div>
        ) : on ? (
          <div className="space-y-5">
            <p className="text-sm">Signing in asks for a six-digit code from your authenticator app after your password. Lost the phone? Sign in with one of your backup codes instead.</p>
            <section className="space-y-2 border-t border-line pt-4">
              <h2 className="font-medium text-ink">New backup codes</h2>
              <p className="text-sm text-muted">Used some, or lost the list? New codes replace all the old ones.</p>
              <PasswordAction action={renewBackupCodes} label="Make new backup codes" pendingText="Making…" title="No new codes:" />
            </section>
            <section className="space-y-2 border-t border-line pt-4">
              <h2 className="font-medium text-ink">Turn off</h2>
              {required.length ? (
                <p className="text-sm text-muted">
                  {required.join(", ")} require{required.length === 1 ? "s" : ""} it for owners and finance, so it stays on. An owner there can lift the requirement in Settings.
                </p>
              ) : (
                <PasswordAction action={turnOffTwoFactor} label="Turn off two-factor sign-in" pendingText="Turning off…" title="Still on:" variant="danger" />
              )}
            </section>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">After your password, signing in asks for a six-digit code from an app on your phone. Someone who learns your password still can&apos;t get in without the phone.</p>
            <TwoFactorSetup required={asked?.slug} />
          </div>
        )}
      </Card>
    </main>
  );
}
