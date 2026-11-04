import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

const DEMO_ACCOUNTS = [
  ["sana@ravicodeworks.example", "Owner, Ravi Code Works"],
  ["hamza@ravicodeworks.example", "Finance, Ravi Code Works"],
  ["qureshi@qureshi-associates.example", "Accountant (both workspaces)"],
  ["ayesha@ayeshabuilds.example", "Freelancer"],
];

export default async function LoginPage() {
  if (await getSession()) redirect("/workspaces");
  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center px-4 py-10">
      <Link href="/" className="mb-6 text-sm text-muted hover:text-ink">
        ← IT Export Back Office
      </Link>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <LoginForm />
      </div>
      <p className="mt-4 text-center text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
      <div className="mt-6 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-medium">Shared demo accounts</div>
        <p className="mt-1 text-muted">These share one copy of the demo. For your own copy, use &ldquo;Try the demo&rdquo; on the home page. The password is in the submission notes.</p>
        <ul className="mt-2 space-y-1">
          {DEMO_ACCOUNTS.map(([email, role]) => (
            <li key={email} className="flex flex-wrap justify-between gap-2">
              <code className="text-xs">{email}</code>
              <span className="ml-auto text-right text-xs text-muted">{role}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
