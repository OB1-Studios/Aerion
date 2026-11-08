import { draftAction, flag, getDb, rule, task, user } from "@ebo/db";
import { and, arrayContains, eq, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Status, severityTone } from "@/components/ui";
import { clock, day, evidenceLabel, evidenceText, templateName } from "@/lib/format";
import { flagTargets } from "@/lib/flag-links";
import { FLAG_KIND, FLAG_STATUS_LABEL, flagKindLabel, SEVERITY_LABEL } from "@/lib/labels";
import { ruleAbout, ruleName, ruleValue } from "@/lib/rules";
import { canAct, requireWorkspace } from "@/lib/session";
import { dismissFlag } from "../../actions";

export const metadata = { title: "Flag" };

export default async function FlagPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug, id } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [f] = await db
    .select()
    .from(flag)
    .where(and(eq(flag.workspaceId, ws.id), eq(flag.id, id)));
  if (!f) notFound();
  const base = `/w/${slug}`;
  const [drafts, tasks, rules, dismisser, targets] = await Promise.all([
    db.select().from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), arrayContains(draftAction.flagIds, [f.id]))),
    db.select().from(task).where(and(eq(task.workspaceId, ws.id), eq(task.flagId, f.id))),
    f.ruleKeys.length ? db.select().from(rule).where(and(inArray(rule.key, f.ruleKeys), or(isNull(rule.workspaceId), eq(rule.workspaceId, ws.id)))) : Promise.resolve([]),
    f.dismissedBy ? db.select({ name: user.name }).from(user).where(eq(user.id, f.dismissedBy)) : Promise.resolve([]),
    flagTargets(ws.id, base, [f]),
  ]);
  const target = targets.get(f.id);
  const live = f.status === "open" || f.status === "actioned";
  const guide = FLAG_KIND[f.kind];
  const waitingDraft = drafts.find((d) => d.status === "draft" || d.status === "blocked" || d.status === "scheduled");
  // A workspace's own rule value wins over the global one with the same key.
  const ruleRows = [...new Map(rules.sort((a, b) => Number(!!a.workspaceId) - Number(!!b.workspaceId)).map((r) => [r.key, r])).values()];

  return (
    <>
      {sp.error === "reason" ? <Notice tone="red">Say why the flag doesn&rsquo;t need action, so the audit log shows the reason.</Notice> : null}
      <PageHeader
        eyebrow="Flag"
        title={flagKindLabel(f.kind)}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(f.severity)}>{SEVERITY_LABEL[f.severity] ?? f.severity} severity</Badge>
            <Status value={f.status} label={FLAG_STATUS_LABEL[f.status]} />
            <span>raised {clock(f.createdAt, ws.timezone)}</span>
          </span>
        }
        actions={
          <Link href={`${base}/flags`} className="btn btn-secondary">
            All flags
          </Link>
        }
      />
      {f.status === "resolved" ? <Notice tone="green">Resolved by the run at {clock(f.resolvedAt, ws.timezone)}: the records show the problem is fixed.</Notice> : null}
      {f.status === "dismissed" ? (
        <Notice tone="amber">
          Dismissed by {dismisser[0]?.name ?? "a person"}: {f.dismissedReason}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card title="What the checks found">
            <p className="text-[15px] leading-relaxed text-ink">{f.summary}</p>
            {target ? (
              <Link href={target.href} className="link mt-3 inline-block text-sm">
                Open {target.label} →
              </Link>
            ) : null}
          </Card>

          {live && guide ? (
            <Card title="What to do">
              <p className="text-sm text-ink">{guide.next}</p>
              {f.status === "actioned" ? <p className="mt-2 text-sm text-muted">Already being handled: the email went out or the task was done. The flag closes on its own when the records show the fix.</p> : null}
              {waitingDraft ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-line bg-sunken px-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    Aerion drafted <b className="font-medium">{templateName(waitingDraft.template)}</b>, waiting for {waitingDraft.status === "scheduled" ? "its send time" : "your approval"}.
                  </span>
                  <Link href={`${base}/drafts/${waitingDraft.id}`} className="btn btn-primary">
                    Review the email
                  </Link>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card title="Evidence" sub="The values the check used, from the records. Hover a label for its field name.">
            <KeyValues
              rows={Object.entries(f.evidence)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [
                  <span key={k} title={k}>
                    {evidenceLabel(k)}
                  </span>,
                  evidenceText(v),
                ])}
            />
          </Card>

          {drafts.length || tasks.length ? (
            <Card title="What Aerion did about it" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {drafts.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <Link href={`${base}/drafts/${d.id}`} className="min-w-0 text-ink hover:text-accent">
                      <span className="text-muted">Email · </span>
                      {d.subject}
                    </Link>
                    <Status value={d.status} label={d.status === "blocked" ? "Held" : undefined} />
                  </li>
                ))}
                {tasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <span className="min-w-0 text-ink">
                      <span className="text-muted">Task · </span>
                      {t.title}
                      {t.dueOn ? <span className="text-muted"> · due {day(t.dueOn)}</span> : null}
                    </span>
                    <Status value={t.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Rules behind it" sub="The thresholds this check used." pad={false}>
            {ruleRows.length ? (
              <ul className="divide-y divide-line text-sm">
                {ruleRows.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">{ruleName(r.key)}</span>
                      <Badge tone={r.status === "verified" ? "green" : "amber"}>{r.status === "verified" ? "Verified" : "Unverified"}</Badge>
                    </div>
                    <div className="mt-0.5 text-sm tabular-nums text-ink">{ruleValue(r.key, r.value)}</div>
                    <p className="mt-1 text-xs text-muted">{ruleAbout(r.key, r.description)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted">{f.ruleKeys.length ? f.ruleKeys.map(ruleName).join(", ") : "No configurable rule: a fixed check."}</p>
            )}
            <div className="border-t border-line px-4 py-2.5 text-xs">
              <Link href={`${base}/rules`} className="link">
                The rules library →
              </Link>
            </div>
          </Card>
          {canAct(role) && live ? (
            <Card title="Not a problem?">
              <form action={dismissFlag.bind(null, slug, f.id)} className="space-y-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted">Why it doesn&rsquo;t need action</span>
                  <input name="reason" required maxLength={500} placeholder="For example: agreed with the client by phone" className="input" />
                </label>
                <SubmitButton variant="secondary" pendingText="Dismissing…" confirm="Dismiss this flag? It stays dismissed on later runs, and any email drafted only for it is cancelled.">
                  Dismiss the flag
                </SubmitButton>
              </form>
              <p className="mt-2 text-xs text-muted">A dismissed flag stays dismissed on later runs. The reason and your name go in the audit log.</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
