/**
 * A new real workspace from nothing, against the local database: the owner, receiving
 * accounts, clients, then a first invoice that quotes the new account.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientAlias, createDb, createPool, member, purgeWorkspace, receivingAccount, user, workspace, type Db } from "@ebo/db";
import { eq } from "drizzle-orm";
import { addReceivingAccount, createWorkspace, invoicePdf, invoiceRoutes, saveBusinessDetails, saveClient, saveInvoice, saveInvoiceSettings, setAccountActive, documentText, type AccountInput, type ClientInput } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
let db: Db;
const userId = `test-user-${tag}`;
const created: string[] = [];
const ws = async (id: string) => (await db.select().from(workspace).where(eq(workspace.id, id)))[0]!;
const account = (over: Partial<AccountInput>): AccountInput => ({ kind: "pkr_account", label: "", bankName: "Shalimar Bank Ltd", iban: "", swift: "", currency: "PKR", currencies: "", instructions: "", ...over });
const customer = (over: Partial<ClientInput>): ClientInput => ({ name: "Fjord Systems AS", kind: "business", country: "no", currency: "eur", termsDays: "14", preferredRoute: "", contactName: "Ingrid Berg", contactEmails: "ap@fjord.example", aliases: "FJORD SYSTEMS AS", notes: "", ...over });

describe.skipIf(!dbUp)("setting up a new workspace", () => {
  let wsId = "";

  beforeAll(async () => {
    db = createDb(pool);
    await db.insert(user).values({ id: userId, name: "Bilal Ahmed", email: `bilal-${tag}@example.invalid`, emailVerified: false });
  });

  afterAll(async () => {
    if (dbUp) {
      for (const id of created) await purgeWorkspace(db, null, id);
      await db.delete(user).where(eq(user.id, userId));
    }
    await pool.end();
  });

  it("creates the workspace with its owner and a unique address", async () => {
    const a = await createWorkspace(db, { kind: "company", name: `Lahore Apps ${tag}`, legalName: `Lahore Apps ${tag} (Pvt) Ltd`, city: "Lahore" }, { id: userId, name: "Bilal Ahmed" });
    const b = await createWorkspace(db, { kind: "freelancer", name: `Lahore Apps ${tag}`, legalName: "", city: "" }, { id: userId, name: "Bilal Ahmed" });
    if (!a.ok || !b.ok) throw new Error("not created");
    created.push(a.id, b.id);
    wsId = a.id;
    expect(a.slug).toBe(`lahore-apps-${tag}`);
    expect(b.slug).toBe(`lahore-apps-${tag}-2`);
    expect(await ws(a.id)).toMatchObject({ kind: "company", isDemo: false, demoClock: null, legalName: `Lahore Apps ${tag} (Pvt) Ltd`, invoicePrefix: "INV", settings: { senderName: "Bilal Ahmed", senderTitle: "Finance" } });
    expect((await ws(b.id)).invoicePrefix).toBe("LA" + tag.slice(0, 1).toUpperCase().replace(/[^A-Z]/, ""));
    expect((await db.select().from(member).where(eq(member.workspaceId, a.id))).map((m) => [m.userId, m.role])).toEqual([[userId, "owner"]]);
    expect(await createWorkspace(db, { kind: "shop", name: " ", legalName: "", city: "" }, { id: userId, name: "x" })).toEqual({ ok: false, problems: ["Choose a software house or a freelancer.", "Give the workspace a name."] });
  });

  it("business details: plain-word checks, and the email domain follows the mailbox", async () => {
    const w = await ws(wsId);
    const bad = await saveBusinessDetails(db, w, { name: "x", legalName: "", city: "", ntn: "", secpRegNo: "", psebRegNo: "", psebValidUntil: "2026-13-01", atlStatus: "maybe", atlCheckedOn: "", senderName: "", senderTitle: "", phone: "", mailboxAddress: "not-an-email" }, userId);
    expect(bad.ok ? [] : bad.problems).toEqual([
      "The legal name goes on every invoice, so it can't be empty.",
      "The PSEB expiry isn't a date.",
      "Add the PSEB registration number, or clear its expiry date.",
      "Choose the ATL status.",
      "The email address doesn't look right.",
    ]);
    const ok = await saveBusinessDetails(db, w, { name: w.name, legalName: w.legalName!, city: "Lahore", ntn: "SIM-7654321", secpRegNo: "", psebRegNo: "PSEB/SIM/2026/0099", psebValidUntil: "2027-06-30", atlStatus: "active", atlCheckedOn: "2026-11-01", senderName: "Bilal Ahmed", senderTitle: "Director", phone: "", mailboxAddress: "Accounts@LahoreApps.example" }, userId);
    expect(ok.ok).toBe(true);
    expect(await ws(wsId)).toMatchObject({ ntn: "SIM-7654321", psebValidUntil: "2027-06-30", atlStatus: "active", emailDomain: "lahoreapps.example", settings: { senderTitle: "Director", mailboxAddress: "Accounts@LahoreApps.example" } });
  });

  it("receiving accounts: IBANs are checked, duplicates refused, Payoneer needs its details", async () => {
    const w = await ws(wsId);
    const typo = await addReceivingAccount(db, w, account({ iban: "PK34DEMO0001004410001234" }), userId);
    expect(typo).toEqual({ ok: false, problems: ["Check the IBAN: the check digits don't match, so there's probably a typo."] });
    expect(await addReceivingAccount(db, w, account({ kind: "esfca", currency: "PKR", iban: "PK41DEMO0001004470005678" }), userId)).toEqual({ ok: false, problems: ["An ESFCA holds foreign currency, such as USD."] });
    expect(await addReceivingAccount(db, w, account({ iban: "GB82WEST12345698765432" }), userId)).toEqual({ ok: false, problems: ["This should be your Pakistani account, so its IBAN starts with PK."] });
    const pkr = await addReceivingAccount(db, w, account({ label: "Main PKR account", iban: "pk33 demo 0001 0044 1000 1234", swift: "demopkka" }), userId);
    expect(pkr.ok).toBe(true);
    expect(await addReceivingAccount(db, w, account({ iban: "PK33DEMO0001004410001234" }), userId)).toEqual({ ok: false, problems: ['That IBAN is already on file as "Main PKR account".'] });
    expect(await addReceivingAccount(db, w, account({ kind: "payoneer", currency: "USD", currencies: "" }), userId)).toEqual({
      ok: false,
      problems: ["List the currencies your Payoneer account receives, like USD, EUR, GBP.", "Add the receiving details clients need (they're printed on the invoice)."],
    });
    const po = await addReceivingAccount(db, w, account({ kind: "payoneer", currency: "", currencies: "eur, gbp", instructions: "EUR: IBAN DE00 SIM 0000 (SIMULATED)\nGBP: sort code 00-00-00 (SIMULATED)" }), userId);
    expect(po.ok).toBe(true);
    const rows = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, wsId));
    expect(rows.find((r) => r.kind === "pkr_account")).toMatchObject({ iban: "PK33DEMO0001004410001234", swift: "DEMOPKKA", receivingDetails: { paymentInstructions: `Shalimar Bank Ltd, SWIFT DEMOPKKA, IBAN PK33 DEMO 0001 0044 1000 1234 (Main PKR account of ${w.legalName})` } });
    expect(rows.find((r) => r.kind === "payoneer")).toMatchObject({ currency: "EUR", receivingDetails: { currencies: ["EUR", "GBP"] } });
  });

  it("clients: emails and payer names are checked, typed names replaced, learned ones kept", async () => {
    expect(await saveClient(db, wsId, customer({ contactEmails: "ap@fjord.example, nope", currency: "euro" }), userId)).toEqual({ ok: false, problems: ["The currency should be a three-letter code, like USD.", "Not an email address: nope."] });
    const c = await saveClient(db, wsId, customer({}), userId);
    if (!c.ok) throw new Error(c.problems.join(" "));
    expect(await saveClient(db, wsId, customer({}), userId)).toEqual({ ok: false, problems: ['There\'s already a client called "Fjord Systems AS".'] });
    await db.insert(clientAlias).values({ workspaceId: wsId, clientId: c.id, alias: "FJORD SYS", source: "learned" });
    expect((await saveClient(db, wsId, customer({ aliases: "FJORD SYSTEMS NORGE AS" }), userId, c.id)).ok).toBe(true);
    const aliases = await db.select().from(clientAlias).where(eq(clientAlias.clientId, c.id));
    expect(aliases.map((a) => [a.alias, a.source]).sort()).toEqual([
      ["FJORD SYS", "learned"],
      ["FJORD SYSTEMS NORGE AS", "manual"],
    ]);
  });

  it("the first invoice quotes the new account, numbered with the workspace's settings", async () => {
    const w = await ws(wsId);
    expect(await saveInvoiceSettings(db, w, { prefix: "la", nextNumber: "7", purposeWording: "Payment for software development services" }, userId)).toEqual({ ok: true, id: wsId });
    const [c] = await db.select().from((await import("@ebo/db")).client).where(eq((await import("@ebo/db")).client.workspaceId, wsId));
    const routes = await invoiceRoutes(db, wsId, c!.id, "EUR");
    expect(routes.map((r) => [r.route, r.suggested])).toEqual([
      ["payoneer", true],
      ["swift_pkr", false],
    ]);
    const r = await saveInvoice(db, await ws(wsId), { clientId: c!.id, issuedOn: "2026-11-04", termsDays: 14, currency: "EUR", routeChoice: `${routes[0]!.route}:${routes[0]!.accountId}`, purposeWording: "Payment for software development services", lines: [{ description: "Mobile app, phase 1", quantity: "1", unitPrice: "4200" }] }, userId);
    expect(r).toMatchObject({ ok: true, number: "LA-2026-007" });
    const text = (await documentText((await invoicePdf(db, wsId, r.ok ? r.id : ""))!.bytes, "application/pdf"))!.replace(/\s+/g, " ");
    expect(text).toContain("EUR: IBAN DE00 SIM 0000 (SIMULATED)");
    expect(text).not.toContain("SIMULATED - NOT A REAL DOCUMENT"); // a real workspace's invoice isn't marked as a demo
    // Retiring the Payoneer account takes it off new invoices.
    expect(await setAccountActive(db, wsId, routes[0]!.accountId, false, userId)).toBe(true);
    expect((await invoiceRoutes(db, wsId, c!.id, "EUR")).map((o) => o.route)).toEqual(["swift_pkr"]);
  });
});
