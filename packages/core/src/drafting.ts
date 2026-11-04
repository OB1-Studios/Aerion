import type { IsoDate } from "./dates";
import { ev, type Evidence, type EvidenceValue, type NumbersCheckResult } from "./evidence";
import type { FlagCandidate } from "./flags";
import type { Grouping } from "./money";
import { decideSend, type ApprovalPolicy, type SendDecision, type TemplateKey } from "./policy";
import type { Rules } from "./rules";
import { missingDocumentsTemplate, renderEmail, TEMPLATES, type EmailTemplate } from "./templates";

/**
 * Turns flags into drafts and tasks (build kit sections 5 and 6). Pure: the worker
 * stores the result, then the send policy decides who has to look at each draft.
 */

export interface DraftContext {
  today: IsoDate;
  rules: Rules;
  policy: ApprovalPolicy;
  grouping: Grouping;
  workspace: { legalName: string; ntn?: string | null; psebRegNo?: string | null; phone?: string | null; domain?: string | null };
  /** Who signs client emails (finance in an office, the freelancer themselves). */
  sender: { name: string; title: string };
  /** Who signs formal emails and owns tasks (the director, or the freelancer). */
  director: { name: string; title: string; userId?: string | null };
  clients: Map<string, { name: string; contactName?: string | null; contactEmails: string[] }>;
  invoices: Map<string, { number: string; clientId: string; currency: string; amount: string; balance: string; issuedOn: IsoDate; dueOn: IsoDate; receivingAccountId?: string | null }>;
  transactions: Map<string, { reference?: string | null; adviceNumber?: string | null; receivingAccountId?: string | null; valueDate: IsoDate; amount: string; currency: string; payerName?: string | null; purposeCode?: string | null }>;
  accounts: Map<string, { label: string; bankName?: string | null; iban?: string | null; paymentInstructions: string; tradeServicesEmail?: string | null }>;
  /** The default account to quote when an invoice names none. */
  defaultAccountId?: string | null;
  /** An easier way for this client to pay, if the rules library knows one. */
  routeHint?: (clientId: string) => { name: string; instructions: string } | null;
  openDisputeInvoiceIds: Set<string>;
  /** Compliance item id -> transaction id, for grouping missing documents per bank. */
  complianceTransaction: Map<string, { transactionId: string; kind: "eprc" | "wht_certificate" }>;
}

export interface DraftPlan {
  key: string;
  flagKeys: string[];
  kind: "client_email" | "bank_email" | "internal_task";
  template?: TemplateKey;
  invoiceId?: string | null;
  to?: string | null;
  subject: string;
  body: string;
  bodyTemplate?: string;
  evidence: Evidence;
  numbersCheck?: NumbersCheckResult;
  decision?: SendDecision;
  ownerUserId?: string | null;
  dueOn?: IsoDate | null;
}

export const PURPOSE_CODE_DESCRIPTIONS: Record<string, string> = {
  "9186": "IT freelance services, verify",
  "9471": "home remittance, verify",
};

const firstName = (name: string | null | undefined) => (name ?? "").replace(/^(Dr|Mr|Mrs|Ms)\.?\s+/i, "").split(/\s+/)[0] ?? "";

