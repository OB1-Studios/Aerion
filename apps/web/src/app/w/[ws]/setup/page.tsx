import { ACCOUNT_KIND_LABELS, DEFAULT_PURPOSE_WORDING, formatIban } from "@ebo/core";
import { client, document, getDb, invoice, mailboxConnection, receivingAccount } from "@ebo/db";
import { MAILBOX_PROVIDERS, peekInvoiceNumber, workspaceToday } from "@ebo/engine";
import { asc, count, eq } from "drizzle-orm";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Notice, PageHeader, cx } from "@/components/ui";
import { clock } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { addAccountAction, connectMailboxAction, disconnectMailboxAction, saveBusinessAction, saveInvoiceSettingsAction, toggleAccountAction } from "../manage-actions";
import { AccountForm, BusinessForm, InvoiceSettingsForm, MailboxForm } from "./forms";

export const metadata = { title: "Setup" };

export default async function SetupPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ welcome?: string }> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const [accounts, clients, invoices, documents, preview, [mailbox]] = await Promise.all([
    db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id)).orderBy(asc(receivingAccount.createdAt)),
    db.select({ n: count() }).from(client).where(eq(client.workspaceId, ws.id)).then(n),
    db.select({ n: count() }).from(invoice).where(eq(invoice.workspaceId, ws.id)).then(n),
    db.select({ n: count() }).from(document).where(eq(document.workspaceId, ws.id)).then(n),
    peekInvoiceNumber(db, ws, workspaceToday(ws)),
    db
      .select({ username: mailboxConnection.username, imapHost: mailboxConnection.imapHost, smtpHost: mailboxConnection.smtpHost, status: mailboxConnection.status, lastError: mailboxConnection.lastError, lastPolledAt: mailboxConnection.lastPolledAt, createdAt: mailboxConnection.createdAt })
      .from(mailboxConnection)
      .where(eq(mailboxConnection.workspaceId, ws.id)),
  ]);
  const owner = role === "owner";
  const base = `/w/${slug}`;
  const s = ws.settings ?? {};
  const steps: Array<{ done: boolean; title: string; text: string; href: string; cta: string; alt?: { href: string; cta: string } }> = [
    { done: !!ws.legalName && !!ws.ntn, title: "Your business details", text: "Legal name and NTN go on every invoice; the PSEB expiry and ATL status decide which reminders you get.", href: "#business", cta: "Fill in" },
    { done: accounts.some((a) => a.active), title: "Where money arrives", text: "Your ESFCA, PKR account or Payoneer. Invoices quote the exact details, and the agent knows where to look for payments.", href: "#accounts", cta: "Add an account" },
    { done: clients > 0, title: "Your clients", text: "Who you invoice, their currency and terms, and the names their payments arrive under.", href: `${base}/clients/new`, cta: "Add a client", alt: { href: `${base}/import#clients`, cta: "import a spreadsheet" } },
    { done: invoices > 0, title: "Your first invoice", text: "Write it here, download the PDF, and send it after approval. The agent then watches for the payment.", href: `${base}/invoices/new`, cta: "New invoice", alt: { href: `${base}/import#invoices`, cta: "import open invoices" } },
    { done: !!mailbox, title: "The finance mailbox (optional)", text: "Connect the mailbox bank advices and client replies arrive in. Each run reads the new mail, and approved emails go out from it.", href: "#mailbox", cta: "Connect" },
    { done: documents > 0, title: "Bank documents", text: "Upload credit advices, PRCs or a bank statement export, and the agent reads them and matches the money to invoices.", href: `${base}/documents`, cta: "Upload" },
  ];
  const left = steps.filter((x) => !x.done).length;

  return (
    <>
      <PageHeader title="Setup" sub="What goes on your invoices, where money arrives, and how invoices are numbered." />
      {q.welcome ? (
        <Notice tone="green">
          <b>{ws.name} is ready.</b> It starts empty: nothing here is simulated. Work down the list below; you can change anything later.
        </Notice>
      ) : null}
      {ws.isDemo ? <Notice tone="violet">This is a demo workspace with fictional details. Changes here last until the demo is reset.</Notice> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card title={<span id="business">Business details</span>}>
            <BusinessForm
              action={saveBusinessAction.bind(null, slug)}
              canEdit={owner}
              company={ws.kind === "company"}
              initial={{
                name: ws.name,
                legalName: ws.legalName ?? "",
                city: ws.city ?? "",
                ntn: ws.ntn ?? "",
                secpRegNo: ws.secpRegNo ?? "",
                psebRegNo: ws.psebRegNo ?? "",
                psebValidUntil: ws.psebValidUntil ?? "",
                atlStatus: ws.atlStatus,
                atlCheckedOn: ws.atlCheckedOn ?? "",
                senderName: s.senderName ?? "",
                senderTitle: s.senderTitle ?? "",
                phone: s.phone ?? "",
                mailboxAddress: s.mailboxAddress ?? "",
              }}
            />
          </Card>

          <Card title={<span id="accounts">Where money arrives</span>} pad={false}>
            {accounts.length ? (
              <ul className="divide-y divide-line text-sm">
                {accounts.map((a) => (
                  <li key={a.id} className={cx("flex flex-wrap items-start justify-between gap-3 px-4 py-3", !a.active && "opacity-60")}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{a.label}</span>
                        <Badge tone="gray">{a.currency}</Badge>
                        {!a.active ? <Badge tone="amber">not offered on new invoices</Badge> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {ACCOUNT_KIND_LABELS[a.kind]}
                        {a.bankName && a.kind !== "payoneer" ? ` · ${a.bankName}` : ""}
                        {a.swift ? ` · SWIFT ${a.swift}` : ""}
                      </div>
                      {a.iban ? <code className="mt-0.5 block break-all text-xs">{formatIban(a.iban)}</code> : null}
                    </div>
                    {owner ? (
                      <form action={toggleAccountAction.bind(null, slug, a.id, !a.active)}>
                        <SubmitButton variant="secondary" pendingText="Saving…">
                          {a.active ? "Stop offering" : "Offer again"}
                        </SubmitButton>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 pt-4 text-sm text-muted">No accounts yet. Add the one clients pay into; most exporters start with their dollar ESFCA.</p>
            )}
            {owner ? (
              <div className="border-t border-line p-4">
                <h3 className="mb-3 text-sm font-medium text-ink">Add an account</h3>
                <AccountForm action={addAccountAction.bind(null, slug)} kinds={Object.entries(ACCOUNT_KIND_LABELS)} />
              </div>
            ) : (
              <p className="p-4 text-sm text-muted">Only an owner can add or change accounts.</p>
            )}
          </Card>

          <Card title={<span id="mailbox">Mailbox</span>}>
            {ws.isDemo ? (
              <p className="text-sm text-muted">Demo workspaces read a simulated mailbox, and emails they &ldquo;send&rdquo; are only recorded. A workspace of your own can connect a real one here.</p>
            ) : mailbox ? (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{mailbox.username}</span>
                  <Badge tone={mailbox.status === "ok" ? "green" : mailbox.status === "error" ? "red" : "gray"}>{mailbox.status === "ok" ? "connected" : mailbox.status === "error" ? "can't read it" : "paused"}</Badge>
                </div>
                <p className="text-muted">
                  Reads new mail from {mailbox.imapHost} at the start of every run (it doesn&apos;t mark anything as read or move it), and sends approved emails through {mailbox.smtpHost}. The worker looks for new mail every 15 minutes and starts a run when some arrives.{" "}
                  {mailbox.lastPolledAt ? `Last read ${clock(mailbox.lastPolledAt, ws.timezone)}.` : "Mail that arrives from now on is read at the next run."}
                </p>
                {mailbox.lastError ? <Notice tone="red">{mailbox.lastError}</Notice> : null}
                {owner ? (
                  <form action={disconnectMailboxAction.bind(null, slug)}>
                    <SubmitButton variant="secondary" pendingText="Disconnecting…">
                      Disconnect
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            ) : owner ? (
              <>
                <p className="mb-4 text-sm text-muted">
                  Bank advices, ePRCs and client replies usually arrive by email. Connect the mailbox they come to with an app password, and each run reads the mail that arrived since the last one. Approved emails then go out from it too. Both logins are
                  checked before anything is saved.
                </p>
                <MailboxForm action={connectMailboxAction.bind(null, slug)} providers={Object.entries(MAILBOX_PROVIDERS).map(([key, p]) => ({ key, label: p.label, help: p.help }))} />
              </>
            ) : (
              <p className="text-sm text-muted">No mailbox connected. Only an owner can connect one; until then, upload documents on the Documents page.</p>
            )}
          </Card>

          <Card title={<span id="invoicing">Invoice numbering</span>}>
            <InvoiceSettingsForm
              action={saveInvoiceSettingsAction.bind(null, slug)}
              canEdit={owner}
              preview={preview}
              initial={{ prefix: ws.invoicePrefix, nextNumber: String(ws.nextInvoiceSeq), purposeWording: s.purposeWording ?? DEFAULT_PURPOSE_WORDING }}
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-6 xl:sticky xl:top-6 xl:self-start">
          <Card title={left ? `${steps.length - left} of ${steps.length} done` : "All set"}>
            <ol className="space-y-4">
              {steps.map((x) => (
                <li key={x.title} className="flex gap-3 text-sm">
                  <span aria-hidden className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs", x.done ? "bg-emerald-600 text-white" : "border border-line text-muted")}>
                    {x.done ? "✓" : ""}
                  </span>
                  <span className="min-w-0">
                    <span className={cx("block font-medium", x.done ? "text-muted line-through decoration-1" : "text-ink")}>{x.title}</span>
                    {!x.done ? (
                      <>
                        <span className="mt-0.5 block text-xs text-muted">{x.text}</span>
                        <Link href={x.href} className="mt-1 inline-block text-xs font-medium text-accent hover:underline">
                          {x.cta} →
                        </Link>
                        {x.alt ? (
                          <>
                            <span className="text-xs text-muted"> or </span>
                            <Link href={x.alt.href} className="text-xs font-medium text-accent hover:underline">
                              {x.alt.cta} →
                            </Link>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                  <span className="sr-only">{x.done ? "done" : "to do"}</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="What the agent does next">
            <p className="text-sm text-muted">
              Every Monday (or when you press Run now) it reads new documents, matches money to invoices, works out what is overdue or about to lapse, and drafts the emails. Under the supervised policy nothing reaches a client until a
              person approves it.
            </p>
            <Link href={`${base}/settings`} className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
              Approval policy and AI reading →
            </Link>
          </Card>
        </div>
      </div>
    </>
  );
}
