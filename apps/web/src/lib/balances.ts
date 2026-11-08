import { sql } from "drizzle-orm";

/*
 * What has been applied to, and credited against, the invoice row of the surrounding query.
 *
 * The outer reference is written out as "invoice"."id" on purpose. When a query selects from one
 * table only, Drizzle leaves column names unqualified, so `${invoice.id}` inside this subquery
 * would become plain "id" and resolve to the subquery's own table: the sum would compare a row
 * with itself and come out as zero. Use these only in queries whose FROM is the invoice table
 * under its own name (not an alias).
 */
export const appliedToInvoice = sql<string>`coalesce((select sum(m.applied_amount) from match m where m.invoice_id = "invoice"."id"), 0)`;
export const creditedOnInvoice = sql<string>`coalesce((select sum(c.amount) from credit_note c where c.invoice_id = "invoice"."id"), 0)`;
