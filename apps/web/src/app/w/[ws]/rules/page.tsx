import { getDb, rule } from "@ebo/db";
import { asc, eq, isNull, or } from "drizzle-orm";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { clock, day } from "@/lib/format";
import { RULE_GROUPS, RULES, ruleAbout, ruleName, ruleSource, ruleValue } from "@/lib/rules";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Rules library" };

export default async function RulesPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const rows = await getDb()
    .select()
    .from(rule)
    .where(or(isNull(rule.workspaceId), eq(rule.workspaceId, ws.id)))
    .orderBy(asc(rule.key));
  // A workspace's own value replaces the global one.
  const own = new Set(rows.filter((r) => r.workspaceId).map((r) => r.key));
  const shown = rows.filter((r) => r.workspaceId || !own.has(r.key));
  const unverified = shown.filter((r) => r.status !== "verified").length;
  const groups = [...RULE_GROUPS, "Other" as const].map((g) => ({ g, rules: shown.filter((r) => (RULES[r.key]?.group ?? "Other") === g) })).filter((x) => x.rules.length);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence & automation"
        title="Rules library"
        sub="Every threshold Aerion decides with: purpose codes, wait times, tolerances and tax rates. Code reads them from here, never from a model, and each flag names the rules it used."
      />
      {unverified ? (
        <Notice tone="amber">
          <b>
            {unverified} of {shown.length} rules are unverified.
          </b>{" "}
          They are starting values: Aerion's own defaults, and figures from Pakistani tax and foreign exchange rules. Have your accountant or tax adviser confirm them before relying on the results. This is not tax advice.
        </Notice>
      ) : null}
      <div className="space-y-6">
        {groups.map(({ g, rules }) => (
          <Card key={g} title={g} pad={false}>
            <ul className="divide-y divide-line">
              {rules.map((r) => (
                <li key={r.id} className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-start">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{ruleName(r.key)}</div>
                    <p className="mt-0.5 text-sm text-muted">{ruleAbout(r.key, r.description)}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                      <code title="The key flags and the audit log use">{r.key}</code>
                      {r.workspaceId ? <span>Set for this workspace</span> : null}
                      {r.effectiveFrom ? <span>In force from {day(r.effectiveFrom)}{r.effectiveTo ? ` to ${day(r.effectiveTo)}` : ""}</span> : null}
                      {r.sourceUrl ? (
                        <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="link">
                          {r.sourceTitle ?? "Source"} ↗
                        </a>
                      ) : ruleSource(r.key, r.sourceTitle) ? (
                        <span>From: {ruleSource(r.key, r.sourceTitle)}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-sm font-medium tabular-nums text-ink sm:text-right">{ruleValue(r.key, r.value)}</div>
                  <div className="sm:text-right">
                    <Badge tone={r.status === "verified" ? "green" : "amber"} title={r.verifiedAt ? `Verified ${clock(r.verifiedAt, ws.timezone)}${r.verifiedBy ? ` by ${r.verifiedBy}` : ""}` : "Not yet confirmed by a person"}>
                      {r.status === "verified" ? "Verified" : "Unverified"}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
