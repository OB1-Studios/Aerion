import { describe, expect, it } from "vitest";
import { documentText, PDF_MAX_PAGES, simplePdf } from "../src/index";

describe("PDF text layer", () => {
  it("reads the lines a PDF draws, in order", async () => {
    const pdf = simplePdf(["CREDIT ADVICE (SIMULATED)", "Amount: USD 1,250.00", "Purpose code: 9186 (a) \\ test"]);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe("%PDF-1.4");
    const text = await documentText(pdf, "application/pdf");
    expect(text?.split("\n")).toEqual(["CREDIT ADVICE (SIMULATED)", "Amount: USD 1,250.00", "Purpose code: 9186 (a) \\ test"]);
  });

  it("returns null for a PDF with no text (a scan needs a person or OCR)", async () => {
    expect(await documentText(simplePdf([]), "application/pdf")).toBeNull();
  });

  it(`reads only the first ${PDF_MAX_PAGES} pages of a long PDF`, async () => {
    const lines = Array.from({ length: 52 * 12 }, (_, i) => `line ${i + 1}`);
    const text = (await documentText(simplePdf(lines), "application/pdf")) ?? "";
    expect(text).toContain(`line ${52 * PDF_MAX_PAGES}`);
    expect(text).not.toContain(`line ${52 * PDF_MAX_PAGES + 1}`);
  });

  it("still reads text formats directly", async () => {
    expect(await documentText(new TextEncoder().encode("a,b\n1,2"), "text/csv")).toBe("a,b\n1,2");
    expect(await documentText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBeNull();
  });
});
