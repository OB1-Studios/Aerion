import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Create an account" };

export default async function SignUpPage() {
  const session = await getSession();
  const visitor = !!(session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous;
  if (session && !visitor) redirect("/workspaces");
  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center px-4 py-10">
      <Link href="/" className="mb-6 text-sm text-muted hover:text-ink">
        ← IT Export Back Office
      </Link>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Create an account</h1>
        <p className="mt-1 text-sm text-muted">Then set up a workspace for your software house or your freelance work. It starts empty and takes about ten minutes.</p>
        {visitor ? <p className="mt-3 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-950 dark:bg-violet-950 dark:text-violet-100">You&apos;re trying the demo. Your demo copy comes with you, until it expires.</p> : null}
        <SignUpForm />
      </div>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
