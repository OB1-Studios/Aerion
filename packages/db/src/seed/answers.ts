import { createHash } from "node:crypto";
import { formatAmount, formatMoney, type IsoDate } from "@ebo/core";
import type { DocumentKind } from "../schema";
import { creditAdviceText, eprcText, PURPOSE_TEXT, SIMULATED, type AdviceFields, type EprcFields, type Mt103Fields, type ScreenshotFields, type SmsFields, type Truth } from "./documents";
import { FREELANCER_FACTS, freelancerInbox } from "./freelancer";
import type { InboxSpec } from "./helpers";
import { OFFICE_FACTS, officeInbox } from "./office";

/**
 * The answer key (data spec section 14): every document the demo generates, with what a
 * reader should find in it. It is derived from the generator's own inputs, so it can't drift
 * from the files. The stress set renders the same facts in layouts the built-in rules were
 * never written for (another bank, a letter, a noisy scan, other SMS wording), plus advices
 * addressed to someone else. Everything is SIMULATED.
 */

export interface AnswerContext {
  workspaceName: string;
  legalName: string;
  ibans: string[];
  receivedOn: IsoDate;
}

export interface AnswerDoc {
  /** Stable id: set/layout/workspace/date/name. */
  id: string;
  set: "demo" | "stress";
  layout: string;
  workspace: "office" | "freelancer";
  name: string;
  mimeType: string;
  content: string;
  /** The kind a person picked when pasting or uploading it, as in the demo. */
  kindHint: DocumentKind | null;
  context: AnswerContext;
  kind: DocumentKind;
  /** Addressed to this workspace (its IBAN or legal name). Null where it isn't used: screenshots and MT103 copies don't create records. */
  ours: boolean | null;
  /** Every field of the kind's schema; null = not on the document. */
  fields: Record<string, string | null>;
  /** Other readings that are also right, e.g. an SMS's PKR amount given as the amount. */
  alternatives?: Record<string, Array<string | null>>;
}

type Answer = Pick<AnswerDoc, "kind" | "fields" | "alternatives">;

const NO_CREDIT_FIELDS = ["advice_number", "beneficiary_name", "fx_rate_applied", "remitter_bank", "remitter_swift", "ordering_reference", "charges_code", "charges_amount", "charges_currency", "uetr", "corrects_advice_of"];
const smsPurpose = (code: string) => (code === "9471" ? "Home Remittance" : "IT Services Export");

/** What a reader should extract from a generated document, in the field names of the extraction schema. */
export function answerFor(t: Truth): Answer {
  switch (t.type) {
    case "advice": {
      const a = t.fields;
      return {
        kind: "credit_advice",
        fields: {
          advice_number: a.adviceNumber,
          value_date: a.valueDate,
          beneficiary_iban: a.iban,
          beneficiary_name: a.beneficiary,
          amount: a.amount,
          currency: a.currency,
          pkr_amount: a.pkrAmount ?? null,
          fx_rate_applied: a.fxRate ?? null,
          remitter_name: a.remitter,
          remitter_bank: a.remitterBank,
          remitter_swift: a.remitterSwift ?? null,
          ordering_reference: a.reference ?? null,
          charges_code: a.chargesCode ?? null,
          charges_amount: a.chargesAmount ?? null,
          charges_currency: a.chargesAmount ? a.currency : null,
          purpose_code: a.purposeCode,
          purpose_description: PURPOSE_TEXT[a.purposeCode] ?? "OTHER",
          uetr: a.uetr ?? null,
          corrects_advice_of: a.corrects ?? null,
          via: null,
        },
      };
    }
    case "sms": {
      const s = t.fields;
      return {
        kind: "pasted_text",
        fields: {
          ...Object.fromEntries(NO_CREDIT_FIELDS.map((k) => [k, null])),
          value_date: s.date,
          beneficiary_iban: `****${s.accountTail}`,
          amount: null,
          currency: null,
          pkr_amount: s.pkrAmount,
          remitter_name: s.payer,
          purpose_code: s.purposeCode,
          purpose_description: smsPurpose(s.purposeCode),
          via: s.via,
        },
        // The SMS only shows rupees; reading them as the amount, in PKR, is right too.
        alternatives: { amount: [s.pkrAmount], currency: ["PKR"] },
      };
    }
    case "eprc": {
      const e = t.fields;
      return {
        kind: "eprc",
        fields: {
          certificate_number: e.certificateNumber,
          issue_date: e.issueDate,
          exporter_name: e.exporter,
          pseb_number: e.psebRegNo ?? null,
          advice_number: e.adviceNumber,
          value_date: e.valueDate,
          amount: e.amount,
          currency: e.currency,
          pkr_amount: e.pkrAmount ?? null,
          purpose_code: e.purposeCode,
        },
      };
    }
    case "screenshot": {
      const s = t.fields;
      return {
        kind: "screenshot",
        fields: {
          status_text: "Transfer submitted",
          amount: s.amount,
          currency: s.currency,
          beneficiary_name: s.beneficiary,
          beneficiary_account_tail: s.accountTail,
          sent_date: s.date,
          reference: s.reference,
          uetr_or_tracking: null,
        },
      };
    }
    case "mt103": {
      const m = t.fields;
      return { kind: "other", fields: { value_date: m.valueDate, currency: m.currency, amount: m.amount, reference: m.remittanceInfo, uetr: m.uetr } };
    }
  }
}

