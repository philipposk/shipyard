---
name: quick-sketch
description: "When there are two or more ways a screen or feature could look or work, draw a cheap SVG sketch of each, side by side, with one recommended, so the student picks by looking instead of reading. When a small change is easier to see than describe (ticking a to-do, a new background colour, a toggle), add a few frames and make a looping GIF. Seconds, not a mockup. Use for \"sketch it\", \"sketch the options\", \"show me the options\", \"which layout\", \"draw both\", \"quick sketch\", \"what would it look like\", \"/shipyard:quick-sketch\". Not for full mockups (use ux-redesign) or colours and fonts (use design)."
---

# Shipyard quick sketch

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md). GIFs use the Playwright browser an app already has; without it, the frames become an animated SVG.

A choice described in words is hard to judge. You draw each option as a tiny grey-box SVG, the way someone would sketch on a napkin, put them side by side with a one-line note each, and recommend one. When the difference is a small change of state, you draw a few frames and make a looping GIF. The point is speed: a sketch costs a few hundred bytes and a few seconds, so draw instead of describing whenever there is a real choice.

Adapted from Magdoub's MIT-licensed wireframe skill (`references/credits.md`): its "several named options, one recommended, layout before colour" idea, made much cheaper.

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

- Two to four options. Fewer is not a choice; more is not quick. Each has a 1 to 3 word name and one sentence on what it is good at.
- Cheap means cheap: grey boxes, lines for text, real labels on the parts that matter, one accent colour for the thing that differs. No icons, photos, gradients, shadows or real copy. Read `references/sketch-style.md` before the first sketch.
- Every option is drawn at the same size and level of detail, so the only thing that changes is the choice.
- Always recommend one, and say why in one sentence.
- A GIF only when the change is small and visual (a box ticked, a colour changed, a panel opened, a toast appearing): two to six frames of the same drawing. Anything bigger is two options, not an animation.
- Sketches are throwaway. Write them in `.shipyard/sketches/`, which apps keep off GitHub. Never commit them unless the student asks.
- Do not build the chosen option in the same step. Sketch, let the student pick, then build.

## 1. Decide if a sketch helps

Sketch when there are at least two real ways to do something and the difference is visual or about layout or flow. Do not sketch a choice that is only about words, data or code structure. If you were about to write "Option A: ... Option B: ...", draw instead.

## 2. Write the sketches

1. Make the folder `.shipyard/sketches/<DDMM>-<short-name>/` in the app (or the current folder outside an app), for example `.shipyard/sketches/2511-save-button/`.
2. Write one SVG per option: `option-1.svg`, `option-2.svg` and so on, following `references/sketch-style.md`.
3. For a small change, write the frames: `<change>-1.svg`, `<change>-2.svg`, same viewBox, only the changing part different.
4. Write `sketch.json`:

   ```json
   {
     "title": "Where the save button goes",
     "question": "Bottom bar or top corner?",
     "recommended": 1,
     "options": [
       { "name": "Bottom bar", "file": "option-1.svg", "note": "Easy to reach with a thumb." },
       { "name": "Top corner", "file": "option-2.svg", "note": "Out of the way, like most desktop apps." }
     ],
     "variations": [
       { "name": "tick-a-task", "label": "Ticking a task", "frames": ["tick-1.svg", "tick-2.svg"], "delay": 700 }
     ]
   }
   ```

   `variations` is optional, and so are `options` when the request is only "show me what ticking looks like".

## 3. Check, animate, lay out

Run, from the app folder:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/quick-sketch.mjs" all .shipyard/sketches/<folder>
```

It checks every SVG (no scripts, links or outside files, a viewBox, under 12 KB, few colours), turns each variation into `<name>.gif`, and writes `index.html` with the options side by side and the recommended one marked. Fix every error it prints and run it again. Warnings are about cheapness: fix them unless there is a reason.

Outside an app, or in an app without `npm install`, add `--tools <a folder with Playwright in node_modules>`. With no browser at all it writes `<name>.anim.svg` instead of a GIF; that plays in any browser, so carry on and say so.

## 4. Show it

- In a chat that shows images, show each option's SVG (or a screenshot of `index.html`) and the GIF right in the reply.
- Otherwise open `index.html` for the student (`open` on a Mac, `xdg-open` on Linux, `start` on Windows).
- Then one short message: the options by number and name, the one you recommend and why, and "Which one?". Nothing else.

## 5. After the pick

Build the chosen option with the app's real components and design. If the student says "mix 1 and 3", sketch the mix once more before building, only if the mix is not obvious.

## Done when

- `quick-sketch.mjs check` passes on the folder.
- The student has seen the sketches (and the GIF, if any) and has a clear recommendation to answer.
