/** Shared by forms and their server actions: what was typed, and why it can't be saved yet. */
export interface FormState {
  problems: string[];
  values: Record<string, string> | null;
  /** Set when a form that stays on the page saved successfully. */
  saved?: number;
  /** Something to show after saving, such as an invitation link to copy. */
  notice?: string;
}

export const FORM_START: FormState = { problems: [], values: null };

/** Every text field of a form, for showing back what the person typed. */
export function formValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = out[k] != null ? `${out[k]}\n${v}` : v;
  return out;
}

/** Export markets Pakistani IT businesses invoice most, by name. Any other country can be typed as a code. */
export const COUNTRIES = ["US", "GB", "CA", "AU", "NZ", "IE", "DE", "NL", "FR", "BE", "LU", "AT", "CH", "SE", "NO", "DK", "FI", "ES", "IT", "PT", "PL", "EE", "AE", "SA", "QA", "KW", "BH", "OM", "SG", "MY", "JP", "HK", "TR"];

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "AED", "SAR", "QAR", "SGD", "JPY", "PKR"];

export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
