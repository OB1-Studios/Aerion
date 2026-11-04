import { addDays, weekday, type IsoDate } from "@ebo/core";
import { parseAmount, parseDate } from "./text";
import type { Intent, IntentReader, IntentResult, MessageInput } from "./types";

/**
 * Offline intent rules for inbound email (build kit section 3.7). Emails come from outsiders:
 * they are classified, never followed. The model reader returns the same shape.
 */

const INVOICE_RE = /\bINV[-\s]?(?:[A-Z]{2}[-\s]?)?\d{4}[-\s]?\d{3}\b/gi;
const MONEY_RE = /\b(USD|EUR|GBP|AUD|CAD|PKR)\s?([\d,]+(?:\.\d{1,2})?)\b/;
const UETR_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const FORWARD_SPLIT = /^-{3,}\s*Forwarded message\s*-{3,}$/im;

const BANK_CHANGE = /\b(bank|account) details (have |has )?changed\b|\bnew (bank|account) details\b|\bour new account\b|\bupdate your (vendor )?records\b|\bchanged? (our|of) bank\b/i;
const CLAIM = /\b(payment|wire|transfer|remittance)\s+(was\s+|has been\s+)?(sent|made|initiated|submitted|released)\b|\bwe(?:'ve| have)?\s+(paid|sent|remitted|wired)\b|\bpaid (today|yesterday|this morning)\b/i;
const PROMISE = /\bwill (send|pay|transfer|remit|wire|release)\b|\bpromise to pay\b/i;
const DISPUTE = /\bdispute\b|\bnot (happy|satisfied)\b|\bincorrect (invoice|amount)\b|\bwrong amount\b|\bdid not receive the (work|service)\b/i;

/** Sentences of a text, keeping the original wording for quotes. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

function relativeDate(sentence: string, received: IsoDate): IsoDate | null {
  const s = sentence.toLowerCase();
  if (/\btoday\b|\bthis morning\b/.test(s)) return received;
  if (/\byesterday\b/.test(s)) return addDays(received, -1);
  if (/\bthis week\b/.test(s)) return addDays(received, Math.max(0, 5 - weekday(received))); // Friday
  if (/\bnext week\b/.test(s)) return addDays(received, 12 - weekday(received));
  const explicit = /\b(?:on|by|before)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{2}[-/.]\d{2}[-/.]\d{4}|\d{4}-\d{2}-\d{2})/i.exec(sentence);
  return explicit ? parseDate(explicit[1]!.replace(/,/g, "")) : null;
}

export function readIntentsOffline(msg: MessageInput): IntentResult {
  const body = msg.body ?? "";
  const [own = "", forwarded = ""] = body.split(FORWARD_SPLIT);
  const subject = msg.subject ?? "";
  const numbers = [...new Set([...`${subject}\n${own}`.matchAll(INVOICE_RE)].map((m) => m[0].toUpperCase().replace(/\s+/g, "-")))];
  const intents: Intent[] = [];
  const add = (kind: Intent["kind"], sentence: string, date: IsoDate | null) => {
    const money = MONEY_RE.exec(sentence);
    intents.push({ kind, invoiceNumbers: numbers, amount: money ? parseAmount(money[2]) : null, currency: money?.[1] ?? null, date, quote: sentence });
  };

  for (const s of sentences(own)) {
    if (CLAIM.test(s)) add("payment_claim", s, relativeDate(s, msg.receivedOn) ?? msg.receivedOn);
    else if (PROMISE.test(s)) add("promise_to_pay", s, relativeDate(s, msg.receivedOn));
    else if (DISPUTE.test(s)) add("dispute", s, null);
  }
  const bankSentence = sentences(body).find((s) => BANK_CHANGE.test(s));
  if (bankSentence) add("bank_detail_change", bankSentence, null);
  const uetr = UETR_RE.exec(body)?.[0] ?? null;
  const mt = sentences(own).find((s) => /\bMT103\b|\bUETR\b/i.test(s));
  if (mt) add("remittance_advice", mt, null);
  if (!intents.length && /\?/.test(own)) {
    const q = sentences(own).find((s) => s.endsWith("?"));
    if (q) add("question", q, null);
  }

  const forwardedFrom = /^From:.*?<?([\w.+-]+@[\w.-]+)>?\s*$/im.exec(forwarded)?.[1]?.toLowerCase() ?? null;
  const ask = sentences(own).find((s) => s.endsWith("?")) ?? null;
  return { intents, mentionsNewBankDetails: !!bankSentence, forwardedFrom, uetr, requestsActionFromUs: ask };
}

export const offlineIntentReader: IntentReader = {
  name: "offline",
  async read(msg) {
    return { result: readIntentsOffline(msg), model: "offline-rules", promptVersion: "intent.offline.v1", calls: [] };
  },
};
