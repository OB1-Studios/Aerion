const HONORIFICS = new Set(["MR", "MRS", "MS", "MISS", "DR", "PROF", "SIR"]);

/**
 * Payer names as banks print them ("AL NOOR TRADING FZ LLC") compared with names
 * as people type them ("Al Noor Trading FZ-LLC"): upper case, accents removed,
 * "&" as "AND", punctuation as spaces, a leading title dropped.
 */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1 && HONORIFICS.has(words[0]!)) words.shift();
  return words.join(" ");
}

export function normalizeRef(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Does a payment reference mention this invoice number? Separators are ignored
 * ("INV 2026-026" mentions INV-2026-026), but a match may not run on into more
 * digits ("INV-2026-0251" does not mention INV-2026-025).
 */
export function referenceMentionsInvoice(reference: string | null | undefined, invoiceNumber: string): boolean {
  const ref = normalizeRef(reference);
  const inv = normalizeRef(invoiceNumber);
  if (!ref || !inv) return false;
  let idx = ref.indexOf(inv);
  while (idx !== -1) {
    const after = ref[idx + inv.length];
    if (after === undefined || !/[0-9]/.test(after)) return true;
    idx = ref.indexOf(inv, idx + 1);
  }
  return false;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** "ravicodework.example" looks like "ravicodeworks.example" (one letter missing). */
export function isLookalikeDomain(candidate: string | null | undefined, own: string | null | undefined, maxDistance: number): boolean {
  const c = (candidate ?? "").toLowerCase().trim();
  const o = (own ?? "").toLowerCase().trim();
  if (!c || !o || c === o) return false;
  return levenshtein(c, o) <= maxDistance;
}

export function emailDomain(address: string | null | undefined): string {
  const at = (address ?? "").lastIndexOf("@");
  return at === -1 ? "" : (address ?? "").slice(at + 1).replace(/>$/, "").toLowerCase().trim();
}
