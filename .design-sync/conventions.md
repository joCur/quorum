# Building with Quorum

Quorum is a meeting-recording app ("a friendly studio"): warm cream surfaces, one lively teal
brand hue, rounded shapes, honest states. Components are shadcn/ui-based React, themed entirely
through CSS custom properties.

## Setup

- Components work without any wrapper for styling — tokens ship in `styles.css`.
- Components that navigate (`MeetingList`, `MeetingListItem`, `AppShell`) need a router context:
  wrap your app in `DsPreviewProvider` (exported from the bundle). It also initializes the
  English string catalog the components render their labels from.
- Dialogs: `DialogContent` REQUIRES a `closeLabel` prop. `Dialog` has no `DialogHeader`/`DialogFooter`
  exports (compose with `div`s); `AlertDialog` has both.

## Styling idiom

The shipped stylesheet is purged to the classes the app itself uses — do NOT write arbitrary
Tailwind utilities for your own layout; they will not resolve. Instead:

- **Your layout glue**: inline styles (`style={{ display: "flex", gap: 12 }}`).
- **Your colors/typography**: the token custom properties, as `hsl(var(--token))`. Color tokens
  are raw HSL triplets — always wrap in `hsl()`; alpha via `hsl(var(--token) / 0.4)`.
- **Component appearance**: props (`variant`, `size`, `status`), never overriding classes.

Token vocabulary (defined in `_ds_bundle.css`, imported by `styles.css`; light + `.dark` sets):

- Surfaces/text: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`,
  `--muted`, `--muted-foreground`, `--border`, `--input`, `--ring`
- Brand/interaction: `--primary` (teal), `--secondary`, `--accent`, `--destructive` (+ each
  `-foreground`)
- Expressive accents (personality, NEVER status): `--honey`, `--plum` (+ `-subtle`)
- Status (state, and ONLY state): `--recording`, `--success`, `--warning`, `--info` (each with
  `-foreground` and `-subtle`)
- Shape/elevation/motion: `--radius`, `--shadow-sm|md|lg`, `--duration-micro|default|large`,
  `--ease-enter|exit|spring`
- Fonts: `--font-sans` (Plus Jakarta Sans Variable — ships), `--font-mono` (JetBrains Mono —
  ships; use for timers, durations, timestamps, always with `font-variant-numeric: tabular-nums`)

Hard rules: recording red is sacred — `--recording` marks active audio capture only, never errors
(errors use `--destructive`, a different red). One `default`-variant Button per view region;
destructive Buttons only behind a confirm dialog. Status is always icon + label + color, never
color alone (`StatusBadge` does this for meeting states).

## Where the truth lives

Read `styles.css` and its imports (`fonts/fonts.css`, `_ds_bundle.css` — the latter holds all tokens and component styles) before styling anything, and each
component's `.d.ts` + `.prompt.md` for its exact API. Realistic content is part of the brand:
meetings, transcripts, summaries — factual microcopy, warm but never flippant in consent/delete/error
surfaces.

## Example

```jsx
const { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, StatusBadge } = window.Quorum;

<div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420 }}>
  <Card>
    <CardHeader>
      <CardTitle>Weekly product sync</CardTitle>
      <CardDescription style={{ fontFamily: "var(--font-mono)" }}>42:10</CardDescription>
    </CardHeader>
    <CardContent style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <StatusBadge status="ready" />
      <Button size="sm" variant="secondary">Open summary</Button>
    </CardContent>
  </Card>
</div>
```
