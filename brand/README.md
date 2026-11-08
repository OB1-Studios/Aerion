# Aerion brand

The logo is used as supplied: the folded-ribbon **A**, the **AERION** wordmark and the line
"Financial intelligence. Greater control." The original artwork is in
[`source/aerion-logo-original.jpeg`](source/aerion-logo-original.jpeg). Every file in [`png/`](png) is
cut from it (background removed, colours kept). Nothing has been redrawn.

## Files

| File | Use it for |
| --- | --- |
| `aerion-logo.png` | The full lockup on light backgrounds: the front page, documents, the deck |
| `aerion-logo-reversed.png` | The full lockup on dark green or other dark backgrounds |
| `aerion-logo-black.png`, `aerion-logo-white.png` | One-colour print and anywhere only one ink is available |
| `aerion-logo-stacked.png`, `aerion-logo-stacked-reversed.png` | The A over the name, for square spaces: the app's sidebar, a cover page, a profile picture |
| `aerion-mark.png` | The A by itself on light backgrounds: small headers, avatars |
| `aerion-mark-reversed.png` | The A on dark green: the app's sidebar |
| `aerion-mark-green.png`, `aerion-mark-white.png` | The A in one colour |
| `aerion-wordmark.png`, `aerion-wordmark-white.png` | The name by itself, next to or under the A |
| `icon.png` (512), `apple-icon.png` (180), `favicon-64.png` | App icons: the A on an ivory rounded square |

The web app serves the files it needs from `apps/web/public/brand/`, and its icons are
`apps/web/src/app/icon.png` and `apple-icon.png`.

## Rules

- **Clear space:** keep a margin around the logo at least as wide as the stem of the A.
- **Smallest size:** full lockup 160 px wide on screen (40 mm in print), so the tagline stays
  readable. Below that, use the mark and wordmark without the tagline. The mark alone goes down to
  24 px.
- **Backgrounds:** use the colour logo on canvas `#F7F8F5` or white. On forest green or anything dark,
  use the reversed logo.
- **Don't** recolour it, stretch it, add shadows or outlines, put it on a busy photo, or set the
  name in another typeface.

## Colour

| Role | Hex |
| --- | --- |
| Canvas | `#F7F8F5` |
| Surface | `#FFFFFF` |
| Forest green (primary) | `#214F41` |
| Sidebar green | `#1F4A3C` to `#163A2F` |
| Sage (soft primary) | `#DCE9DF` |
| Gold (highlight, the active item) | `#C9A15F` |
| Terracotta (accent rule) | `#C77959` |
| Graphite (text) | `#29332F` |
| Muted text | `#5F6963` |
| Border | `#E7EAE5` |
| Success / warning / danger / info | `#237A52` / `#A86412` / `#B6403A` / `#356A9A` |

The app's tokens, for both the light and dark themes, are in
[`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css).

## Type

- **Manrope** for the interface and body text.
- **DM Serif Display** for page titles, card titles and headline numbers only. It has one weight,
  so never make it bold.

Both are under the SIL Open Font License and are served from the app itself
(`apps/web/src/fonts/`).
