import "server-only";
import { encode } from "uqr";

/**
 * A QR code as a small SVG: one path, with each row's dark modules merged into runs.
 * Always dark on white, in dark mode too, so any phone camera can read it.
 */
export function qrSvg(text: string, label: string): string {
  const { data, size } = encode(text, { ecc: "M", border: 4 });
  let d = "";
  data.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  const safe = label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
