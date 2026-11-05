import type { PDFFont } from "pdf-lib";

/** Standard PDF fonts only cover Windows-1252; anything else becomes "?". */
const WIN_ANSI_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
export const pdfSafe = (s: string) => [...s.replace(/\t/g, " ")].map((ch) => ((ch >= " " && ch <= "~") || (ch >= " " && ch <= "ÿ") || WIN_ANSI_EXTRA.has(ch) ? ch : "?")).join("");

/** Breaks text into lines that fit `width` at `size`, keeping the text's own line breaks. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}
