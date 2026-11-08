import { auditEvent, getDb, user } from "@ebo/db";
import { and, count, desc, eq, like, sql, type SQL } from "drizzle-orm";
import { FilterForm, FilterSearch, FilterSelect } from "@/components/filters";
import { Badge, Card, Empty, PageHeader, Pager, Table, pageOf } from "@/components/ui";
import { clock } from "@/lib/format";
import { AUDIT_AREAS, auditLabel, documentKindLabel, flagKindLabel } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Audit log" };

const PAGE = 100;

export default async function AuditPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const area = AUDIT_AREAS.some(([k]) => k === sp.area) ? sp.area! : "";
  const who = ["agent", "user"].includes(sp.who ?? "") ? sp.who! : "";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = pageOf(sp.page);

  const where: SQL[] = [eq(auditEvent.workspaceId, ws.id)];
  if (area) where.push(like(auditEvent.action, `${area}.%`));
  if (who) where.push(eq(auditEvent.actorType, who as "agent"));
  if (q) where.push(sql`(${auditEvent.details}::text ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} or ${auditEvent.action} ilike ${`%${q}%`})`);

  const db = getDb();
  const [rows, [total]] = await Promise.all([
    db
      .select({ e: auditEvent, name: user.name, anon: user.isAnonymous })
      .from(auditEvent)
      .leftJoin(user, eq(user.id, auditEvent.actorId))
      .where(and(...where))
      .orderBy(desc(auditEvent.id))
      .limit(PAGE)
      .offset((page - 1) * PAGE),
    db.select({ n: count() }).from(auditEvent).where(and(...where)),
  ]);
  const base = `/w/${slug}/audit`;
  const filtered = !!(area || who || q);
  const href = (p: number) => `${base}?${new URLSearchParams(Object.entries({ area, who, q, page: p > 1 ? String(p) : "" }).filter(([, v]) => v) as Array<[string, string]>)}`;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Audit log"
        sub="Everything Aerion and people did here, newest first. Append-only: nothing in the app edits or deletes these entries. Times are real time, even in the demo."
      />
      <FilterForm clearHref={base} active={filtered}>
        <FilterSelect name="area" label="Area" value={area} options={[["", "Everything"], ...AUDIT_AREAS]} />
        <FilterSelect
          name="who"
          label="By"
          value={who}
          options={[
            ["", "Anyone"],
            ["agent", "Aerion (automatic)"],
            ["user", "People"],
          ]}
        />
        <FilterSearch value={q} placeholder="Invoice number, email address, amount…" />
      </FilterForm>
      <Card pad={false}>
        {rows.length ? (
          <>
            <Table dense head={["When", "Who", "What happened", ""]}>
              {rows.map(({ e, name, anon }) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap py-2 text-xs text-muted">{clock(e.at, ws.timezone)}</td>
                  <td className="whitespace-nowrap py-2">
                    {e.actorType === "agent" ? <Badge tone="blue">Aerion</Badge> : e.actorType === "user" ? <Badge tone="violet">{anon ? "Visitor" : (name ?? "A person")}</Badge> : <Badge>System</Badge>}
                  </td>
                  <td className="min-w-72 py-2">
                    <div className="text-sm font-medium text-ink">{auditLabel(e.action)}</div>
                    <div className="mt-0.5 max-w-3xl break-words text-xs leading-relaxed text-muted">{describe(e.action, e.details)}</div>
                  </td>
                  <td className="py-2 text-right">
                    {Object.keys(e.details).length ? (
                      <details className="group inline-block text-left">
                        <summary className="cursor-pointer list-none text-xs text-muted hover:text-ink [&::-webkit-details-marker]:hidden">Record</summary>
                        <pre className="mt-1 max-h-64 max-w-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-sunken p-2 text-[11px] leading-snug text-ink">
                          {JSON.stringify({ action: e.action, object: e.objectType, id: e.objectId, ...e.details }, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={PAGE} total={Number(total?.n ?? 0)} href={href} noun="entries" />
          </>
        ) : (
          <div className="p-4">
            <Empty>{filtered ? "No entries match these filters." : "Nothing yet. Every run, approval and change will be recorded here."}</Empty>
          </div>
        )}
      </Card>
    </>
  );
}

const INTENT: Record<string, string> = {
  payment_claim: "The sender says they've paid",
  promise_to_pay: "The sender promises to pay",
  bank_detail_change: "The sender asks to change bank details",
  dispute: "The sender disputes an amount",
  remittance_advice: "The sender sent a remittance advice",
  question: "The sender asks a question",
  other: "Nothing in it to act on",
};
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line in words for an audit entry; the full record stays one click away. */
function describe(action: string, d: Record<string, unknown>): string {
  switch (action) {
    case "run.succeeded":
    case "run.failed": {
      const c = (d.counts ?? {}) as Record<string, number>;
      const parts = [
        c.documents_read ? `read ${plural(c.documents_read, "document")}` : "",
        c.emails ? `${plural(c.emails, "email")}` : "",
        c.matched ? `matched ${plural(c.matched, "payment")}` : "",
        c.flags_opened ? `raised ${plural(c.flags_opened, "flag")}` : "",
        c.flags_resolved ? `resolved ${plural(c.flags_resolved, "flag")}` : "",
        c.drafts_draft ? `${plural(c.drafts_draft, "email")} for approval` : "",
        c.sent ? `sent ${plural(c.sent, "email")}` : "",
      ].filter(Boolean);
      return parts.length ? `${parts.join(", ")}.`.replace(/^./, (x) => x.toUpperCase()) : "Nothing new to do.";
    }
    case "payment.matched": {
      const inv = Array.isArray(d.invoices) ? (d.invoices as string[]).join(", ") : "";
      // Older entries end with the internal match tier; it means nothing to a reader.
      const why = Array.isArray(d.explanation) ? str((d.explanation as string[])[0]).replace(/ \(tier [AB]\)/, "") : "";
      return `${inv ? `To ${inv}. ` : ""}${why}`;
    }
    case "email.classified": {
      const effects = Array.isArray(d.effects) ? (d.effects as string[]).map((x) => x.replace(/^[a-z_]+:/, "")).join(", ") : "";
      return `${INTENT[str(d.intent)] ?? `Read as ${str(d.intent).replace(/_/g, " ") || "an email"}`}${effects ? ` (${effects})` : ""}. Read by ${d.model === "offline-rules" ? "the layout rules" : str(d.model) || "the reader"}.`;
    }
    case "email.sent":
      return `To ${str(d.to)}: ${str(d.subject)}${Array.isArray(d.attachments) && d.attachments.length ? `, with ${(d.attachments as string[]).join(", ")}` : ""}${d.mailer === "demo" ? " (demo: recorded, not delivered)" : ""}.`;
    case "draft.created":
      return `${str(d.subject)}${d.to ? `, to ${str(d.to)}` : ""}.`;
    case "draft.edited": {
      const s = d.subject as { to?: string } | undefined;
      return `${s?.to ? `New subject: ${s.to}. ` : ""}${d.previousText ? "The text was changed; the old text is in the record. " : ""}${d.numbersOk ? "Every number still traces to the records." : `Held: ${Array.isArray(d.unmatched) ? (d.unmatched as string[]).join(", ") : "a number"} not in the records.`}`;
    }
    case "flag.opened":
    case "flag.resolved":
      return str(d.summary) || flagKindLabel(str(d.kind));
    case "flag.dismissed":
      return `${flagKindLabel(str(d.kind))}: ${str(d.reason)}`;
    case "policy.changed":
      return `From ${str(d.from)} to ${str(d.to)}.`;
    case "ai_reading.changed":
      return d.enabled ? "Documents are now read by the language model." : "Documents are now read by the layout rules only.";
    case "task.done":
      return `${str(d.title)}${d.note ? `. Note: ${str(d.note)}` : ""}`;
    default:
      if (action.startsWith("document.")) {
        const what = [documentKindLabel(str(d.kind) || null), str(d.amount), d.account ? `into ${str(d.account)}` : "", d.rows ? `${str(d.rows)} rows` : ""].filter(Boolean).join(" · ");
        const reasons = Array.isArray(d.reasons) && d.reasons.length ? ` ${(d.reasons as string[]).join(" ")}` : "";
        return `${what}${reasons}${d.reason ? ` ${str(d.reason)}` : ""}`.trim();
      }
      for (const k of ["summary", "subject", "title", "reason", "name", "email"]) if (typeof d[k] === "string") return d[k] as string;
      return Object.entries(d)
        .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
        .slice(0, 4)
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
        .join(" · ");
  }
}
