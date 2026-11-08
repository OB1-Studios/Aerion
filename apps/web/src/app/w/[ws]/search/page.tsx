import { dec } from "@ebo/core";
import { client, document, draftAction, flag, getDb, invoice, transaction } from "@ebo/db";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, Empty, PageHeader, Status, severityTone } from "@/components/ui";
import { appliedToInvoice, creditedOnInvoice } from "@/lib/balances";
import { clock, money, shortDay, templateName } from "@/lib/format";
import { documentKindLabel, FLAG_STATUS_LABEL, flagKindLabel, MATCH_STATUS, SEVERITY_LABEL } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Search" };

const LIMIT = 8;

export default async function SearchPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws } = await requireWorkspace(slug);
  const q = (sp.q ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const base = `/w/${slug}`;

  if (q.length < 2) {
    return (
      <>
        <PageHeader title="Search" sub="Find an invoice, client, payment, document, flag or email in this workspace." />
        <Empty>Type at least two characters: an invoice number, a client&rsquo;s name, an amount, a bank reference or a file name.</Empty>
      </>
    );
  }

  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // "6,750" or "6750.00" finds the amount 6750.00 too.
  const amount = /^[\d,]+(\.\d{1,2})?$/.test(q) ? q.replace(/,/g, "") : null;
  const db = getDb();
  const [invoices, clients, payments, docs, flags, emails] = await Promise.all([
    db
      .select({ inv: invoice, client: client.name, applied: appliedToInvoice, credited: creditedOnInvoice })
      .from(invoice)
      .innerJoin(client, eq(client.id, invoice.clientId))
      .where(and(eq(invoice.workspaceId, ws.id), or(ilike(invoice.number, like), ilike(client.name, like), amount ? eq(invoice.amount, amount) : undefined)))
      .orderBy(desc(invoice.issuedOn))
      .limit(LIMIT),
    db
      .select()
      .from(client)
      .where(and(eq(client.workspaceId, ws.id), or(ilike(client.name, like), ilike(client.contactName, like), sql`exists (select 1 from unnest(${client.contactEmails}) e where e ilike ${like})`)))
      .orderBy(client.name)
      .limit(LIMIT),
    db
      .select()
      .from(transaction)
      .where(and(eq(transaction.workspaceId, ws.id), or(ilike(transaction.payerName, like), ilike(transaction.reference, like), ilike(transaction.adviceNumber, like), ilike(transaction.uetr, like), amount ? eq(transaction.amount, amount) : undefined)))
      .orderBy(desc(transaction.valueDate))
      .limit(LIMIT),
    db.select().from(document).where(and(eq(document.workspaceId, ws.id), ilike(document.originalName, like))).orderBy(desc(document.receivedAt)).limit(LIMIT),
    db.select().from(flag).where(and(eq(flag.workspaceId, ws.id), ilike(flag.summary, like))).orderBy(desc(flag.updatedAt)).limit(LIMIT),
    db
      .select()
      .from(draftAction)
      .where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.kind, ["client_email", "bank_email"]), or(ilike(draftAction.subject, like), ilike(draftAction.toAddress, like))))
      .orderBy(desc(draftAction.createdAt))
      .limit(LIMIT),
  ]);
  const found = invoices.length + clients.length + payments.length + docs.length + flags.length + emails.length;
  // An exact invoice number is almost certainly what was meant.
  const exact = invoices.find((i) => i.inv.number.toLowerCase() === q.toLowerCase());

  return (
    <>
      <PageHeader eyebrow="Search" title={`“${q}”`} sub={found ? `${found} result${found === 1 ? "" : "s"}${found >= LIMIT ? `, the first ${LIMIT} of each kind` : ""}.` : "Nothing in this workspace matches."} />
      {exact ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-accent/30 bg-accent-soft/60 px-4 py-3">
          <span className="text-sm text-ink">
            Invoice <b>{exact.inv.number}</b> for {exact.client}, {money(exact.inv.amount, exact.inv.currency)}
          </span>
          <Link href={`${base}/invoices/${exact.inv.id}`} className="btn btn-primary">
            Open the invoice
          </Link>
        </div>
      ) : null}
      {found ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {invoices.length ? (
            <Group title="Invoices" more={`${base}/invoices?show=all&q=${encodeURIComponent(q)}`}>
              {invoices.map(({ inv, client: c, applied, credited }) => {
                const balance = dec(inv.amount).minus(inv.paidBeforeImport).minus(applied).minus(credited);
                return (
                  <Item key={inv.id} href={`${base}/invoices/${inv.id}`} title={inv.number} meta={`${c} · issued ${shortDay(inv.issuedOn)}`} right={<Status value={inv.status} />}>
                    {money(inv.amount, inv.currency)}
                    {balance.gt(0) && inv.status !== "draft" && inv.status !== "void" ? <span className="text-muted"> · {money(balance.toFixed(2), inv.currency)} owed</span> : null}
                  </Item>
                );
              })}
            </Group>
          ) : null}
          {clients.length ? (
            <Group title="Clients" more={`${base}/clients?q=${encodeURIComponent(q)}`}>
              {clients.map((c) => (
                <Item key={c.id} href={`${base}/clients/${c.id}`} title={c.name} meta={[c.contactName, c.contactEmails[0]].filter(Boolean).join(" · ") || c.country} right={<span className="text-xs text-muted">{c.defaultCurrency}</span>} />
              ))}
            </Group>
          ) : null}
          {payments.length ? (
            <Group title="Payments" more={`${base}/payments?show=all&q=${encodeURIComponent(q)}`}>
              {payments.map((t) => (
                <Item key={t.id} href={`${base}/payments/${t.id}`} title={money(t.amount, t.currency)} meta={`${t.payerName ?? "Unknown payer"} · ${shortDay(t.valueDate)}${t.reference ? ` · ${t.reference}` : ""}`} right={<Status value={t.matchStatus} label={MATCH_STATUS[t.matchStatus]} />} />
              ))}
            </Group>
          ) : null}
          {flags.length ? (
            <Group title="Flags" more={`${base}/flags?q=${encodeURIComponent(q)}`}>
              {flags.map((f) => (
                <Item key={f.id} href={`${base}/flags/${f.id}`} title={flagKindLabel(f.kind)} meta={f.summary} right={<Badge tone={severityTone(f.severity)}>{SEVERITY_LABEL[f.severity]}</Badge>}>
                  <span className="text-xs text-muted">{FLAG_STATUS_LABEL[f.status]}</span>
                </Item>
              ))}
            </Group>
          ) : null}
          {emails.length ? (
            <Group title="Emails">
              {emails.map((d) => (
                <Item key={d.id} href={`${base}/drafts/${d.id}`} title={d.subject ?? templateName(d.template)} meta={`To ${d.toAddress ?? "—"}${d.sentAt ? ` · sent ${clock(d.sentAt, ws.timezone)}` : ""}`} right={<Status value={d.status} label={d.status === "blocked" ? "Held" : undefined} />} />
              ))}
            </Group>
          ) : null}
          {docs.length ? (
            <Group title="Documents" more={`${base}/documents?q=${encodeURIComponent(q)}`}>
              {docs.map((d) => (
                <Item key={d.id} href={`${base}/documents/${d.id}`} title={d.originalName ?? "Document"} meta={`${documentKindLabel(d.kind)} · ${clock(d.receivedAt, ws.timezone)}`} />
              ))}
            </Group>
          ) : null}
        </div>
      ) : (
        <Empty>Try an invoice number (INV-2026-029), part of a client&rsquo;s name, an amount (6750) or a bank reference.</Empty>
      )}
    </>
  );
}

function Group({ title, more, children }: { title: string; more?: string; children: ReactNode }) {
  return (
    <Card
      title={title}
      pad={false}
      actions={
        more ? (
          <Link href={more} className="link text-sm">
            See all →
          </Link>
        ) : undefined
      }
    >
      <ul className="divide-y divide-line">{children}</ul>
    </Card>
  );
}

function Item({ href, title, meta, right, children }: { href: string; title: ReactNode; meta?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-sunken">
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{title}</span>
          {meta ? <span className="block truncate text-xs text-muted">{meta}</span> : null}
          {children ? <span className="mt-0.5 block text-sm tabular-nums text-ink">{children}</span> : null}
        </span>
        {right ? <span className="shrink-0">{right}</span> : null}
      </Link>
    </li>
  );
}