export function planDrafts(flags: FlagCandidate[], ctx: DraftContext): DraftPlan[] {
  const out: DraftPlan[] = [];
  const base: Evidence = {
    "sender.name": ev.text(ctx.sender.name),
    "sender.title": ev.text(ctx.sender.title),
    "workspace.legal_name": ev.text(ctx.workspace.legalName),
    ...(ctx.workspace.phone ? { "workspace.phone": ev.text(ctx.workspace.phone) } : {}),
    "workspace.domain": ev.text(ctx.workspace.domain ?? ""),
    ...(ctx.workspace.ntn ? { "workspace.ntn": ev.text(ctx.workspace.ntn) } : {}),
    ...(ctx.workspace.psebRegNo ? { "workspace.pseb_reg_no": ev.text(ctx.workspace.psebRegNo) } : {}),
  };
  const clientEvidence = (clientId: string): Evidence => {
    const c = ctx.clients.get(clientId);
    const contact = c?.contactName ?? c?.name ?? "";
    return {
      "client.name": ev.text(c?.name ?? ""),
      "client.contact_name": ev.text(contact),
      "client.contact_first_name": ev.text(firstName(contact) || "there"),
    };
  };
  const accountFor = (invoiceId: string | null | undefined, txId?: string | null) => {
    const accId =
      (txId && ctx.transactions.get(txId)?.receivingAccountId) ||
      (invoiceId && ctx.invoices.get(invoiceId)?.receivingAccountId) ||
      ctx.defaultAccountId ||
      null;
    return accId ? ctx.accounts.get(accId) : undefined;
  };

  const email = (
    key: string,
    flag: FlagCandidate | FlagCandidate[],
    t: EmailTemplate,
    evidence: Evidence,
    to: string | null | undefined,
    invoiceId?: string | null,
    clientId?: string | null,
  ): DraftPlan => {
    const r = renderEmail(t, evidence, { grouping: ctx.grouping });
    const decision = decideSend(
      {
        template: t.key,
        numbersCheckOk: r.numbersCheck.ok,
        missingPlaceholders: r.unknown,
        recipientOnFile: !!to,
        clientHasOpenDispute: !!invoiceId && ctx.openDisputeInvoiceIds.has(invoiceId),
      },
      ctx.policy,
    );
    const flags = Array.isArray(flag) ? flag : [flag];
    void clientId;
    return {
      key,
      flagKeys: flags.map((f) => f.key),
      kind: t.kind,
      template: t.key,
      invoiceId: invoiceId ?? null,
      to: to ?? null,
      subject: r.subject,
      body: r.body,
      bodyTemplate: r.bodyTemplate,
      evidence,
      numbersCheck: r.numbersCheck,
      decision,
    };
  };

  const task = (key: string, flag: FlagCandidate, title: string, body: string, dueOn?: IsoDate | null): DraftPlan => ({
    key,
    flagKeys: [flag.key],
    kind: "internal_task",
    subject: title,
    body,
    evidence: flag.evidence,
    ownerUserId: ctx.director.userId ?? null,
    dueOn: dueOn ?? null,
  });

  const missingByBank = new Map<string, FlagCandidate[]>();

  for (const f of flags) {
    const e = f.evidence;
    const text = (k: string) => (e[k]?.type === "text" ? (e[k] as Extract<EvidenceValue, { type: "text" }>).value : "");

    switch (f.kind) {
      case "overdue": {
        const inv = ctx.invoices.get(f.subject.id);
        if (!inv) break;
        const stage = e["reminder.stage"]?.type === "int" ? e["reminder.stage"].value : 1;
        const last = e["reminder.last_sent_stage"]?.type === "int" ? e["reminder.last_sent_stage"].value : 0;
        if (stage <= last) break; // this stage was already sent
        const key: TemplateKey = stage >= 4 ? "T3" : stage >= 2 ? "T2" : "T1";
        const hint = ctx.routeHint?.(inv.clientId) ?? null;
        const evidence: Evidence = {
          ...base,
          ...clientEvidence(inv.clientId),
          "invoice.number": ev.text(inv.number),
          "invoice.amount": ev.money(inv.amount, inv.currency),
          "invoice.balance": ev.money(inv.balance, inv.currency),
          "invoice.issued_on": ev.date(inv.issuedOn),
          "invoice.due_on": ev.date(inv.dueOn),
          days_overdue: e["days.overdue"]!,
          ...(hint ? { "route_hint.name": ev.text(hint.name), "route_hint.instructions": ev.text(hint.instructions) } : {}),
        };
        if (key === "T3") {
          evidence["sender.name"] = ev.text(ctx.director.name);
          evidence["sender.title"] = ev.text(ctx.director.title);
        }
        out.push(email(`${key}:${f.key}:stage${stage}`, f, TEMPLATES[key]!, evidence, ctx.clients.get(inv.clientId)?.contactEmails[0], f.subject.id, inv.clientId));
        break;
      }
      case "unconfirmed_payment_claim": {
        const invId = [...ctx.invoices.entries()].find(([, i]) => i.number === text("invoice.number"))?.[0];
        const inv = invId ? ctx.invoices.get(invId) : undefined;
        if (!inv || !invId) break;
        const acc = accountFor(invId);
        const evidence: Evidence = {
          ...base,
          ...clientEvidence(inv.clientId),
          "invoice.number": ev.text(inv.number),
          "claim.amount": e["claim.amount"] ?? ev.money(inv.amount, inv.currency),
          "claim.date": e["claim.date"]!,
          "receiving_account.payment_instructions": ev.text(acc?.paymentInstructions ?? ""),
        };
        out.push(email(`T4:${f.key}`, f, TEMPLATES.T4!, evidence, ctx.clients.get(inv.clientId)?.contactEmails[0], invId, inv.clientId));
        break;
      }
      case "short_payment": {
        const inv = ctx.invoices.get(f.subject.id);
        if (!inv) break;
        const evidence: Evidence = {
          ...base,
          ...clientEvidence(inv.clientId),
          "invoice.number": ev.text(inv.number),
          "invoice.amount": e["invoice.amount"]!,
          fee: e.fees!,
          received: e.received!,
          unexplained: e.difference!,
          value_date: e["payment.date"]!,
        };
        out.push(email(`T5:${f.key}`, f, TEMPLATES.T5!, evidence, ctx.clients.get(inv.clientId)?.contactEmails[0], f.subject.id, inv.clientId));
        break;
      }
      case "wrong_purpose_code": {
        const tx = ctx.transactions.get(f.subject.id);
        if (!tx) break;
        const invId = [...ctx.invoices.entries()].find(([, i]) => i.number === text("invoice.number"))?.[0] ?? null;
        const acc = accountFor(invId, f.subject.id);
        const code = tx.purposeCode ?? text("code.received");
        const evidence: Evidence = {
          ...base,
          "receiving_account.iban": ev.text(acc?.iban ?? acc?.label ?? ""),
          "txn.amount": e["payment.amount"]!,
          "txn.value_date": e["payment.date"]!,
          ...(tx.adviceNumber ? { "txn.advice_number": ev.text(tx.adviceNumber) } : {}),
          "txn.payer_name": ev.text(tx.payerName ?? ""),
          "txn.purpose_code": ev.text(code),
          "txn.purpose_description": ev.text(PURPOSE_CODE_DESCRIPTIONS[code] ?? "not an IT services code"),
          "invoice.number": ev.text(text("invoice.number")),
          "rule.purpose_code.it_services": ev.text(ctx.rules["purpose_code.it_services"][0] ?? ""),
        };
        out.push(email(`T6:${f.key}`, f, TEMPLATES.T6!, evidence, acc?.tradeServicesEmail, invId));
        break;
      }
      case "missing_eprc":
      case "missing_wht_certificate": {
        const link = ctx.complianceTransaction.get(f.subject.id);
        const tx = link ? ctx.transactions.get(link.transactionId) : undefined;
        const acc = link ? accountFor(null, link.transactionId) : undefined;
        const bank = acc?.bankName ?? "bank";
        if (!tx) break;
        missingByBank.set(bank, [...(missingByBank.get(bank) ?? []), f]);
        break;
      }
      case "bank_detail_change": {
        const clientId = [...ctx.clients.entries()].find(([, c]) => c.name === text("client.name"))?.[0];
        const acc = accountFor(null);
        if (clientId) {
          const evidence: Evidence = {
            ...base,
            ...clientEvidence(clientId),
            "suspicious.received_on": e["message.date"]!,
            "suspicious.from_address": e["message.from"]!,
            "receiving_account.payment_instructions": ev.text(acc?.paymentInstructions ?? ""),
          };
          out.push(email(`T9:${f.key}`, f, TEMPLATES.T9!, evidence, ctx.clients.get(clientId)?.contactEmails[0], null, clientId));
        }
        out.push(task(`task:${f.key}`, f, `Call ${text("client.name") || "the client"} to confirm our bank details`, `Suspicious email from ${text("message.from")}. Use the number on file, not one from the email.`, ctx.today));
        break;
      }
      case "eprc_wrong_code":
        out.push(task(`task:${f.key}`, f, `Check the ePRC for ${text("invoice.number")} with the accountant`, `Coded ${text("code.received")}; should be ${text("code.expected")}. Ask the bank whether it can be reissued.`));
        break;
      case "pseb_renewal":
        out.push(task(`task:${f.key}`, f, `Renew PSEB registration`, f.summary));
        break;
      case "atl_status":
        out.push(task(`task:${f.key}`, f, `Check ATL status on FBR`, f.summary));
        break;
      case "banking_share_low":
        out.push(task(`task:${f.key}`, f, `Banking-channel share is low`, f.summary));
        break;
      case "duplicate_payment":
        out.push(task(`task:${f.key}`, f, `Decide: refund or credit a duplicate payment`, f.summary));
        break;
      case "promise_broken":
        out.push(task(`task:${f.key}`, f, `${text("client.name")} missed their promised payment date`, f.summary));
        break;
      default:
        break; // fx_spread_high, pseb_savings_estimate: report only
    }
  }

  // One request per bank listing every credit with missing documents (T8).
  for (const [bank, group] of missingByBank) {
    const byTx = new Map<string, { needed: Set<string>; flags: FlagCandidate[] }>();
    for (const f of group) {
      const link = ctx.complianceTransaction.get(f.subject.id)!;
      const row = byTx.get(link.transactionId) ?? { needed: new Set<string>(), flags: [] };
      row.needed.add(link.kind === "eprc" ? "ePRC" : "withholding certificate");
      row.flags.push(f);
      byTx.set(link.transactionId, row);
    }
    const rows = [...byTx.entries()].sort(([a], [b]) => (ctx.transactions.get(a)!.valueDate < ctx.transactions.get(b)!.valueDate ? -1 : 1));
    const firstTx = rows[0]![0];
    const acc = accountFor(null, firstTx);
    const evidence: Evidence = { ...base, "receiving_account.iban": ev.text(acc?.iban ?? acc?.label ?? "") };
    rows.forEach(([txId, row], i) => {
      const tx = ctx.transactions.get(txId)!;
      evidence[`items.${i}.advice_number`] = ev.text(tx.adviceNumber ?? tx.reference ?? "credit");
      evidence[`items.${i}.value_date`] = ev.date(tx.valueDate);
      evidence[`items.${i}.amount`] = ev.money(tx.amount, tx.currency);
      evidence[`items.${i}.needed`] = ev.text([...row.needed].join(" and "));
    });
    const flagsInGroup = rows.flatMap(([, r]) => r.flags);
    out.push(email(`T8:${bank}:${flagsInGroup.map((f) => f.key).sort().join("|")}`, flagsInGroup, missingDocumentsTemplate(rows.length), evidence, acc?.tradeServicesEmail));
  }

  return out;
}
