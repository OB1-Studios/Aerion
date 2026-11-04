import "server-only";
import type { Db } from "@ebo/db";
import { invoiceRoutes } from "@ebo/engine";
import { Field } from "@/components/form-problems";
import { CURRENCIES } from "@/lib/forms";
import type { RouteChoice } from "./invoice-form";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A currency from the address bar, if it looks like one. */
export const cleanCurrency = (s: string | undefined) => (s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null);

/** How many empty line rows to start with (?lines=, for browsers without JavaScript). */
export const startingLines = (s: string | undefined, have = 0) => Math.min(30, Math.max(have, Number.parseInt(s ?? "", 10) || (have ? have : 3)));

/** The route picker's choices for this client and currency, with the suggestion and its reason. */
export async function routeChoices(db: Db, workspaceId: string, clientId: string, currency: string): Promise<RouteChoice[]> {
  const options = await invoiceRoutes(db, workspaceId, clientId, currency);
  return options.map((o) => ({ value: `${o.route}:${o.accountId}`, label: o.label, reason: o.reason, suggested: o.suggested }));
}

/** Reloads the editor in another currency (the routes depend on it). A plain GET form, so it works without JavaScript. */
export function CurrencySwitch({ clientId, currency, also = [] }: { clientId: string; currency: string; also?: string[] }) {
  const choices = [...new Set([currency, ...also, ...CURRENCIES])];
  return (
    <form method="get" className="mb-6 flex flex-wrap items-end gap-2 border-b border-line pb-4">
      <input type="hidden" name="client" value={clientId} />
      <Field label="Invoice currency">
        <select name="currency" defaultValue={currency} className="input">
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="btn btn-secondary">
        Change currency
      </button>
      <span className="pb-2 text-xs text-muted">Changing it reloads the form, so do it before typing the lines.</span>
    </form>
  );
}
