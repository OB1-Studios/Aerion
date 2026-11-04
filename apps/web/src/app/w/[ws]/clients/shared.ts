import "server-only";
import { ROUTE_LABELS } from "@ebo/core";
import { COUNTRIES, countryName, CURRENCIES } from "@/lib/forms";

/** Choices for the client form, rendered on the server. */
export function clientFormChoices() {
  return {
    countries: COUNTRIES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name)),
    currencies: CURRENCIES,
    routes: (Object.keys(ROUTE_LABELS) as Array<keyof typeof ROUTE_LABELS>).filter((r) => r !== "other").map((r) => ({ value: r, label: ROUTE_LABELS[r] })),
  };
}
