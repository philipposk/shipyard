---
name: design
description: "Choose or change how an app looks: colours, fonts, layout, homepage style, dark mode, icons. Use for \"design\", \"how my app looks\", \"change the look\", \"change the colours\", \"change the fonts\", \"copy this website's style\", \"make it look like\", \"3 directions\", \"/shipyard:design\", or the sentences \"Shipyard: use the <name> look\" and \"Shipyard: use direction <A|B|C> for <app>\"."
---

# Shipyard design

> Part of the Shipyard plugin. This skill runs Shipyard's own scripts and key guard, so it does not work on its own. If it was installed by itself (for example through skills.sh, ClawHub, Hermes, pi or aiden) and Shipyard's `scripts/` folder is not on this computer, stop and install the full plugin first by following https://github.com/philipposk/shipyard/blob/main/INSTALL.md, then start again.

You help a beginner pick how their app looks. A look is more than colours: it also sets the menu style, the homepage style, how cards and buttons feel, and how big the text is. All ways of choosing are free, need no extra account, and end the same way: checked colours and fonts written into the app, a fresh `DESIGN.md` (the app's written look guide), and matching icons.

## Rules (always)

- You run the scripts. The student only looks and chooses.
- Plain English, short messages, one question at a time with your recommended answer. No colour codes unless asked.
- Style, not brand. We copy colours, fonts (nearest free Google font), spacing, corner roundness and general feel. Never logos, images, icons, wording, brand names or trademarks. Say this once, when the student picks a site, screenshots or a DESIGN.md file.
- Never put a brand name in a generated look name or description.
- Do not commit or push. Ask first, as in the new-app skill.

## 1. Find the app

Use the current folder if it has `.shipyard-app.json`. Otherwise ask which app (`node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show` lists them). No such file means it is not a Shipyard app: stop and explain.

Two sentences skip the questions. `Shipyard: use the <Look name> look for <App name>` goes straight to step 5 with that look (match the name to an id in `references/presets.md`). `Shipyard: use direction <A|B|C> for <App name>` goes to step 4, "Apply a direction".

## 2. Ask how to choose

One question: "How do you want to choose the look?" Offer these, in this order, and say which you recommend (a site they like if they have one, else the 3 directions):
1. **A site or app you like.** Screenshots, or a website address.
2. **A design file** from the free getdesign.md collection (it holds ready-made `DESIGN.md` files for well-known styles; MIT licensed, credit "awesome-design-md by VoltAgent" if you mention it).
3. **3 directions for my homepage.** You draft three really different looks for their app and show real screenshots of their own app.
4. **A ready-made look.** 8 looks to pick from. The quickest.
Or keep what they have.

## 3a. A site or app you like

Screenshots: ask them to save 1 or 2 images in `<appDir>/design-input/` (a folder, not the chat: it keeps the conversation small). That folder is in the app's `.gitignore`, so other sites' screenshots never go to GitHub; if an older app lacks the line `/design-input/`, add it first. Look at the images, read `references/tokens.md`, write `<appDir>/.shipyard/design/screenshot-draft.tokens.json` (colours, fonts, corners and the layout and type fields), then go to "Apply a draft".

Website address: `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-from-url.mjs" <url> --app <appDir>`. It needs `npm install` to have been run in the app. It saves screenshots of the site and a draft look in `<appDir>/.shipyard/design/`, and guesses the menu style, card and button feel, spacing and text size too. Look at the screenshots and the draft, say in plain words what you would change, adjust the draft. It never saves the site's images, logos or text.

## 3b. A design file

`node "${CLAUDE_PLUGIN_ROOT}/scripts/design-from-designmd.mjs" --list --app <appDir>` shows the names. Then `--name <name>` downloads one (or `--file <path>` for a file they already have, `--url <https address>` for a raw GitHub link). It saves the file in `<appDir>/design-input/` with a source note and writes a draft look to `<appDir>/.shipyard/design/designmd-draft.tokens.json` with a neutral style name, never the brand. Read the draft, fix anything odd, go to "Apply a draft".

## 3c. Three directions

Read `references/directions.md`. First write the app's real home words in `<appDir>/src/lib/home-content.ts` (what the app is for, three short points, three entries; the real screenshots show exactly these words, and the script warns if the template's stand-ins are still there). Then write three token files for THIS app at `<appDir>/.shipyard/design/direction-a.tokens.json`, `-b` and `-c`, genuinely different from each other. Then:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/design-directions.mjs" <appDir>`
It checks them, refuses if two look too alike (then make them more different), renders real screenshots of their app (about a minute) and opens a page with the three side by side. They click "Use direction B" and paste the sentence back to you. Add `--no-open` to only write the page.

