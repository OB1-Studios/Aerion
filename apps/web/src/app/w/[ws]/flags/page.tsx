import { flag, getDb } from "@ebo/db";
import { and, count, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { FilterForm, FilterSearch, FilterSelect } from "@/components/filters";
import { Badge, Card, Empty, PageHeader, Pager, Status, Table, Tabs, pageOf, severityTone } from "@/components/ui";
import { clock } from "@/lib/format";
import { flagTargets } from "@/lib/flag-links";
import { FLAG_KIND, FLAG_STATUS_LABEL, flagKindLabel, SEVERITY_LABEL } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Flags" };

const TABS = [
  ["open", "Open", ["open", "actioned"]],
  ["resolved", "Resolved", ["resolved"]],
  ["dismissed", "Dismissed", ["dismissed"]],
] as const;
type Tab = (typeof TABS)[number];
const PAGE = 50;

export default async function FlagsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  // "closed" was this tab's old name; links to it still work.
  const tab: Tab = TABS.find(([k]) => k === (sp.show === "closed" ? "resolved" : sp.show)) ?? TABS[0];
  const severity = ["high", "medium", "info"].includes(sp.severity ?? "") ? sp.severity! : "";
  const kind = sp.kind && sp.kind in FLAG_KIND ? sp.kind : "";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = pageOf(sp.page);

  const where: SQL[] = [eq(flag.workspaceId, ws.id), inArray(flag.status, [...tab[2]])];
  if (severity) where.push(eq(flag.severity, severity as "high"));
  if (kind) where.push(eq(flag.kind, kind as "overdue"));
  if (q) where.push(ilike(flag.summary, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));

  const [rows, [total], byStatus, kinds] = await Promise.all([
    db
      .select()
      .from(flag)
      .where(and(...where))
      // Most urgent first: high before medium before info, then the newest.
      .orderBy(sql`case ${flag.severity} when 'high' then 0 when 'medium' then 1 else 2 end`, desc(flag.updatedAt))
      .limit(PAGE)
      .offset((page - 1) * PAGE),
    db.select({ n: count() }).from(flag).where(and(...where)),
    db.select({ status: flag.status, severity: flag.severity, n: count() }).from(flag).where(eq(flag.workspaceId, ws.id)).groupBy(flag.status, flag.severity),
    db.selectDistinct({ kind: flag.kind }).from(flag).where(and(eq(flag.workspaceId, ws.id), inArray(flag.status, [...tab[2]]))),
  ]);
  const base = `/w/${slug}`;
  const targets = await flagTargets(ws.id, base, rows);
  const tally = (statuses: readonly string[], sev?: string) => byStatus.filter((r) => statuses.includes(r.status) && (!sev || r.severity === sev)).reduce((n, r) => n + Number(r.n), 0);
  const openHigh = tally(["open", "actioned"], "high");
  const handled = tally(["actioned"]);
  const filtered = !!(severity || kind || q);
  const keep = { show: tab[0] === "open" ? undefined : tab[0] };
  const href = (p: number) => `${base}/flags?${new URLSearchParams(Object.entries({ show: keep.show, severity, kind, q, page: p > 1 ? String(p) : "" }).filter(([, v]) => v) as Array<[string, string]>)}`;

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Flags"
        sub="Problems the checks found in payments, certificates and emails. Every run checks them again: a flag closes on its own when the records show it's fixed."
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <Tabs items={TABS.map(([k, label, statuses]) => ({ href: `${base}/flags${k === "open" ? "" : `?show=${k}`}`, label, active: k === tab[0], count: tally(statuses) }))} />
        {tab[0] === "open" && (openHigh || handled) ? (
          <p className="mb-4 text-sm text-muted">
            {openHigh ? <b className="font-medium text-rose-700 dark:text-rose-400">{openHigh} high</b> : null}
            {openHigh && handled ? " · " : null}
            {handled ? `${handled} being handled, waiting on a reply` : null}
          </p>
        ) : null}
      </div>

      <FilterForm keep={keep} clearHref={`${base}/flags${keep.show ? `?show=${keep.show}` : ""}`} active={filtered}>
        <FilterSelect
          name="severity"
          label="Severity"
          value={severity}
          options={[
            ["", "Any severity"],
            ["high", "High"],
            ["medium", "Medium"],
            ["info", "Info"],
          ]}
        />
        <FilterSelect name="kind" label="Kind" value={kind} options={[["", "Any kind"], ...kinds.map((k) => [k.kind, flagKindLabel(k.kind)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]))]} />
        <FilterSearch value={q} placeholder="Client, invoice number, amount…" />
      </FilterForm>

      <Card pad={false}>
        {rows.length ? (
          <>
            <Table head={["Severity", "Problem", "About", "Status", tab[0] === "resolved" ? "Resolved" : "Updated"]}>
              {rows.map((f) => {
                const target = targets.get(f.id);
                return (
                  <tr key={f.id}>
                    <td className="align-top">
                      <Badge tone={severityTone(f.severity)}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Badge>
                    </td>
                    <td className="min-w-72 align-top">
                      <div className="text-xs font-medium text-muted">{flagKindLabel(f.kind)}</div>
                      <Link href={`${base}/flags/${f.id}`} className="mt-0.5 block text-ink hover:text-accent">
                        {f.summary}
                      </Link>
                      {tab[0] === "open" && f.status === "open" && FLAG_KIND[f.kind] ? <div className="mt-1 text-xs text-muted">Next: {FLAG_KIND[f.kind].next}</div> : null}
                    </td>
                    <td className="whitespace-nowrap align-top text-sm">
                      {target ? (
                        <Link href={target.href} className="link">
                          {target.label}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="align-top">
                      <Status value={f.status} label={FLAG_STATUS_LABEL[f.status]} />
                    </td>
                    <td className="whitespace-nowrap align-top text-xs text-muted">{clock(f.status === "resolved" ? f.resolvedAt : f.updatedAt, ws.timezone)}</td>
                  </tr>
                );
              })}
            </Table>
            <Pager page={page} pageSize={PAGE} total={Number(total?.n ?? 0)} href={href} noun="flags" />
          </>
        ) : (
          <div className="p-4">
            <Empty>
              {filtered
                ? "No flags match these filters."
                : tab[0] === "open"
                  ? "No open flags. Every payment, certificate and email checked out on the last run."
                  : tab[0] === "resolved"
                    ? "No flags resolved yet. They close on their own when the records show the problem is fixed."
                    : "No flags dismissed."}
            </Empty>
          </div>
        )}
      </Card>
    </>
  );
}
