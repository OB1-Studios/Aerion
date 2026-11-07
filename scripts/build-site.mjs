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

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IT Export Back Office</title>
<meta name="description" content="An agent that runs the weekly finance back office for Pakistani software houses and IT freelancers. It never moves money.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2314233B'/%3E%3Cpath d='M8 17l5 5 11-12' fill='none' stroke='%23F3F6FA' stroke-width='3.5'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: light dark;
  --ink: #14233b;
  --muted: #4a5a72;
  --line: #d5deec;
  --panel: #f3f6fa;
  --canvas: #fbfcfe;
  --link: #3346a8;
  --accent: #b93a2f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e6ecf5;
    --muted: #a9b6ca;
    --line: #2f4163;
    --panel: #18263d;
    --canvas: #0f1a2c;
    --link: #a6b9ff;
    --accent: #ff9d92;
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
<header class="bar"><div><h1>IT Export Back Office</h1><a href="${repoUrl}">View on GitHub</a></div></header>
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
