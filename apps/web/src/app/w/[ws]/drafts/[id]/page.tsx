import { attachesInvoice, type FoundNumber } from "@ebo/core";
import { client, draftAction, flag, getDb, invoice } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Provenance, Status, severityTone } from "@/components/ui";
import { clock, evidenceLabel, evidenceText, templateName } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { approveDraft, editDraftAction, rejectDraft } from "../../actions";
import { DraftEditor } from "./edit-form";

export const metadata = { title: "Email" };

const MODE_TEXT = { approve: "Needs a person", auto: "Sends automatically", delay: "Sends after a cancel window", blocked: "Held" } as const;
const SEVERITY = { high: "High risk", medium: "Medium risk", info: "Info" } as const;

const EDITED: Record<string, { tone: "green" | "amber"; text: string }> = {
  ok: { tone: "green", text: "Saved. Every number in your text traces to the records; approve it when you're ready." },
  held: { tone: "amber", text: "Saved, but held: a number in your text isn't in the records (marked in red below). Fix it and save again." },
  same: { tone: "green", text: "Nothing changed." },
};

export default async function DraftPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug, id } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [d] = await db
    .select()
    .from(draftAction)
    .where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.id, id)));
  if (!d) notFound();
  const [flags, inv, justSent] = await Promise.all([
    d.flagIds.length ? db.select().from(flag).where(and(eq(flag.workspaceId, ws.id), inArray(flag.id, d.flagIds))) : Promise.resolve([]),
    d.invoiceId
      ? db
          .select({ number: invoice.number, client: client.name, clientId: client.id })
          .from(invoice)
          .innerJoin(client, eq(client.id, invoice.clientId))
          .where(and(eq(invoice.workspaceId, ws.id), eq(invoice.id, d.invoiceId)))
      : Promise.resolve([]),
    sp.sent ? db.select({ subject: draftAction.subject }).from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.id, sp.sent))) : Promise.resolve([]),
  ]);
  const base = `/w/${slug}`;
  const check = d.numbersCheck;
  const found = check?.found ?? [];
  const pending = d.status === "draft" || d.status === "scheduled";
  const editable = pending || d.status === "blocked";
  const acts = canAct(role);
  const editing = acts && editable && sp.edit === "1";
  const from = ws.settings?.mailboxAddress ?? `no-reply@${ws.emailDomain ?? "example.invalid"}`;
  const edited = d.model === "person";
  const notice = sp.edited ? EDITED[sp.edited] : null;

  return (
    <>
      {justSent[0] ? <Notice tone="green">Sent: {justSent[0].subject}. Here is the next one waiting for you.</Notice> : null}
      {sp.error ? <Notice tone="red">Not sent: {sp.error}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <PageHeader
        eyebrow={d.kind === "bank_email" ? "Email to the bank" : "Email to a client"}
        title={templateName(d.template)}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={d.status} label={d.status === "blocked" ? "Held" : undefined} />
            <Provenance kind={edited ? "edited" : "template"} />
            {inv[0] ? (
              <span>
                <Link href={`${base}/clients/${inv[0].clientId}`} className="link">
                  {inv[0].client}
                </Link>{" "}
                ·{" "}
                <Link href={`${base}/invoices/${d.invoiceId}`} className="link">
                  {inv[0].number}
                </Link>
              </span>
            ) : null}
            {d.sentAt ? <span>Sent {clock(d.sentAt, ws.timezone)}</span> : null}
            {d.status === "scheduled" ? <span>Sends at {clock(d.scheduledFor, ws.timezone)} unless cancelled</span> : null}
          </span>
        }
        actions={
          <Link href={`${base}/inbox`} className="btn btn-secondary">
            ← Today
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {d.status === "blocked" ? (
            <Notice tone="amber">
              <b>Held, not sent.</b> {d.rejectedReason ?? "A number in this email doesn't match the records."}{" "}
              {acts ? (
                <>
                  <Link href={`?edit=1`} className="font-medium underline">
                    Edit the text
                  </Link>{" "}
                  to fix it, or wait for the next run to redraft it from the records.
                </>
              ) : null}
            </Notice>
          ) : null}

          <Card
            pad={false}
            title={editing ? "Edit the email" : undefined}
            actions={
              acts && editable && !editing ? (
                <Link href="?edit=1" className="btn btn-secondary">
                  Edit
                </Link>
              ) : undefined
            }
          >
            <div className="space-y-1 border-b border-line px-4 py-3 text-sm">
              <Row k="From">{from}</Row>
              <Row k="To">{d.toAddress}</Row>
              {d.ccAddress ? <Row k="Cc">{d.ccAddress}</Row> : null}
              {!editing ? (
                <Row k="Subject">
                  <b>{highlight(d.subject ?? "", found)}</b>
                </Row>
              ) : null}
              {attachesInvoice(d.template) && d.invoiceId && inv[0] ? (
                <Row k="Attached">
                  <a href={`/api/w/${slug}/invoices/${d.invoiceId}/pdf`} target="_blank" rel="noopener" className="link">
                    {inv[0].number}.pdf
                  </a>
                </Row>
              ) : null}
            </div>
            {editing ? (
              <div className="p-4">
                <DraftEditor action={editDraftAction.bind(null, slug, d.id)} subject={d.subject ?? ""} body={d.bodyRendered ?? ""} cancelHref={`${base}/drafts/${d.id}`} />
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words px-4 py-4 font-sans text-sm leading-relaxed text-ink">{highlight(d.bodyRendered ?? "", found)}</div>
            )}
          </Card>

          {acts && editable && !editing ? (
            <Card title="Your decision" sub={d.status === "blocked" ? "A held email can't be sent until every number traces to the records." : "Approve it as it is, edit it first, or reject it."}>
              <div className="flex flex-wrap items-start gap-3">
                {pending ? (
                  <form action={approveDraft.bind(null, slug, d.id)}>
                    <SubmitButton pendingText="Checking and sending…">{d.status === "scheduled" ? "Send now" : "Approve & send"}</SubmitButton>
                  </form>
                ) : null}
                <form action={rejectDraft.bind(null, slug, d.id)} className="flex min-w-0 flex-[1_1_18rem] gap-2">
                  <input name="reason" maxLength={300} aria-label={d.status === "scheduled" ? "Why cancel (optional)" : "Why reject (optional)"} placeholder={d.status === "scheduled" ? "Why cancel? (optional)" : "Why reject? (optional)"} className="input min-w-0 flex-1" />
                  <SubmitButton variant="danger" pendingText="Saving…" confirm={d.status === "scheduled" ? "Cancel this email? It won't be sent." : "Reject this email? It won't be sent, and the agent won't draft it again."}>
                    {d.status === "scheduled" ? "Cancel" : "Reject"}
                  </SubmitButton>
                </form>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Approving sends it straight away{ws.isDemo ? " (in the demo it's recorded, not delivered)" : ""}. The numbers check runs again on this exact text first; if anything changed in the records, the email is held back.
              </p>
            </Card>
          ) : null}
          {d.rejectedReason && (d.status === "rejected" || d.status === "cancelled" || d.status === "failed") ? (
            <Notice tone="amber">
              {d.status === "failed" ? "Sending failed: " : d.status === "cancelled" ? "Cancelled: " : "Rejected: "}
              {d.rejectedReason}
            </Notice>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Numbers check" sub="Every amount, date and invoice number in the text, traced to the records.">
            {check ? (
              <>
                <div className="mb-3">{check.ok ? <Badge tone="green">✓ Every number traced to the records</Badge> : <Badge tone="red">{check.failures.length === 1 ? "1 number isn't" : `${check.failures.length} numbers aren't`} in the records</Badge>}</div>
                {found.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {dedupe(found).map((f) => (
                      <li key={f.text} className="flex items-baseline justify-between gap-3">
                        <span className={f.ok ? "tabular-nums text-ink" : "font-medium tabular-nums text-rose-700 dark:text-rose-400"}>{f.text}</span>
                        <span className="truncate text-right text-xs text-muted" title={f.matches.join(", ")}>
                          {f.ok ? f.matches.map(evidenceLabel).join(", ") : "not in the records"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">No numbers or dates in this email.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">Not checked.</p>
            )}
          </Card>

          <Card title="Who approves it">
            {d.sendDecision ? (
              <>
                <div className="mb-2">
                  <Badge tone={d.sendDecision.mode === "blocked" ? "red" : d.sendDecision.mode === "approve" ? "amber" : "blue"}>{MODE_TEXT[d.sendDecision.mode]}</Badge>
                </div>
                <ul className="list-disc space-y-1 pl-4 text-sm text-ink marker:text-muted">
                  {d.sendDecision.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted">—</p>
            )}
          </Card>

          {flags.length ? (
            <Card title="The problem it deals with" pad={false}>
              <ul className="divide-y divide-line">
                {flags.map((f) => (
                  <li key={f.id} className="px-4 py-3 text-sm">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={severityTone(f.severity)}>{SEVERITY[f.severity as keyof typeof SEVERITY] ?? f.severity}</Badge>
                      <Status value={f.status} label={f.status === "actioned" ? "Being handled" : undefined} />
                    </div>
                    <Link href={`${base}/flags/${f.id}`} className="text-ink hover:text-accent">
                      {f.summary}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Where each value comes from" sub="The records the template filled in. Hover a label for its field name.">
            {d.evidence && Object.keys(d.evidence).length ? (
              <KeyValues
                rows={Object.entries(d.evidence)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => [
                    <span key={k} title={k}>
                      {evidenceLabel(k)}
                    </span>,
                    evidenceText(v),
                  ])}
              />
            ) : (
              <p className="text-sm text-muted">—</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-16 shrink-0 text-muted">{k}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </div>
  );
}

function dedupe(found: FoundNumber[]): FoundNumber[] {
  return [...new Map(found.map((f) => [f.text, f])).values()];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Marks every number the check found, green when it traces to the evidence and red when it doesn't. */
function highlight(text: string, found: FoundNumber[]): ReactNode[] {
  const items = dedupe(found).sort((a, b) => b.text.length - a.text.length);
  if (!items.length || !text) return [text];
  const byText = new Map(items.map((f) => [f.text, f]));
  const re = new RegExp(items.map((f) => escapeRe(f.text)).join("|"), "g");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const f = byText.get(m[0])!;
    out.push(text.slice(last, m.index));
    out.push(
      <mark
        key={`${m.index}`}
        title={f.ok ? `From the records: ${f.matches.map(evidenceLabel).join(", ")}` : "Not in the records"}
        className={f.ok ? "rounded bg-emerald-100 px-0.5 text-inherit dark:bg-emerald-900/60" : "rounded bg-rose-200 px-0.5 text-inherit dark:bg-rose-900"}
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
