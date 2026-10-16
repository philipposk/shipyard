---
name: video
description: Make a motion-designed product video of the student's app (promo, feature walkthrough, how-to) with an AI voice, light and dark, wide and phone cuts, no screen recording. Use for "video", "product video", "demo video", "promo", "explainer", "how-to video", "trailer for my app", or "/shipyard:video".
---

# Shipyard video

You make a short, polished video of the student's own app: its screens are rebuilt as code from the app's real colours and fonts, an AI voice narrates, and every animation lands on a spoken word. One set of scenes renders as light, dark, phone (9:16) and silent-with-captions cuts. No screen recording, no editing software.

## Rules (always)

- You do the work. Run the scripts and commands yourself. The student reads the script, says yes, and watches the result.
- Never ask for keys in the chat and never read `~/.shipyard/secrets.env` or any `.env*` file (including `video/.env`; there is none). Keys go in the Shipyard keys file (`node "${CLAUDE_PLUGIN_ROOT}/scripts/secrets-init.mjs"` opens it). The voice script hands them to the engine privately and prints only names.
- Plain English, short messages, one question at a time with your recommended answer. Explain any new word in five words or fewer.
- **The script is approved before any voice is made.** Voice costs a few cents per minute and every re-voice costs again.
- Verify with your own eyes: look at stills and the contact sheet with the Read tool. Do not hand image checks to a helper. Say what you checked and what you did not.
- Invented company, people and numbers only, in every scene. No real customer data, no real names or emails, no screenshots of real accounts. Use only the student's own colours, fonts and logo; never imitate another company's brand.
- One render or install at a time, in the foreground. Never start a dev server or a render in the background.
- Saving to GitHub is the student's call: ask "OK to save this to GitHub?" first. Never push to a branch that publishes automatically once the app is live; use a branch and a pull request.
- Helper agents, if any: one model cheaper than yours and mechanical work only (renaming, a repeated edit). Scene design, the script and all visual checks stay on your model.

## 0. Tell the student what this takes (before anything else)

Say it plainly and let them choose:

- 2 to 4 hours of back-and-forth for a good result, and a big share of a Pro plan's usage. Best done after the app is live (`/shipyard:launch`), not before.
- Voice: a few cents per minute of speech (an OpenAI key; see `/shipyard:setup` AI keys step). Rendering is free and local. Needs ffmpeg (a free video tool); the setup script says how to install it.
- Remotion, the tool that turns code into video, is free for individuals and companies of up to 3 people. Bigger companies need a paid licence: remotion.dev/license.
- The voice is synthetic. Anywhere the video is shown, add "Narrated with an AI voice".

Find the app: the current folder if it has `.shipyard-app.json`, otherwise `node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show` lists apps. Ask only what is unclear: promo (30 to 60 s) or how-to for one feature (15 to 40 s), who it is for, and the call to action (the last line, for example "Try it free").

## 1. Set up the tools

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-setup.mjs" <appDir>`

Copies the video engine (one fixed, tested version) into `<appDir>/video/`, installs it (a few hundred MB, once, a few minutes), and renders a small made-up example as a check. Read the contact sheet picture it prints (Read tool) to confirm it shows "Acme Tasks" scenes. If ffmpeg is missing it prints the install line; install it, then run again. Later: `video-setup.mjs <appDir> --update` refreshes the engine and never touches the student's own work.

Then read `<appDir>/video/README.md` completely. It is the engine's manual; this skill is the workflow, so do not repeat it to the student.

## 2. Study the app, then write the script

Read `references/script.md` now. In short: list the features that are really shipped, read the real design tokens (`src/app/globals.css`, `DESIGN.md`, `BRAND` in `src/lib/constants.ts`, `public/icon.svg`), read the app's own copy for the hero line, invent ONE consistent fake scenario, then write `video/src/scripts/<tag>.json`.

**Show the script to the student in plain text and wait for a yes.** Then check it costs nothing yet:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-voice.mjs" <appDir> --tag <tag> --dry-run` (checks the file and which keys exist; spends nothing).

## 3. Make the voice

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-voice.mjs" <appDir> --tag <tag>`

Options: `--provider openai|gemini|deepgram`, `--voice <name>`, `--pace fast`, `--retime`. It makes the audio, the word timings, `video/src/timelines/<tag>.json` and captions `video/out/<tag>.vtt`. A missing key is reported by name: tell the student to add it to the keys file (open it with `secrets-init.mjs`), then run again. OpenAI is the default; a Deepgram key (`DEEPGRAM_API_KEY`, add the line by hand) gives tighter word timings; Gemini needs `GEMINI_API_KEY`. Re-running only voices changed lines.

## 4. Build the scenes

Read `references/scenes.md` now. Copy `video/src/acme` to `video/src/<tag>`, rebuild one small piece of the app's UI per scene using its real tokens, time every animation to spoken words, register the product in `video/src/products.json` and `video/src/products.ts`, then run `cd "<appDir>/video" && npx tsc --noEmit`.

## 5. Check with stills, then render

Read `references/qa-render.md` now. Stills (single frames) are cheap and fast: fix with stills first. Then:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-render.mjs" <appDir> <tag>:light [<tag>:dark] [<tag>:light::vertical] [<tag>:light::silent]`

It renders one cut at a time, checks for dead air (a frozen stretch over half a second) and loudness, and prints a contact sheet path per cut. Read each sheet. Fix, re-render only what changed.

## 6. Publish the web copy

Read `references/publish.md` now. `node "${CLAUDE_PLUGIN_ROOT}/scripts/video-publish.mjs" <appDir> <render-name>` makes a web mp4 under 10 MB, a poster and captions in `<appDir>/public/video/` and prints the snippet to paste. Offer to add a video section to the home page (follow the app's `AGENTS.md`: tokens only, designed states). Commit and deploy only with the student's yes.

## 7. Finish

Report: the output paths (mp4s, posters, captions), the list of cuts made, anything not verified (for example "silent cut checked by stills only"), and the reminder to show "Narrated with an AI voice". Delete old renders from `video/out/` (each is several MB). Save a short lesson to `~/.shipyard/learnings.md` if you hit a new problem.

## If something fails

Every script says what to do in plain words and accepts `--help` and `--json`. Setup, voice and publish can be run again safely. If a render fails, read the last lines it shows; the usual causes are a typo in a scene file (run `npx tsc --noEmit` in `video/`), a scene id that does not match the script, or a missing timeline (run the voice step). Do not work around a script by touching keys or `.env` files.
