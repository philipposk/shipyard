# How a quick sketch looks

A quick sketch shows structure, not style. Someone should understand it in two seconds without reading the note.

## Canvas

- Phone screen: `viewBox="0 0 180 320"`. Desktop or web page: `viewBox="0 0 360 240"`. A single component (a card, a form, a list row): `viewBox="0 0 240 140"`, or whatever fits it tightly.
- All options of one choice use the same viewBox. All frames of one variation use the same viewBox.
- Start with a white background rectangle and a thin `#ccc` outline for the screen edge.

## Colours

| Use | Colour |
|---|---|
| Text and important lines | `#111` |
| Secondary text, outlines | `#666` |
| Placeholder lines (text you do not spell out), dividers | `#ccc` |
| Panels, bars, empty image areas | `#eee` |
| Background | `#fff` |
| The one thing that differs between options, or the thing that changes in a GIF | one accent, `#2563eb` |

Use the app's own accent instead of `#2563eb` when it is easy to find (`--accent` in `globals.css`). Never more than one accent.

## Shapes

- Blocks are `rect` with `rx="4"`. Text you do not need to read is a grey line (`rect` 4px high, `#ccc`) or two.
- Write real words only where they explain the choice: button labels, the screen title, a section heading, one or two list items. Keep them short. `font-family="sans-serif"`, size 10 to 14.
- A button is a filled rect with a white label. A text field is an outlined rect with a grey line inside.
- An image or chart is an `#eee` rect with a diagonal `#ccc` line. No pictures.
- Aim for 10 to 40 shapes. The checker warns at 80 and stops at 12 KB.

## Not allowed (the checker refuses these)

`<script>`, `on...=` handlers, `<a>` links, `<image>`, `<foreignObject>`, `url(...)` to anything outside the file, `@import`. Gradients and filters get a warning.

## Frames for a GIF

- Copy frame 1 and change only the part that moves: the tick, the colour, the panel. Everything else stays byte for byte the same.
- Two frames for an on/off change; three to six for a short sequence (tap, open, close). Default delay 700 ms per frame; 400 for quick taps, 1200 when there is text to read.
- Name the variation after the change in lowercase words joined by dashes: `tick-a-task`, `dark-background`, `open-filters`.

## Example (a phone list with a bottom button)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 320">
  <rect width="180" height="320" fill="#fff" stroke="#ccc"/>
  <text x="12" y="28" font-family="sans-serif" font-size="14" fill="#111">Today</text>
  <rect x="12" y="44" width="14" height="14" rx="3" fill="#fff" stroke="#666"/>
  <rect x="34" y="49" width="90" height="4" fill="#ccc"/>
  <rect x="12" y="70" width="14" height="14" rx="3" fill="#fff" stroke="#666"/>
  <rect x="34" y="75" width="70" height="4" fill="#ccc"/>
  <rect x="12" y="276" width="156" height="32" rx="4" fill="#2563eb"/>
  <text x="90" y="296" font-family="sans-serif" font-size="12" fill="#fff" text-anchor="middle">Add task</text>
</svg>
```
