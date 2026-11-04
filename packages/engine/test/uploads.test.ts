import { describe, expect, it } from "vitest";
import { checkUpload, cleanName, simplePdf, UPLOAD_MAX_BYTES } from "../src/index";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("uploaded files are identified by their bytes", () => {
  it("recognises PDFs and images whatever they are called", () => {
    expect(checkUpload("advice.txt", simplePdf(["x"]))).toEqual({ ok: true, mimeType: "application/pdf", name: "advice.txt" });
    expect(checkUpload("a.pdf", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toMatchObject({ ok: true, mimeType: "image/png" });
    expect(checkUpload("a", bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ ok: true, mimeType: "image/jpeg" });
    expect(checkUpload("a", text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toMatchObject({ ok: true, mimeType: "image/webp" });
  });

  it("text files: SVG by content, CSV by name, anything else plain text", () => {
    expect(checkUpload("shot", text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toMatchObject({ mimeType: "image/svg+xml" });
    expect(checkUpload("payoneer.CSV", text("Date,Amount\n2026-10-01,10"))).toMatchObject({ mimeType: "text/csv" });
    expect(checkUpload("sms", text("PKR 150,000 credited to A/C ****1234"))).toMatchObject({ mimeType: "text/plain" });
  });

  it("refuses web pages, binaries, empty and oversized files", () => {
    expect(checkUpload("page.txt", text("<!DOCTYPE html><html><body>hi</body></html>"))).toMatchObject({ ok: false });
    expect(checkUpload("a.exe", bytes(0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe))).toEqual({ ok: false, reason: "isn't a PDF, an image or a text file" });
    expect(checkUpload("nul.txt", text("a\u0000b"))).toMatchObject({ ok: false });
    expect(checkUpload("empty.pdf", new Uint8Array())).toEqual({ ok: false, reason: "is empty" });
    expect(checkUpload("big.txt", new Uint8Array(UPLOAD_MAX_BYTES + 1).fill(65))).toMatchObject({ ok: false, reason: "is over 10 MB" });
  });

  it("keeps only a safe base name", () => {
    expect(cleanName("C:\\Users\\me\\Downloads\\advice.pdf")).toBe("advice.pdf");
    expect(cleanName("../../etc/passwd")).toBe("passwd");
    expect(cleanName("a\u0007b\nc.pdf")).toBe("abc.pdf");
    expect(cleanName("   ")).toBe("upload");
    expect(cleanName(`${"x".repeat(200)}.pdf`)).toHaveLength(120);
  });
});
