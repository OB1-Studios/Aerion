import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getSession } from "@/lib/session";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Create an account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string; email?: string }> }) {
  const q = await searchParams;
  const next = q.next?.startsWith("/invite/") ? q.next : undefined;
  const session = await getSession();
  const visitor = !!(session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous;
  if (session && !visitor) redirect(next ?? "/workspaces");
  return (
    <AuthShell
      title="Create your account"
      sub={
        <>
          {next ? "Then you'll join the workspace you were invited to." : "Then set up a workspace for your software house or your freelance work. It starts empty and takes about ten minutes."} Already have an account?{" "}
          <Link href={next ? `/login?${new URLSearchParams({ next, ...(q.email ? { email: q.email } : {}) })}` : "/login"} className="link font-medium">
            Sign in
          </Link>
          .
        </>
      }
    >
      {visitor ? <p className="mb-4 rounded-md border border-violet-line bg-violet-soft px-3 py-2 text-sm text-ink">You&apos;re trying the demo. Your demo copy comes with you, until it expires.</p> : null}
      <SignUpForm next={next} email={q.email} />
    </AuthShell>
  );
}
