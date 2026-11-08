---
name: look-packs
description: "Give an app switchable looks people actually like: three ready packs (Studio, Glass, Sunny), each with a light and a dark version, or new ones in the same spirit, compared side by side and then built into the app. Use for \"look packs\", \"new themes\", \"add themes\", \"more looks\", \"the dark mode is too dark\", \"my cards don't stand out\", \"too purple\", \"make it happier\", \"a Sunny look\", \"a Glass look\", or \"/shipyard:look-packs\". For one look as the app's only look, use design."
---

# Shipyard look packs

> Part of the Shipyard plugin. It needs the full plugin installed (repo INSTALL.md): its scripts and key guard do not work on their own.

You give an app a set of looks its owner can switch between in Settings. Each look is a pack: a light and a dark version. You start from three packs that were refined on a real app with real feedback, change them to fit this app, or draft new ones like them. The owner chooses by looking, never from a description. Works on any app, whether Shipyard made it or not.

## Rules (always)

Shared working rules: `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md`.

- No colour codes unless asked.
- Show before building. Nothing goes into the app until the owner has seen each pack, light and dark, next to what they have today.
- Their taste wins. When they react ("too dark", "I don't like the orange"), change that and show it again. `references/lessons.md` turns common reactions into changes.
- Style, not brand. Never copy a logo or a brand name, and never put a brand name in a look's name.
- A look changes how things look, not where they are. Moving things belongs to `ux-redesign`.
- Colour still means something: keep red for errors and recording, amber for warnings. A pack's button colour never replaces them.
- Work on a branch. Do not commit, push or open a pull request without a clear yes, and never merge.

## 1. Read the app as it is today

1. Fetch and compare the checkout with the main branch on GitHub. If it is behind, read from the latest code (`git show origin/main:<file>`) or the review will judge an old app.
2. Find the app's looks: a theme registry, a settings picker, the colour variables, how light and dark are chosen.
3. Search for colours written directly into styles and components, and the styles of the app's main button. These are what a colour change misses.
4. Ask one question if it isn't clear: "Which look do you like most today, and what bothers you about the others?"

## 2. Choose the packs

Read `references/looks.md`. Recommend from its "good for" table. The ready data is `references/packs.json`. To draft a new pack, follow "Making more like these" there and start from the closest pack.

Check every draft, then fix what fails:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/theme-packs.mjs" check <packs.json> --default <id>`

`node "${CLAUDE_PLUGIN_ROOT}/scripts/theme-packs.mjs" rules <packs.json>`

`check` is about readable text and having both modes. `rules` is about dark versions that are too dark or whose boxes melt into the page.

## 3. Show them

Make a page showing, for every pack, today's look beside the proposal, light and dark, using this app's own words and a real card, button and list:

- If the Artifact tool can make a design canvas, use it: one board comparing the looks, then the real screens.
- Otherwise: `node "${CLAUDE_PLUGIN_ROOT}/scripts/theme-packs.mjs" mock <directions.json> --app "<App name>" --out design-mock.html`, and open it.

Ask which to keep. Repeat this step after every reaction. Keep the same names between rounds.

## 4. Build the chosen packs

Read `references/lessons.md` first. It holds what a colour swap alone gets wrong.

- **App has no picker yet:** read `skills/design/templates/theme-packs/README.md` and copy those templates. Generate the CSS and the no-flash script with `theme-packs.mjs css` and `boot`.
- **App already has looks:** keep its registry and picker, and add the packs in its own shape. Map the pack's colours onto the app's existing variables instead of adding a second set. Keep each person's saved choice working.
- Keep the app's default look unless the owner chooses another.
- Load a new font only when its look is picked. If the app has other alphabets, confirm the font has them.
- Add every new word to the app's translations.

## 5. Check it for real

Run the app's type check, tests and production build. Then, in a browser, for every pack in light and dark:

- Look at a screen with the main button, a form, a list, a menu, a dialog, and a phone-width page.
- Reload: no flash, and the choice is remembered. Light, Dark and Auto all work inside each pack.
- Load the page in each language the app has, and confirm the heading font loaded (`document.fonts`).
- Take new preview images for the picker from the real screens, not by hand. `skills/ux-redesign/references/shot.mjs` shows how.

Look at the screenshots yourself and fix what you see before you say anything is done.

## Done when

- `check` and `rules` pass, and the app's tests and production build pass.
- You looked at every pack in both modes, on a computer and a phone.
- The owner chose these packs after seeing them, and knows what was not checked.
- The work is on a branch, and you asked before committing or opening a pull request.
