---
name: theme-picker
description: "Let users of an app pick their own colours: preset themes plus a full colour picker (hue/saturation square and hex) for accent, buttons, background, cards and text, separately for light and dark, saved per user and rendered without a flash. Use for \"theme editor\", \"custom colours\", \"colour picker\", \"let users choose their theme\", \"/shipyard:theme-picker\". Not for designing the app's own default look (use design)."
---

# Shipyard theme picker

> Part of the Shipyard plugin. If it was installed by itself and Shipyard's `scripts/` folder is not on this computer, install the full plugin first: https://github.com/philipposk/shipyard/blob/main/INSTALL.md.

Reference build: Catchy PR #132 (`lib/custom-theme.ts`, `lib/color.ts`, `components/ColorPicker.tsx`, `components/ThemeEditor.tsx`).

## 1. Make every colour a CSS variable first
Before any picker, the app's CSS must read colours only from variables (`--bg`, `--surface`, `--text`, `--accent`, `--inverse`/`--on-inverse` for buttons, plus derived `--subtle`, `--raised`, `--line`, `--muted`). Search for hard-coded hex values and replace them. A picker over a half-variabled app looks broken.

## 2. Store a small, validated theme object
`{ preset, accent, colors: { light: {bg, surface, text, button}, dark: {...} } }`. Accept only `#rrggbb` (sanitize on read and on write; drop anything else). Save it with the user (for example Supabase `user_metadata.custom_theme`), not only in localStorage, so it follows them across devices.

## 3. Derive the rest, don't ask for it
Users pick 5 colours; compute the in-between tones with a colour mix (for example `raised = mix(surface, text, 4%)`, `line = mix(surface, text, 12%)`, `muted = mix(text, bg, 40%)`). Pick the readable text on a button by luminance. Warn (don't block) when contrast is below 4.5:1 for text and 3:1 for buttons.

## 4. Render it on the server, scoped tightly
Emit a `<style>` in the root layout from the saved theme, scoped like `:root[data-ct][data-style][data-theme=dark] { ... }` so it beats the presets on specificity and can never leak into other modes. Server rendering means no flash of the default theme. Live preview while editing just rewrites that style tag on the client.

## 5. The picker itself (about 150 lines, no library)
- Saturation/value square: `background-color: hsl(hue 100% 50%)` with two gradient overlays (white→transparent left-to-right, transparent→black top-to-bottom). Use `backgroundColor`, not the `background` shorthand, or React wipes the gradients.
- Hue slider: a rainbow gradient strip.
- Hex input: commits on valid `#rrggbb` only.
- Pointer drag with `setPointerCapture` on `e.currentTarget`; arrow keys move 1% (Shift 10%); each control is `role="slider"` with aria values.
- Keep HSV in local state so the hue doesn't jump when saturation hits 0; resync from the prop with the "adjust state while rendering" pattern, not an effect.

## 6. Editor layout (phone first)
Presets on top. Below: "Exact colours" with a Light/Dark switch, one row per slot (swatch, name, hex, Clear), and the picker opening under the tapped row. Clear falls back to the preset value. Test at 390x844.

## 7. Check
Unit-test sanitize, HSV round trip and the generated CSS. Screenshot light and dark with a garish pick (yellow buttons) to catch any hard-coded colour that didn't follow.