// ---------------------------------------------------------------------------
// Stress layouts
// ---------------------------------------------------------------------------

const STRESS_BANK = "Margalla Demo Bank Ltd";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parts = (d: IsoDate) => {
  const [y, m, day] = d.split("-");
  return { y: y!, m: Number(m), mm: m!, d: Number(day), dd: day! };
};
/** 27 OCT 2026 */
const dMonY = (iso: IsoDate) => {
  const p = parts(iso);
  return `${p.dd} ${MON[p.m - 1]!.toUpperCase()} ${p.y}`;
};
/** 27 October 2026 */
const longDate = (iso: IsoDate) => {
  const p = parts(iso);
  return `${p.d} ${MONTH[p.m - 1]} ${p.y}`;
};
/** 27/10/2026 */
const slashDate = (iso: IsoDate) => {
  const p = parts(iso);
  return `${p.dd}/${p.mm}/${p.y}`;
};
/** 29-Oct-2026 */
const dashMonY = (iso: IsoDate) => {
  const p = parts(iso);
  return `${p.dd}-${MON[p.m - 1]}-${p.y}`;
};
const groupIban = (iban: string) => iban.replace(/(.{4})/g, "$1 ").trim();

/** Small deterministic generator (mulberry32), so the stress set is the same on every machine. */
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(text: string, width = 78): string {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join("\n");
}

/** Another bank's advice: different labels, dates as 27 OCT 2026, amount after the number. */
function adviceTable(a: AdviceFields): string {
  const row = (label: string, value: string) => `${`${label} `.padEnd(24, ".")} ${value}`;
  const converted = a.pkrAmount ? `PKR ${formatAmount(a.pkrAmount)}${a.fxRate ? ` at ${a.fxRate} per ${a.currency}` : ""}` : `not converted, credited in ${a.currency}`;
  return [
    STRESS_BANK.toUpperCase(),
    "Home Remittance & Trade Operations",
    "FOREIGN INWARD REMITTANCE - CREDIT ADVICE",
    SIMULATED,
    ...(a.corrects ? [`** CORRECTED ADVICE: replaces the advice for the credit of ${dMonY(a.corrects)} **`] : []),
    "",
    row("Our Reference", a.adviceNumber),
    row("Advice Date", dMonY(a.adviceDate)),
    row("Credit Value Date", dMonY(a.valueDate)),
    row("Account Title", a.beneficiary.toUpperCase()),
    row("Account No. / IBAN", a.iban),
    row("Instructed Amount", `${formatAmount(a.amount)} ${a.currency}`),
    row("Converted Amount", converted),
    row("Ordering Customer", a.remitter),
    row("Ordering Institution", a.remitterSwift ? `${a.remitterBank} (BIC ${a.remitterSwift})` : a.remitterBank),
    ...(a.reference ? [row("Remittance Info", a.reference)] : []),
    ...(a.chargesCode ? [row("Details of Charges", a.chargesCode)] : []),
    ...(a.chargesAmount ? [row("Charges Deducted", `${a.currency} ${formatAmount(a.chargesAmount)}`)] : []),
    row("Purpose", `${a.purposeCode} ${PURPOSE_TEXT[a.purposeCode] ?? "OTHER"}`),
    ...(a.uetr ? [row("gpi Tracker (UETR)", a.uetr)] : []),
    "",
    "Please quote our reference in all correspondence.",
    "",
  ].join("\n");
}

