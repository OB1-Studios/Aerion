// Builds the project page that .github/workflows/pages.yml publishes to GitHub Pages: the README,
// rendered by GitHub's Markdown API, so it reads as it does on the repository page.
//
// GitHub Pages only serves static files. The app itself needs a server, a worker and a database,
// so it runs on Vultr (see "Deploy on Vultr" in the README).
//
//   node scripts/build-site.mjs    writes _site/
//
// GITHUB_TOKEN is optional locally, where the API allows 60 anonymous calls an hour.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "_site");
const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY ?? "code-breakers-4/IT-Export-Back-Office"}`;

const response = await fetch("https://api.github.com/markdown", {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
  body: JSON.stringify({ text: readFileSync(join(root, "README.md"), "utf8"), mode: "markdown" }),
});
if (!response.ok) throw new Error(`GitHub's Markdown API answered ${response.status}: ${await response.text()}`);

const readme = (await response.text())
  // On github.com a script maps #the-problem to these ids. This page has no script.
  .replaceAll('id="user-content-', 'id="')
  // The API leaves alerts (> [!NOTE]) as plain quotes.
  .replace(
    /<blockquote>\n<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n([\s\S]*?)<\/blockquote>/g,
    (_, kind, rest) => `<div class="alert alert-${kind.toLowerCase()}">\n<p class="alert-title">${kind[0]}${kind.slice(1).toLowerCase()}</p>\n<p>${rest}</div>`,
  )
  // A relative link to a file in the repo only works on github.com. The assets are published with the page.
  .replace(/href="(?!https?:|mailto:|#|assets\/)([^"]+)"/g, `href="${repoUrl}/blob/main/$1"`);

// The app's own mark, so the tab looks the same on both.
const icon = `data:image/svg+xml,${encodeURIComponent(readFileSync(join(root, "apps/web/src/app/icon.svg"), "utf8").trim())}`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aerion</title>
<meta name="description" content="Aerion runs the weekly finance back office for Pakistani software houses and IT freelancers. It never moves money.">
<link rel="icon" href="${icon}">
<style>
:root {
  color-scheme: light dark;
  /* The app's palette (apps/web/src/app/globals.css). */
  --ink: #17201c;
  --muted: #5d6964;
  --line: #e4e1d9;
  --panel: #ffffff;
  --canvas: #f4f3ee;
  --link: #1d5c48;
  --accent: #9a6b2f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e6e9e4;
    --muted: #9ba6a0;
    --line: #26302b;
    --panel: #151b18;
    --canvas: #0d1210;
    --link: #5fb596;
    --accent: #c99a5b;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 1rem; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 1rem/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--link); }
.bar { border-bottom: 1px solid var(--line); background: var(--panel); }
.bar div { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.25rem 1rem; max-width: 60rem; margin: 0 auto; padding: 0.75rem 1rem; }
.bar h1 { margin: 0; font-size: 1rem; font-weight: 600; }
main { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; overflow-wrap: break-word; }
img { max-width: 100%; height: auto; }
/* The screenshots share the page's background; an edge keeps them apart. */
img[src^="assets/screen-"] { border: 1px solid var(--line); border-radius: 8px; }
div[align="center"] p { margin: 0; }
hr { margin: 2.5rem 0; border: 0; border-top: 1px solid var(--line); }
.markdown-heading { display: flex; align-items: baseline; gap: 0.5rem; margin: 2rem 0 1rem; }
.markdown-heading h2, .markdown-heading h3 { margin: 0; line-height: 1.25; }
.markdown-heading h2 { font-size: 1.6rem; }
.markdown-heading h3 { font-size: 1.2rem; }
.anchor { color: var(--muted); text-decoration: none; opacity: 0; }
.markdown-heading:hover .anchor, .anchor:focus { opacity: 1; }
.octicon-link::before { content: "#"; }
table { display: block; width: max-content; max-width: 100%; margin: 1rem 0; overflow-x: auto; border-collapse: collapse; }
th, td { padding: 0.5rem 0.75rem; border: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: var(--panel); }
code, pre { font: 0.875em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { padding: 0.1em 0.35em; border-radius: 4px; background: var(--panel); overflow-wrap: anywhere; }
pre { margin: 1rem 0; padding: 1rem; overflow-x: auto; border-radius: 8px; background: var(--panel); font-size: 0.875rem; }
pre code { padding: 0; background: none; font-size: 1em; overflow-wrap: normal; }
.pl-c { color: var(--muted); }
details { margin: 0.5rem 0; padding: 0.6rem 1rem; border: 1px solid var(--line); border-radius: 8px; }
summary { cursor: pointer; }
blockquote { margin: 1rem 0; padding: 0 1rem; border-left: 0.25rem solid var(--line); color: var(--muted); }
.alert { margin: 1rem 0; padding: 0.75rem 1rem; border-left: 0.25rem solid var(--link); background: var(--panel); }
.alert-important, .alert-warning, .alert-caution { border-left-color: var(--accent); }
.alert p { margin: 0.25rem 0 0; }
.alert .alert-title { margin: 0; font-weight: 600; }
</style>
</head>
<body>
<header class="bar"><div><h1>Aerion</h1><a href="${repoUrl}">View on GitHub</a></div></header>
<main>
${readme}
</main>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(root, "assets"), join(out, "assets"), { recursive: true });
writeFileSync(join(out, "index.html"), page);

// A failed build leaves the last good page live, which beats publishing broken links.
const problems = [
  ...[...readme.matchAll(/href="#([^"]+)"/g)].filter(([, id]) => !readme.includes(`id="${id}"`)).map(([, id]) => `no heading for #${id}`),
  ...[...readme.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].filter(([, path]) => !existsSync(join(out, path))).map(([, path]) => `no file ${path}`),
];
if (problems.length) throw new Error(`The README has broken links:\n${[...new Set(problems)].join("\n")}`);

console.log(`Wrote ${out}`);
