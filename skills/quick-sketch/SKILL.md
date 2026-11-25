---
name: quick-sketch
description: "When there are two or more ways a screen or feature could look or work, draw a cheap sketch of each, side by side, with one recommended, so the student picks by looking instead of reading. When a small change is easier to see than describe (ticking a to-do, a new background colour, a sheet opening), add a few frames and make a looping GIF. Seconds, not a mockup. Use for \"sketch it\", \"sketch the options\", \"show me the options\", \"which layout\", \"draw both\", \"quick sketch\", \"what would it look like\", \"/shipyard:quick-sketch\". Not for full mockups (use ux-redesign) or colours and fonts (use design)."
---

# Shipyard quick sketch

> Part of the Shipyard plugin (https://github.com/philipposk/shipyard/blob/main/INSTALL.md). GIFs use the Playwright browser an app already has; without it the frames become an animated SVG.

Draw instead of describing whenever there is a real choice. You write a few block lines per option in `sketch.json`; the script draws consistent grey-box SVGs, the GIFs and a comparison page. Adapted from Magdoub's MIT-licensed wireframe skill (`references/credits.md`).

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` before any other step, unless you already read it in this session.

- Two to four options, each a genuinely different approach, with a 1 to 3 word name.
- Spend as little as possible. Every tool call re-reads the whole chat, so the number of steps is the cost: read at most the one screen file the choice is about (or nothing, if the student described it), then write `sketch.json` in one step and run the script in one step. Do not open the SVGs or GIF to check them; the script checks them.
- Mark the part that differs with `*` (accent). Same frame and same surrounding blocks in every option, so only the choice changes.
- Each `note` is "Good: ... Costs: ...". Always recommend one, with `because`: one sentence naming the deciding fact.
- A GIF only for a small visible change: 2 to 4 frames of the same blocks with one line changed.
- Sketches are throwaway: `.shipyard/sketches/<DDMM>-<short-name>/`, never committed unless asked. Do not build the option in the same step.

## 1. Plan sketch.json

```json
{
  "title": "Adding a note", "question": "How should adding a note work?",
  "frame": "phone", "accent": "#1b7a4b",
  "recommended": 1, "because": "Notes are one line, so typing in place beats opening a sheet.",
  "options": [
    { "name": "Input on top", "note": "Good: one tap, always visible. Costs: a row of space.", "blocks": ["title Notes", "*input Write a note | Add", "list 4"] },
    { "name": "Floating button", "note": "Good: full screen for the list. Costs: an extra tap.", "blocks": ["title Notes", "list 4", "*fab +"] }
  ],
  "variations": [
    { "name": "tick-a-note", "label": "Ticking a note", "frames": [["title Today", "list 3 check"], ["title Today", "list 3 check done:1"]] }
  ]
}
```

`recommended` is the option's number counting from 1 (the first option is 1). `frame` is `phone`, `desktop` or `card`. `accent` is the app's accent (`--accent` in `globals.css`) when you already know it; leave it out otherwise. Blocks, one per line (pinned ones sit at the bottom):

`title <words>` · `label <words>` · `text <n>` · `input <placeholder> | <button>` · `button <words>` · `list <n> [check] [done:1,2]` · `cards <n>` · `image` · `chips a|b|c` · `tabs a|b|c` · `toggle <words> [on]` · `ghost <words>` (dashed add row) · `space` · `sidebar a|b|c` (desktop) · pinned: `fab +` · `footer <words>` · `nav a|b|c` · `sheet <title> | <button>` · `toast <words>`

Only when blocks truly cannot show the idea, write that option as an SVG file and give `"file"` instead of `"blocks"` (rules in `references/sketch-style.md`).

## 2. Draw and show

Write `.shipyard/sketches/<DDMM>-<short-name>/sketch.json` with your file-writing tool, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/quick-sketch.mjs" all .shipyard/sketches/<folder>
```

Add `--tools <folder with Playwright in node_modules>` outside an app. Fix any error and run again. Then show the student `index.html` (or the option SVGs and the GIF inline, if the chat shows images) with one short message: options by number and name, the recommendation and its `because`, and "Which one?".

## Done when

The script passes and the student has the sketches and one recommendation to answer.
