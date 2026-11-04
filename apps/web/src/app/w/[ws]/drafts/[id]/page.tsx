import type { FoundNumber } from "@ebo/core";
import { client, draftAction, flag, getDb, invoice } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Status, severityTone } from "@/components/ui";
import { clock, evidenceText, templateName } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { approveDraft, rejectDraft } from "../../actions";

export const metadata = { title: "Draft" };

const MODE_TEXT = { approve: "Needs a person", auto: "Sends automatically", delay: "Sends after a cancel window", blocked: "Blocked" } as const;

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
          .select({ number: invoice.number, client: client.name })
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
  const acts = canAct(role);
  const from = ws.settings?.mailboxAddress ?? `no-reply@${ws.emailDomain ?? "example.invalid"}`;

  return (
    <>
      {justSent[0] ? <Notice tone="green">Sent: {justSent[0].subject}. Here is the next one.</Notice> : null}
      {sp.error ? <Notice tone="red">Not sent: {sp.error}</Notice> : null}
      <PageHeader
        title={templateName(d.template)}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={d.status} />
            {inv[0] ? (
              <span>
                {inv[0].client} · {inv[0].number}
              </span>
            ) : null}
            {d.sentAt ? <span>Sent {clock(d.sentAt, ws.timezone)}</span> : null}
            {d.status === "scheduled" ? <span>Sends at {clock(d.scheduledFor, ws.timezone)} unless cancelled</span> : null}
          </span>
        }
        actions={
          <Link href={`${base}/inbox`} className="btn btn-secondary">
            ← Inbox
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <Card pad={false}>
            <div className="space-y-1 border-b border-line px-4 py-3 text-sm">
              <Row k="From">{from}</Row>
              <Row k="To">{d.toAddress}</Row>
              {d.ccAddress ? <Row k="Cc">{d.ccAddress}</Row> : null}
              <Row k="Subject">
                <b>{highlight(d.subject ?? "", found)}</b>
              </Row>
              {d.template === "T11" && d.invoiceId && inv[0] ? (
                <Row k="Attached">
                  <a href={`/api/w/${slug}/invoices/${d.invoiceId}/pdf`} target="_blank" rel="noopener" className="text-accent hover:underline">
                    {inv[0].number}.pdf
                  </a>
                </Row>
              ) : null}
            </div>
            <div className="whitespace-pre-wrap px-4 py-4 font-sans text-sm leading-relaxed text-ink">{highlight(d.bodyRendered ?? "", found)}</div>
          </Card>

          {acts && (pending || d.status === "blocked") ? (
            <Card title="Decision">
              <div className="flex flex-wrap items-start gap-3">
                {pending ? (
                  <form action={approveDraft.bind(null, slug, d.id)}>
                    <SubmitButton pendingText="Checking and sending…">{d.status === "scheduled" ? "Send now" : "Approve & send"}</SubmitButton>
                  </form>
                ) : null}
                <form action={rejectDraft.bind(null, slug, d.id)} className="flex flex-1 flex-wrap gap-2">
                  <input name="reason" placeholder={d.status === "scheduled" ? "Why cancel? (optional)" : "Why reject? (optional)"} className="input min-w-48 flex-1" />
                  <SubmitButton variant="danger" pendingText="Saving…">
                    {d.status === "scheduled" ? "Cancel" : "Reject"}
                  </SubmitButton>
                </form>
              </div>
              <p className="mt-3 text-xs text-muted">Approving sends it straight away. The numbers check runs again on this exact text first; if anything changed in the records, the email is held back.</p>
            </Card>
          ) : null}
          {d.rejectedReason && (d.status === "rejected" || d.status === "cancelled" || d.status === "failed" || d.status === "blocked") ? <Notice tone="amber">{d.rejectedReason}</Notice> : null}
        </div>

        <div className="space-y-6">
          <Card title="Numbers check">
            {check ? (
              <>
                <div className="mb-3">{check.ok ? <Badge tone="green">✓ every number traced to the records</Badge> : <Badge tone="red">{check.failures.length} number(s) not in the records</Badge>}</div>
                {found.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {dedupe(found).map((f) => (
                      <li key={f.text} className="flex items-baseline justify-between gap-3">
                        <code className={f.ok ? "text-ink" : "text-rose-600"}>{f.text}</code>
                        <span className="truncate text-right text-xs text-muted">{f.ok ? f.matches.join(", ") : "not in the evidence"}</span>
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

          <Card title="Why it needs (or doesn't need) a person">
            {d.sendDecision ? (
              <>
                <div className="mb-2">
                  <Badge tone={d.sendDecision.mode === "blocked" ? "red" : d.sendDecision.mode === "approve" ? "amber" : "blue"}>{MODE_TEXT[d.sendDecision.mode]}</Badge>
                </div>
                <ul className="list-disc space-y-1 pl-4 text-sm text-ink">
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
            <Card title="Flags this email deals with" pad={false}>
              <ul className="divide-y divide-line">
                {flags.map((f) => (
                  <li key={f.id} className="px-4 py-2.5 text-sm">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                      <Status value={f.status} />
                    </div>
                    <Link href={`${base}/flags/${f.id}`} className="text-ink hover:text-accent">
                      {f.summary}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Evidence (where every value comes from)">
            {d.evidence && Object.keys(d.evidence).length ? (
              <KeyValues rows={Object.entries(d.evidence).map(([k, v]) => [<code key={k} className="text-xs">{k}</code>, evidenceText(v)])} />
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
        title={f.ok ? `From the records: ${f.matches.join(", ")}` : "Not in the records"}
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
