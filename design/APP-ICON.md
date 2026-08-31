# Quorum App Icon

> **Superseded in full by the v2 redesign.** This file still describes the v1 teal "quorum ring"
> mark. The v2 mark is the letter Q set in Schibsted Grotesk on an espresso tile with a honey dot
> (inverted in dark mode). The brand and app-icon redesign rewrites this file and regenerates the
> assets; nothing here is deleted ahead of that PR.

Master vector: `client/public/favicon.svg` (512-grid, hand-written SVG). PNGs in `client/public/icons/` are generated from it (`rsvg-convert -w <size>`); the maskable variant scales the glyph to 82% around the center and drops the corner rounding so the full-bleed tile survives any platform mask (safe zone: central 80%).

## Concept — "the quorum ring"

A quorum is people coming together. The icon is a circle of gathering — a bold warm-white ring on the brand's teal tile — with **one honey dot sitting on the ring: a voice lit up in the circle**. The dot is the design system's breathing-dot motif at rest, and ring + dot together read as a **Q**. Three ideas in one shape: gathering, voice, and the letterform — with no mic clipart.

Variants considered and dropped: a speech bubble with level bars (generic, mushy at 16px) and a three-dot voice cluster (no letterform, weak silhouette).

## Construction (512 grid)

- Tile: 512×512, corner radius 116 (~22.6%), vertical teal gradient `#279181 → #1c6f5c` (primary token, gently lit from above — the "well-lit studio").
- Ring: center (256, 256), radius 122, stroke 60, warm white `#fffdf7` (not pure white — paper, matching the cream surfaces).
- Dot: center (346, 346) — on the ring's 45° point — radius 70, honey `#f5b214` (accent token, brightened for contrast on teal). It overlaps the ring, sitting *in* the circle, not orbiting it.

## Do / don't

- **Do** keep the dot honey and the ring warm-white on teal — the only approved colorway. On very small monochrome contexts (e.g. pinned-tab masks), the ring + dot silhouette in a single color is acceptable.
- **Do** regenerate all PNGs from `favicon.svg` after any change; never edit the PNGs.
- **Don't** add more dots, faces, mic glyphs, sound waves, or text to the mark.
- **Don't** rotate the dot to another position — bottom-right is the Q tail; anywhere else it stops reading as a Q.
- **Don't** use recording red in the icon: the dot at rest is honey; red is reserved for a live capture state in the UI, never for branding.

PWA chrome colors (`theme_color` / `background_color` in the manifest and `theme-color` metas) stay on the app's background tokens (cream/charcoal) — the icon's teal is the figure, not the chrome.
