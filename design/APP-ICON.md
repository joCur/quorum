# Quorum App Icon

Master vector: `client/public/favicon.svg` (512 grid, hand-written SVG). The PNGs in
`client/public/icons/` are generated from it — never edit them by hand.

## Concept — the Q and its counterweight

The icon is the wordmark compressed into one character: the **Q of Quorum**, set in Schibsted
Grotesk 800 — the same typeface the product speaks in — on an **espresso** tile, with the **honey
dot** placed at the bottom right as the letter's counterweight. Two brand facts, nothing else: the
name and the accent color. No microphone, no sound waves, no recording red — red belongs to a
capture that is actually running, never to the brand.

The dot reads two ways on purpose. Geometrically it answers the Q's tail across a small gap, so the
silhouette stays balanced at 16 px. Semantically it is the design system's honey accent at rest —
the same dot that marks a selection or a live voice elsewhere in the UI.

The mark is drawn from a font but does not depend on one: the Q outline is converted to a path, so
`favicon.svg` renders identically wherever it is loaded, with no webfont and no text rendering.

## Construction (512 grid)

| Element | Geometry | Light | Dark |
| --- | --- | --- | --- |
| Field | 512×512, corner radius 119.5 (23.3%) | espresso `#35271d` | honey `#f6b623` |
| Q | Schibsted Grotesk, weight 800, scaled 273.07/2048 em units (0.1333); ink box 193.62 × 246.30 at x 159.19–352.81, y 132.85–379.15 | paper `#faf6f0` | espresso `#211812` |
| Dot | center (396.8, 396.8), r 34.13 (Ø 68.27 = 13.3% of the tile), inset 115.2 from the right and bottom edges | honey `#f6b623` | espresso `#211812` |

The Q is centered **optically on its ink box** — bowl plus tail, not on the typographic baseline —
so the mark sits level inside the tile. The dot clears the tail by ~2.6 units at 512: they read as
two shapes in conversation, never as one blob. That gap is the whole balance of the mark; it is the
first thing to check after any change.

The colors are the v2 tokens, not new values: espresso is `--primary` in light mode, honey is
`--primary` in dark mode and `--honey` throughout, paper is `--primary-foreground`.

### Variants

- **Light (default).** Espresso field, paper Q, honey dot.
- **Dark (inverted).** Honey field, espresso Q and dot. It lives in the same `favicon.svg` behind a
  `prefers-color-scheme: dark` media query, so a browser tab flips with the OS on its own.
  Renderers that ignore media queries (including `rsvg-convert`) fall back to the light colorway —
  which is what the generated PNGs are meant to be.
- **Maskable.** Full-bleed espresso, corner rounding dropped so any platform mask has tile to cut
  into. The Q-and-dot group is scaled to 0.72 about its own content center (295.06, 281.89) and
  recentered on the tile center. Its content then spans 294 units diagonally, comfortably inside
  the 409.6 safe circle (the central 80%) that a circular or squircle mask can guarantee.

## Regenerating the PNGs

From `client/public/`, after any edit to `favicon.svg`:

```sh
rsvg-convert -w 192 -h 192 favicon.svg -o icons/icon-192.png
rsvg-convert -w 512 -h 512 favicon.svg -o icons/icon-512.png
```

The maskable variant is the same mark in the safe-zone layout described above — a full-bleed
`<rect>` in `#35271d` plus the Q path and the dot wrapped in
`<g transform="translate(43.56 53.04) scale(0.72)">` — rendered at 512 to
`icons/icon-512-maskable.png`.

## Do / don't

- **Do** keep the two approved colorways and nothing else. The mark is espresso-on-paper or its
  inversion; there is no third tint, no gradient, no outline version.
- **Do** regenerate every PNG from `favicon.svg` after any change, and check the 16 px rendering:
  if the dot merges into the tail, the geometry drifted.
- **Do** use the maskable asset wherever a platform applies its own mask, and keep the full mark
  inside the central 80%.
- **Don't** replace the path with live text. A `<text>` element would resolve to whatever font the
  renderer happens to have, which is not this Q.
- **Don't** move the dot. Bottom right is the only position where it reads as the letter's
  counterweight; anywhere else it becomes decoration.
- **Don't** add a second dot, a microphone, a waveform, or the wordmark to the tile.
- **Don't** use recording red anywhere in the mark.

## PWA chrome

The manifest's `theme_color` / `background_color` and the `theme-color` metas in
`client/index.html` are the app's **surfaces**, not the icon: paper `#f7f2e9` in light, warm
near-black `#171310` in dark. The icon's espresso is the figure the chrome sits behind.
