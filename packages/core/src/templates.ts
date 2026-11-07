import { checkNumbers, missingPlaceholders, renderTemplate, type Evidence, type NumbersCheckResult, type RenderOptions } from "./evidence";
import type { TemplateKey } from "./policy";

/**
 * Email templates from the build kit (section 5), word for word where possible.
 * Rules: placeholders only, no digits in template text; `{{#if x}}…{{/if}}` blocks are
 * dropped when x has no value; every client email ends with the signature block.
 */

const SIGNATURE = `{{sender.name}}
{{sender.title}}, {{workspace.legal_name}}
{{#if workspace.phone}}{{workspace.phone}} · {{/if}}{{workspace.domain}}`;

export interface EmailTemplate {
  key: TemplateKey;
  kind: "client_email" | "bank_email";
  subject: string;
  body: string;
}

export const TEMPLATES: Partial<Record<TemplateKey, EmailTemplate>> = {
  T1: {
    key: "T1",
    kind: "client_email",
    subject: "{{invoice.number}}: payment reminder",
    body: `Hi {{client.contact_first_name}},

A quick reminder that invoice {{invoice.number}} for {{invoice.balance}} was due on {{invoice.due_on}}. If it's already on its way, thank you, and please ignore this.

Payment details are on the invoice, attached again for convenience.
{{#if route_hint.name}}
If a bank wire is inconvenient, you can also pay by {{route_hint.name}}: {{route_hint.instructions}}
{{/if}}
Best regards,
${SIGNATURE}`,
  },
  T2: {
    key: "T2",
    kind: "client_email",
    subject: "{{invoice.number}}: now {{days_overdue}} days overdue",
    body: `Hi {{client.contact_first_name}},

Invoice {{invoice.number}} for {{invoice.balance}} is now {{days_overdue}} days past its due date of {{invoice.due_on}}. Could you let me know when we can expect payment?

If anything is holding it up (a missing PO, a question about the work, bank details), reply here and I'll sort it out.
{{#if route_hint.name}}
{{route_hint.name}} is also available: {{route_hint.instructions}}
{{/if}}
Thanks,
${SIGNATURE}`,
  },
  T3: {
    key: "T3",
    kind: "client_email",
    subject: "{{invoice.number}}: overdue {{days_overdue}} days, please confirm a payment date",
    body: `Dear {{client.contact_name}},

Invoice {{invoice.number}}, issued on {{invoice.issued_on}} for {{invoice.amount}}, has an outstanding balance of {{invoice.balance}} and is {{days_overdue}} days overdue.

Please confirm a payment date by return. If there is a dispute about the invoice, let us know the details so we can resolve it.

Yours sincerely,
${SIGNATURE}`,
  },
  T4: {
    key: "T4",
    kind: "client_email",
    subject: "{{invoice.number}}: we haven't received the payment yet",
    body: `Hi {{client.contact_first_name}},

Thanks for letting us know you sent {{claim.amount}} on {{claim.date}} for {{invoice.number}}. It hasn't reached our account yet, which can happen when an intermediary bank holds a wire.

Could you ask your bank for the MT103 (the SWIFT confirmation) or the UETR tracking number? With that, our bank can trace it at their end.

For reference, the account it should arrive in:
{{receiving_account.payment_instructions}}

Thank you,
${SIGNATURE}`,
  },
  T5: {
    key: "T5",
    kind: "client_email",
    subject: "{{invoice.number}}: {{unexplained}} short",
    body: `Hi {{client.contact_first_name}},

Thank you for the payment against {{invoice.number}}. We received {{received}} on {{value_date}} against an invoice of {{invoice.amount}}:

  Invoice amount        {{invoice.amount}}
  Bank charges          {{fee}}
  Received              {{received}}
  Still outstanding     {{unexplained}}
{{#if charges_code_is_our}}
The invoice was agreed with charges paid by the sender (OUR), so the charges shouldn't reduce the amount we receive.
{{/if}}
Could you send the remaining {{unexplained}}, or let me know if there's a reason for the difference?

Best regards,
${SIGNATURE}`,
  },
  T6: {
    key: "T6",
    kind: "bank_email",
    subject: "Purpose code correction: inward remittance {{#if txn.advice_number}}{{txn.advice_number}}, {{/if}}{{txn.value_date}}",
    body: `Dear Trade Services team,

Our account {{receiving_account.iban}} ({{workspace.legal_name}}{{#if workspace.ntn}}, NTN {{workspace.ntn}}{{/if}}) received an inward remittance of {{txn.amount}} on {{txn.value_date}}{{#if txn.advice_number}}, reference {{txn.advice_number}}{{/if}}, from {{txn.payer_name}}.

It has been coded {{txn.purpose_code}} ({{txn.purpose_description}}). The payment is for IT services exported under invoice {{invoice.number}}, attached, and should carry purpose code {{rule.purpose_code.it_services}}.

Please correct the code before the ePRC is issued, and confirm once done.
{{#if workspace.pseb_reg_no}}
Our PSEB registration number is {{workspace.pseb_reg_no}}.
{{/if}}
Regards,
${SIGNATURE}`,
  },
  T9: {
    key: "T9",
    kind: "client_email",
    subject: "Our bank details have not changed",
    body: `Hi {{client.contact_first_name}},

Thank you for checking with us. The email from {{suspicious.from_address}} that you forwarded on {{suspicious.received_on}} did not come from us, and our bank details have not changed. They are the same as on every invoice:

{{receiving_account.payment_instructions}}

Please don't send any payment to other details, and if you have already done so, contact your bank today. {{sender.name}} will also call you to confirm.

Best regards,
${SIGNATURE}`,
  },
  T11: {
    key: "T11",
    kind: "client_email",
    subject: "{{invoice.number}} from {{workspace.legal_name}}: {{invoice.amount}} due {{invoice.due_on}}",
    body: `Hi {{client.contact_first_name}},

Please find attached invoice {{invoice.number}} for {{invoice.amount}}, due on {{invoice.due_on}}.

How to pay: {{route.name}}
{{receiving_account.payment_instructions}}
{{#if route.purpose_wording}}
Please quote "{{route.purpose_wording}}" and the invoice number as the payment reference.
{{/if}}
Thank you,
${SIGNATURE}`,
  },
};