/** The same credit written as a letter, the way some branches still send it. */
function adviceLetter(a: AdviceFields): string {
  const charges =
    a.chargesCode === "OUR"
      ? "All charges were paid by the remitter (OUR)."
      : a.chargesCode === "SHA"
        ? `Charges were shared (SHA)${a.chargesAmount ? `; the remitting bank deducted ${formatMoney(a.chargesAmount, a.currency)} before the funds reached us` : ""}.`
        : a.chargesCode === "BEN"
          ? `Charges were for your account (BEN)${a.chargesAmount ? `: ${formatMoney(a.chargesAmount, a.currency)}` : ""}.`
          : a.chargesAmount
            ? `The remitting bank deducted ${formatMoney(a.chargesAmount, a.currency)} in charges.`
            : "";
  const credited = a.pkrAmount
    ? a.currency === "PKR"
      ? ` The amount credited is PKR ${formatAmount(a.pkrAmount)}.`
      : ` It was converted at PKR ${a.fxRate} per ${a.currency}, and PKR ${formatAmount(a.pkrAmount)} has been credited.`
    : "";
  const body = [
    `We are pleased to advise that an inward remittance of ${formatMoney(a.amount, a.currency)} from ${a.remitter}, sent through ${a.remitterBank}${a.remitterSwift ? ` (SWIFT: ${a.remitterSwift})` : ""}, has been credited to your account ${groupIban(a.iban)} with value date ${longDate(a.valueDate)}.${credited}`,
    a.reference ? `The remitter's payment details read "${a.reference}".` : "",
    charges,
    `The remittance has been reported under purpose code ${a.purposeCode} (${(PURPOSE_TEXT[a.purposeCode] ?? "other").toLowerCase()}).`,
    a.uetr ? `SWIFT gpi reference (UETR): ${a.uetr}.` : "",
    a.corrects ? `This letter corrects our earlier advice for the credit of ${longDate(a.corrects)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    SIMULATED,
    `${STRESS_BANK} - Trade Services Division`,
    longDate(a.adviceDate),
    "",
    "The Manager Finance",
    a.beneficiary,
    "",
    `Subject: Credit of inward remittance (our ref. ${a.adviceNumber})${a.corrects ? " - CORRECTED" : ""}`,
    "",
    "Dear Sir/Madam,",
    "",
    wrap(body),
    "",
    "Yours faithfully,",
    "Trade Services",
    STRESS_BANK,
    "",
  ].join("\n");
}

const OCR: Record<string, string> = { i: "1", l: "1", o: "0", e: "c", m: "rn", g: "q", S: "5", O: "0", B: "8" };

/**
 * A scan run through OCR: misread letters in the labels, separators and spacing lost, dates
 * and amounts printed differently. Values keep their meaning, so the answer doesn't change.
 */
function scanned(text: string, seed: string): string {
  const r = rng(seed);
  const garble = (s: string, p: number) => s.replace(/[A-Za-z]/g, (c) => (r() < p ? (OCR[c] ?? c) : c));
  const lines = text.split("\n").map((line) => {
    if (line.includes(SIMULATED)) return line;
    if (/^-{10,}$/.test(line)) return r() < 0.5 ? "_".repeat(30 + Math.floor(r() * 30)) : "";
    const i = line.indexOf(": ");
    if (i < 0) return garble(line, 0.05);
    const label = line.slice(0, i).trimEnd();
    let value = line.slice(i + 2);
    value = value.replace(/^([A-Z]{3}) (\d)/, (_, c: string, d: string) => (r() < 0.5 ? `${c}${d}` : `${c} ${d}`));
    value = value.replace(/^(\d{2})-(\d{2})-(\d{4})$/, (_, d: string, m: string, y: string) => (r() < 0.5 ? `${d}/${m}/${y}` : `${d}.${m}.${y}`));
    if (/^PK\d{2}( [A-Z0-9]{4})+$/.test(value) && r() < 0.5) value = value.replace(/ /g, "");
    const sep = r() < 0.3 ? " ; " : r() < 0.5 ? ":" : " : ";
    return `${r() < 0.15 ? "| " : ""}${garble(label, 0.12)}${sep}${value}`;
  });
  return `${lines.join("\n")}${r() < 0.5 ? "\nPage 1 of 1\n" : ""}`;
}

function eprcOther(e: EprcFields): string {
  return [
    STRESS_BANK.toUpperCase(),
    "PROCEEDS REALIZATION CERTIFICATE (e-PRC)",
    SIMULATED,
    "",
    `PRC No: ${e.certificateNumber}          Date of Issue: ${slashDate(e.issueDate)}`,
    `Name of Exporter: ${e.exporter.toUpperCase()}`,
    `NTN: ${e.ntn ?? "-"}          PSEB Reg. No: ${e.psebRegNo ?? "-"}`,
    `Remittance Ref: ${e.adviceNumber}          Realized on: ${dMonY(e.valueDate)}`,
    `FCY Amount: ${e.currency} ${formatAmount(e.amount)}          PKR Equivalent: ${e.pkrAmount ? formatAmount(e.pkrAmount) : "-"}`,
    `Purpose Code: ${e.purposeCode} (${PURPOSE_TEXT[e.purposeCode] ?? "OTHER"})`,
    "",
    "Certified that the above proceeds have been realized through normal banking channels.",
    "",
  ].join("\n");
}

const smsOther = (s: SmsFields) =>
  `Dear Customer, your A/C ****${s.accountTail} has been credited with PKR ${formatAmount(s.pkrAmount)} on ${dashMonY(s.date)}. Sender: ${s.payer} via ${s.via}. Purpose: ${s.purposeCode}-${smsPurpose(s.purposeCode)}. ${STRESS_BANK} (SIMULATED)`;

const smsRomanUrdu = (s: SmsFields) =>
  `Mohtaram Customer, aap ke A/C ****${s.accountTail} mein PKR ${formatAmount(s.pkrAmount)} jama ho gaye hain. Bhejne wala: ${s.payer} (${s.via}). Tareekh: ${slashDate(s.date)}. Purpose code ${s.purposeCode} (${smsPurpose(s.purposeCode)}). Shukriya, ${STRESS_BANK} (SIMULATED)`;

function screenshotOther(s: ScreenshotFields): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const p = parts(s.date);
  const rows: Array<[string, string]> = [
    ["Recipient", s.beneficiary.toUpperCase()],
    ["Account", `•••• ${s.accountTail}`],
    ["Sent", `${p.d} ${MON[p.m - 1]} ${p.y}`],
    ["Your reference", s.reference],
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="560" viewBox="0 0 390 560" font-family="Helvetica, Arial, sans-serif">
  <rect width="390" height="560" fill="#ffffff"/>
  <text x="24" y="56" font-size="22" font-weight="bold" fill="#111827">Payment sent</text>
  <text x="24" y="104" font-size="34" fill="#111827">${esc(formatAmount(s.amount))} ${esc(s.currency)}</text>
${rows.map(([k, v], i) => `  <text x="24" y="${170 + i * 56}" font-size="12" fill="#6b7280">${esc(k)}</text>\n  <text x="24" y="${190 + i * 56}" font-size="15" fill="#111827">${esc(v)}</text>`).join("\n")}
  <text x="24" y="520" font-size="11" fill="#b42318">${SIMULATED}</text>
</svg>
`;
}

function mt103Printed(m: Mt103Fields): string {
  return [
    "SWIFT MESSAGE COPY - MT103 SINGLE CUSTOMER CREDIT TRANSFER",
    SIMULATED,
    `Sender: ${m.senderSwift}     Message type: 103     Priority: Normal`,
    "",
    `F20  Sender's Reference .............. ${m.reference}`,
    "F23B Bank Operation Code ............. CRED",
    `F32A Value Date / Currency / Amount .. ${dMonY(m.valueDate)} / ${m.currency} / ${formatAmount(m.amount)}`,
    `F50K Ordering Customer ............... ${m.orderingCustomer}`,
    `F59  Beneficiary Customer ............ /${m.beneficiaryIban}`,
    `                                       ${m.beneficiary.toUpperCase()}`,
    `F70  Remittance Information .......... ${m.remittanceInfo}`,
    "F71A Details of Charges .............. OUR",
    `UETR: ${m.uetr}`,
    "",
  ].join("\n");
}

/** A valid Pakistani IBAN (ISO 13616 check digits) for a fictional account. */
export function pkIban(bank: string, account: string): string {
  const bban = `${bank}${account}`;
  const digits = `${bban}PK00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of digits) mod = (mod * 10 + Number(ch)) % 97;
  return `PK${String(98 - mod).padStart(2, "0")}${bban}`;
}

/** Someone else's account at the demo bank: the advice is real-looking but not ours. */
const NOT_OURS = { beneficiary: "Lyallpur Demo Textiles (Pvt) Ltd", iban: pkIban("DEMO", "0003008810004321") };

interface Variant {
  layout: string;
  name: string;
  mimeType: string;
  content: string;
  /** Fields that read differently in this layout. */
  fields?: Record<string, string | null>;
  ours?: boolean;
}

function variants(t: Truth, name: string): Variant[] {
  const txt = (layout: string, content: string, extra: Partial<Variant> = {}): Variant => ({ layout, name, mimeType: "text/plain", content, ...extra });
  switch (t.type) {
    case "advice":
      return [txt("other bank", adviceTable(t.fields)), txt("letter", adviceLetter(t.fields)), txt("scanned", scanned(creditAdviceText(t.fields), name))];
    case "eprc":
      return [txt("other bank", eprcOther(t.fields)), txt("scanned", scanned(eprcText(t.fields), name))];
    case "sms":
      return [txt("other bank SMS", smsOther(t.fields)), txt("Roman Urdu SMS", smsRomanUrdu(t.fields))];
    case "screenshot":
      return [{ layout: "other app", name: name.replace(/\.svg$/, "-app.svg"), mimeType: "image/svg+xml", content: screenshotOther(t.fields), fields: { status_text: "Payment sent" } }];
    case "mt103":
      return [txt("printed MT103", mt103Printed(t.fields))];
  }
}

/** Kinds whose owner decides whether they become records. */
const OWNED_KINDS = new Set<DocumentKind>(["credit_advice", "pasted_text", "eprc"]);

/** Karachi date of a moment (the demo clock runs in PKT, UTC+5, no daylight saving). */
const pktDate = (at: Date): IsoDate => new Date(at.getTime() + 5 * 3600_000).toISOString().slice(0, 10);

export interface AnswerKeyOptions {
  /** Include the stress set (default true). */
  stress?: boolean;
}

/** Every generated document with its answer: the demo set, then the stress set. */
export function answerKey(opts: AnswerKeyOptions = {}): AnswerDoc[] {
  const sources: Array<{ workspace: AnswerDoc["workspace"]; items: InboxSpec[]; context: (on: IsoDate) => AnswerContext }> = [
    { workspace: "office", items: officeInbox(), context: (on) => ({ workspaceName: OFFICE_FACTS.workspaceName, legalName: OFFICE_FACTS.legalName, ibans: [OFFICE_FACTS.ibanPkr, OFFICE_FACTS.ibanEsfca], receivedOn: on }) },
    { workspace: "freelancer", items: freelancerInbox(), context: (on) => ({ workspaceName: FREELANCER_FACTS.workspaceName, legalName: FREELANCER_FACTS.legalName, ibans: [FREELANCER_FACTS.iban], receivedOn: on }) },
  ];
  const demo: AnswerDoc[] = [];
  const stress: AnswerDoc[] = [];
  let notOurs = 0;
  for (const src of sources) {
    for (const item of src.items) {
      for (const file of item.attachments) {
        if (!file.truth) continue;
        const on = pktDate(item.at);
        const common = { workspace: src.workspace, context: src.context(on), kindHint: item.kindHint ?? null };
        const answer = answerFor(file.truth);
        demo.push({ id: `demo/demo bank/${src.workspace}/${on}/${file.name}`, set: "demo", layout: "demo bank", name: file.name, mimeType: file.mimeType, content: file.content, ours: OWNED_KINDS.has(answer.kind) ? true : null, ...answer, ...common });
        if (opts.stress === false) continue;
        for (const v of variants(file.truth, file.name)) {
          stress.push({ id: `stress/${v.layout}/${src.workspace}/${on}/${v.name}`, set: "stress", layout: v.layout, name: v.name, mimeType: v.mimeType, content: v.content, ours: OWNED_KINDS.has(answer.kind) ? (v.ours ?? true) : null, ...answer, fields: { ...answer.fields, ...v.fields }, ...common });
        }
        // Three foreign-currency advices sent to us by mistake: right bank, someone else's account.
        if (file.truth.type === "advice" && src.workspace === "office" && file.truth.fields.currency !== "PKR" && !file.truth.fields.corrects && notOurs < 3) {
          notOurs++;
          const other: AdviceFields = { ...file.truth.fields, ...NOT_OURS };
          const name = `advice-${other.adviceNumber}-misdirected.txt`;
          const a = answerFor({ type: "advice", fields: other });
          stress.push({ id: `stress/not ours/${src.workspace}/${on}/${name}`, set: "stress", layout: "not ours", name, mimeType: "text/plain", content: creditAdviceText(other), ours: false, ...a, ...common });
        }
      }
    }
  }
  return [...demo, ...stress];
}
