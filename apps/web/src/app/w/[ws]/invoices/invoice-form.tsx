"use client";

import { useActionState, useState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

export interface RouteChoice {
  value: string;
  label: string;
  reason: string;
  suggested: boolean;
}

export interface InvoiceFormProps {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: Record<string, string>;
  lines: Array<{ description: string; quantity: string; unitPrice: string }>;
  lineCount: number;
  routes: RouteChoice[];
  currency: string;
  submitLabel: string;
}

const splitLines = (s: string | undefined, n: number) => {
  const xs = (s ?? "").split("\n");
  return Array.from({ length: n }, (_, i) => xs[i] ?? "");
};

/** The running total shown under the lines (the server works it out again, exactly, on save). */
function sum(quantities: string[], prices: string[]): number {
  return prices.reduce((t, price, i) => {
    const unit = Number(price.replace(/,/g, ""));
    const qty = Number((quantities[i] ?? "").replace(/,/g, "") || (price ? "1" : "0"));
    return Number.isFinite(unit) && Number.isFinite(qty) ? t + Math.round(unit * qty * 100) / 100 : t;
  }, 0);
}

function totalOf(form: HTMLFormElement): number {
  const fd = new FormData(form);
  return sum(fd.getAll("quantity").map(String), fd.getAll("unitPrice").map(String));
}

/** The invoice editor: lines, dates, how the client pays (with the agent's suggestion and reason), purpose wording. */
export function InvoiceForm({ action, initial, lines, lineCount, routes, currency, submitLabel }: InvoiceFormProps) {
  const [state, formAction] = useActionState(action, FORM_START);
  const [count, setCount] = useState(Math.max(lineCount, lines.length));
  const v = state.values ?? initial;
  const n = Math.max(count, state.values ? (v.description ?? "").split("\n").length : 0);
  const desc = state.values ? splitLines(v.description, n) : Array.from({ length: n }, (_, i) => lines[i]?.description ?? "");
  const qty = state.values ? splitLines(v.quantity, n) : Array.from({ length: n }, (_, i) => lines[i]?.quantity ?? "");
  const price = state.values ? splitLines(v.unitPrice, n) : Array.from({ length: n }, (_, i) => lines[i]?.unitPrice ?? "");
  const chosen = routes.some((r) => r.value === v.route) ? v.route : (routes.find((r) => r.suggested)?.value ?? "");
  const [total, setTotal] = useState(() => sum(qty, price));
  const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <form action={formAction} key={JSON.stringify(state.values)} onInput={(e) => setTotal(totalOf(e.currentTarget))} className="space-y-6">
      <FormProblems problems={state.problems} />
      <input type="hidden" name="clientId" value={v.clientId ?? ""} />
      <input type="hidden" name="currency" value={currency} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Issued on">
          <input type="date" name="issuedOn" defaultValue={v.issuedOn ?? ""} required className="input w-full" />
        </Field>
        <Field label="Payment terms (days)">
          <input type="number" name="termsDays" min={0} max={365} defaultValue={v.termsDays ?? "30"} className="input w-full" />
        </Field>
        <Field label="Currency">
          <input value={currency} readOnly aria-readonly className="input w-full bg-canvas text-muted" />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink">Lines</legend>
        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(0,1fr)_6rem_9rem] gap-2 text-xs text-muted sm:grid">
            <span>Description</span>
            <span>Quantity</span>
            <span>Unit price ({currency})</span>
          </div>
          {desc.map((d, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_9rem]">
              <input name="description" defaultValue={d} placeholder={i === 0 ? "Monthly retainer, November" : ""} aria-label={`Line ${i + 1} description`} className="input w-full min-w-0" />
              <input name="quantity" defaultValue={qty[i]} placeholder="1" inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="input w-full min-w-0 text-right" />
              <input name="unitPrice" defaultValue={price[i]} placeholder="0.00" inputMode="decimal" aria-label={`Line ${i + 1} unit price`} className="input w-full min-w-0 text-right" />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3 text-sm">
          {n < 30 ? (
            <button type="button" onClick={() => setCount(n + 1)} className="btn btn-secondary">
              Add a line
            </button>
          ) : (
            <span />
          )}
          <span className="ml-auto text-muted">Total</span>
          <span className="text-lg font-semibold tabular-nums">
            {currency} {fmt.format(total)}
          </span>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink">How the client pays</legend>
        {routes.length ? (
          <div className="space-y-2">
            {routes.map((r) => (
              <label key={r.value} className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/5">
                <input type="radio" name="route" value={r.value} defaultChecked={r.value === chosen} className="mt-1" />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    {r.label}
                    {r.suggested ? <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">Suggested</span> : null}
                  </span>
                  <span className="mt-0.5 block text-muted">{r.reason}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-danger">None of your receiving accounts can take {currency}. Add one in Setup first.</p>
        )}
      </fieldset>

      <Field label="Purpose of payment" hint="Printed on the invoice and quoted in the email, so the bank reports the money as an IT export.">
        <input name="purposeWording" defaultValue={v.purposeWording ?? ""} maxLength={200} className="input w-full" />
      </Field>

      <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}
