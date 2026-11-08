# More looks and tidy themes

## More looks (only when asked)

Only if the student asks for switchable looks. Every extra look is a **pack**: light AND dark, never one mode alone. If they want ready looks or to compare several side by side, use the `look-packs` skill instead.

1. Copy the templates from `templates/theme-packs/` (see its README): registry `src/lib/theme-packs.ts` with entries `{ id, label, preview, tokens: { light, dark } }`, the current default first; `ThemePackPicker.tsx` in **Settings > Appearance**; `tests/theme-packs.test.mjs`.
2. Write the packs as JSON too and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/theme-packs.mjs" check packs.json --default <id>`. It fails on a missing mode, a forced mode or low contrast. Generate CSS and the pre-paint script with `css` and `boot`.
3. A pack never forces light or dark. The Light / Dark / Auto toggle keeps working inside every pack; switching pack keeps the mode.
4. Previews: one screenshot per pack in `public/themes/<id>.png` showing light and dark halves.
5. Check in a browser: switch every pack in light, dark and Auto, reload each time (no flash, choice remembered).

## Tidy themes (fix-up mode)

`Shipyard: tidy themes for <App>`. For apps whose looks were added as loose light-only or dark-only themes.

1. List the current themes and their modes from the app's registry. Note the current default look; it stays the default.
2. Pair single-mode themes that share a feeling into packs (e.g. a dark "Noir" + a light "Atelier"). A theme that already has both modes is already a pack.
3. A theme with no sensible partner: write the missing mode yourself if the look is strong, otherwise drop it. Say which and why.
4. Move to the pack registry shape, put the picker in Settings > Appearance, remove any forced-mode logic, keep the no-flash script, add the registry test.
5. Saved choices: map old saved theme ids to the new pack (and the mode it had) so nobody's look jumps.
6. Run the app's build and tests, then the browser check from "More looks". Branch, commit, open a PR; do not merge.