/** The templates whose text says the invoice is attached. Each must go out with its PDF. */
export function attachesInvoice(template: string | null | undefined): boolean {
  return template === "T1" || template === "T6" || template === "T11";
}

/** T8 is built per run because it lists one line per credit (grouped per bank). */
export function missingDocumentsTemplate(itemCount: number, accountPerLine = false): EmailTemplate {
  const lines = Array.from(
    { length: itemCount },
    (_, i) => `  {{items.${i}.advice_number}}  ${accountPerLine ? `{{items.${i}.account}}  ` : ""}{{items.${i}.value_date}}  {{items.${i}.amount}}  {{items.${i}.needed}}`,
  ).join("\n");
  return {
    key: "T8",
    kind: "bank_email",
    subject: "Request for ePRCs and withholding certificates: {{workspace.legal_name}}",
    body: `Dear Trade Services team,

Please issue the outstanding documents for the following inward remittances to ${accountPerLine ? "the accounts shown" : "our account {{receiving_account.iban}}"}:

${lines}

Regards,
${SIGNATURE}`,
  };
}

/** Digits that may appear in template text itself (data spec section 6 allow-list). */
export const TEMPLATE_ALLOW_LIST = ["MT103"];

const IF_RE = /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

/** Drops `{{#if x}}…{{/if}}` blocks whose value is missing or empty; keeps the inside otherwise. */
export function resolveConditionals(template: string, evidence: Evidence): string {
  return template.replace(IF_RE, (_, key: string, inner: string) => {
    const v = evidence[key];
    const present = !!v && !(v.type === "text" && v.value.trim() === "");
    return present ? inner : "";
  });
}

export interface RenderedEmail {
  subject: string;
  body: string;
  /** The template after conditionals were resolved: what a model rewrite must keep. */
  bodyTemplate: string;
  unknown: string[];
  numbersCheck: NumbersCheckResult;
}

export function renderEmail(t: EmailTemplate, evidence: Evidence, opts: RenderOptions & { allow?: string[]; rewrittenBody?: string } = {}): RenderedEmail {
  const subjectT = resolveConditionals(t.subject, evidence);
  const bodyT = resolveConditionals(t.body, evidence);
  const source = opts.rewrittenBody ?? bodyT;
  const lost = opts.rewrittenBody ? missingPlaceholders(bodyT, opts.rewrittenBody) : [];
  const s = renderTemplate(subjectT, evidence, opts);
  const b = renderTemplate(source, evidence, opts);
  const text = `${s.text}\n${b.text}`;
  return {
    subject: s.text,
    body: b.text.replace(/\n{3,}/g, "\n\n"),
    bodyTemplate: source,
    unknown: [...new Set([...s.unknown, ...b.unknown, ...lost])],
    numbersCheck: checkNumbers(text, evidence, [...TEMPLATE_ALLOW_LIST, ...(opts.allow ?? [])]),
  };
}
