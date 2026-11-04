import { draftAction, flag, getDb, rule, task, user } from "@ebo/db";
import { and, arrayContains, eq, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Status, severityTone } from "@/components/ui";
import { clock, evidenceText, humanize, templateName } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { dismissFlag } from "../../actions";

export const metadata = { title: "Flag" };

/** Where a flag's subject lives in the app. */
function subjectLink(base: string, type: string, id: string): string | null {
  if (type === "transaction") return `${base}/payments/${id}`;
  if (type === "invoice") return `${base}/invoices/${id}`;
  return null;
}

export default async function FlagPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [f] = await db
    .select()
    .from(flag)
    .where(and(eq(flag.workspaceId, ws.id), eq(flag.id, id)));
  if (!f) notFound();
  const [drafts, tasks, rules, dismisser] = await Promise.all([
    db.select().from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), arrayContains(draftAction.flagIds, [f.id]))),
    db.select().from(task).where(and(eq(task.workspaceId, ws.id), eq(task.flagId, f.id))),
    f.ruleKeys.length ? db.select().from(rule).where(and(inArray(rule.key, f.ruleKeys), or(isNull(rule.workspaceId), eq(rule.workspaceId, ws.id)))) : Promise.resolve([]),
    f.dismissedBy ? db.select({ name: user.name }).from(user).where(eq(user.id, f.dismissedBy)) : Promise.resolve([]),
  ]);
  const base = `/w/${slug}`;
  const link = subjectLink(base, f.subjectType, f.subjectId);

  return (
    <>
      <PageHeader
        title={humanize(f.kind)}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
            <Status value={f.status} label={f.status === "actioned" ? "email sent, waiting for the fix" : undefined} />
            <span>opened {clock(f.createdAt, ws.timezone)}</span>
          </span>
        }
        actions={
          <Link href={`${base}/flags`} className="btn btn-secondary">
            All flags
          </Link>
        }
      />
      {f.status === "resolved" ? <Notice tone="green">Resolved by the run at {clock(f.resolvedAt, ws.timezone)}: the condition no longer holds.</Notice> : null}
      {f.status === "dismissed" ? (
        <Notice tone="amber">
          Dismissed by {dismisser[0]?.name ?? "a person"}: {f.dismissedReason}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="What the rules found">
            <p className="text-ink">{f.summary}</p>
            {link ? (
              <Link href={link} className="link mt-2 inline-block text-sm">
                Open the {f.subjectType === "transaction" ? "payment" : f.subjectType} →
              </Link>
            ) : null}
          </Card>
          <Card title="Evidence">
            <KeyValues rows={Object.entries(f.evidence).map(([k, v]) => [<code key={k} className="text-xs">{k}</code>, evidenceText(v)])} />
          </Card>
          {drafts.length || tasks.length ? (
            <Card title="What the agent did about it" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {drafts.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <Link href={`${base}/drafts/${d.id}`} className="text-ink hover:text-accent">
                      {templateName(d.template)}: {d.subject}
                    </Link>
                    <Status value={d.status} />
                  </li>
                ))}
                {tasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-ink">Task: {t.title}</span>
                    <Status value={t.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
        <div className="space-y-6">
          <Card title="Rules behind it" pad={false}>
            {rules.length ? (
              <ul className="divide-y divide-line text-sm">
                {rules.map((r) => (
                  <li key={r.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-xs">{r.key}</code>
                      <Badge tone={r.status === "verified" ? "green" : "amber"}>{r.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">{r.description}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted">{f.ruleKeys.length ? f.ruleKeys.join(", ") : "—"}</p>
            )}
          </Card>
          {canAct(role) && (f.status === "open" || f.status === "actioned") ? (
            <Card title="Not a problem?">
              <form action={dismissFlag.bind(null, slug, f.id)} className="space-y-2">
                <input name="reason" required placeholder="Why it doesn't need action" className="input" />
                <SubmitButton variant="secondary" pendingText="Dismissing…">
                  Dismiss the flag
                </SubmitButton>
              </form>
              <p className="mt-2 text-xs text-muted">A dismissed flag stays dismissed on later runs; the reason goes in the audit log.</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