### Apply a direction
`node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-design.mjs" <appDir> --tokens <appDir>/.shipyard/design/direction-<a|b|c>.tokens.json --source custom --fix`

## 4. Apply a draft

`node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-design.mjs" <appDir> --tokens <draft> --source <screenshot|url|design-md> --fix`
Tell them in plain words what `--fix` changed. Add `--dry-run` first if they want to see what changes. Add `--keep-layout` if they like their current menu style and only want the new colours and fonts. Add `--languages en,el` if the app uses other alphabets (the profile may already say).

## 5. Ready-made look

`node "${CLAUDE_PLUGIN_ROOT}/scripts/design-gallery.mjs" --app <appDir>` opens a page showing 8 looks on a phone and on a computer screen, light and dark. Add `--real` to see the looks on their own app instead of the pictures (takes about a minute, needs `npm install` first); offer it, don't force it. Before `--real`, write the app's real home words in `<appDir>/src/lib/home-content.ts` (otherwise every look is shown with the template's filler text; the script warns). They click "Use this look" and paste the sentence back. If they just name a look, skip the gallery. Then:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-design.mjs" <appDir> --preset <id>`

## 6. Layout

A look carries its own menu style, and applying it sets that. Only if they want to change just the menu, ask once and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/set-layout.mjs" <appDir> <bottom-nav|sidebar|top-nav>`. Plain words: `bottom-nav` = tabs along the bottom like a phone app; `sidebar` = a menu on the left (tools, dashboards); `top-nav` = links across the top (websites, content, shops). On phones all three show bottom tabs.

## 7. Check it

1. In the app: `npm run check:design`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" <appDir> --only design`. `references/anti-slop.md` says what each finding means.
2. If the app runs locally or is deployed, run the browser check and look at the light and dark phone screenshots yourself. Fix what looks off (hard-to-read text, cramped spacing, empty screens, a homepage that still says generic words) and say what you changed. Homepage words live in `src/lib/home-content.ts`; edit them for the app's real purpose.
3. If icons say "later", run `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-icons.mjs" <appDir>` after `npm install`.

## 8. Use it again?

Ask: "Use this look for your next apps too?" If yes, apply again with `--set-default`.

## 9. Optional polish

Read `references/polish.md`. Offer it, never push it, and ask before installing anything.

## Reference files

`references/presets.md` (the 8 looks), `references/tokens.md` (the look file, and how to read a look from images), `references/directions.md` (drafting 3 directions), `references/anti-slop.md`, `references/polish.md`.

## Handy facts

- `apply-design.mjs` options: `--preset`, `--tokens`, `--source preset|screenshot|url|design-md|custom`, `--fix`, `--dry-run`, `--set-default`, `--keep-layout`, `--languages`, `--no-icons`, `--json`. Running it twice gives the same result. If it says the colour markers are missing, the app was not made from the Shipyard template: do not hand-edit, explain it.
- Never edit between the `shipyard:tokens` markers in `globals.css` by hand. Always go through the script.
- Wanting one colour changed: copy `.shipyard/design/applied.tokens.json`, change it, apply with `--tokens ... --fix`.
- Apps made before this version lack the size and spacing block. They still get the new colours, with a note that sizes were skipped.
