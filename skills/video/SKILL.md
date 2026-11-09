---
name: video
description: "Make a motion-designed product video of the student's app (promo, feature walkthrough, how-to) with an AI voice, light and dark, wide and phone cuts. Use for \"video\", \"product video\", \"demo video\", \"promo\", \"explainer\", \"how-to video\", \"trailer for my app\", \"YouTube video of my app\", or \"/shipyard:video\". No .shipyard-app.json: offer the new-app upgrade and wait for a yes; after it, the video works on that app too."
---

# Shipyard video

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.

You make a short, polished video of the student's own app: an AI voice narrates, and every animation lands on a spoken word. One set of scenes renders as light, dark, phone (9:16) and silent-with-captions cuts. No editing software. There are three ways to show the app:

- **Rebuilt UI** (the default): the screens are rebuilt as code from the app's real colours and fonts. Sharp at any zoom, quickest to change.
- **Real-app footage**: when the video must look exactly like the app. The app gets practice pages that show its real components on made-up data, they are recorded, and the recording plays inside the same scenes. Never a signed-in live app.
- **Real run** (advanced, Mac only): when the video must prove something really happens, for example a coding agent fixing and deploying a demo site live. A screen recording of the real thing, cut and sped up where marked. Only when the student asks for that proof; it needs a separate demo site and the student at the keyboard.

## First: which app is this?

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/which-app.mjs" <app folder>` on the current folder when that folder is the app.

- The output says `shipyard`: this folder was made by Shipyard. Continue with the steps below.
- The output says `general`: this is an existing app Shipyard did not make. Do not stop. If they asked to review or improve the app, offer new-app's `references/upgrade.md` and wait for a yes before starting it: a video brings visitors, so the app must be safe for them first, and the upgrade offers the video at its end. If they asked for a video and the upgrade is already done (no **Fix now** item left, the app is live), continue below and add `--general` to `video-setup.mjs` and `video-publish.mjs`. Its colours and fonts are wherever its own styles keep them, not in the Shipyard files named in step 2. Shared preflight: new-app's `references/which-app.md`.
- The output says `damaged`: `.shipyard-app.json` is here but broken. Say so. Do not treat the folder as a general app.

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

- You run the scripts and commands yourself. The student reads the script, listens to the key lines, says yes, and watches the result.
- **The script is approved before any voice is made.** Voice costs a few cents per minute and every re-voice costs again.
- Verify with your own eyes: look at stills and the contact sheet with the Read tool. Do not hand image checks to a helper. Say what you checked and what you did not.
- Invented company, people and numbers only, in every scene and every recording. No real customer data, no real names or emails, no screenshots or recordings of real accounts. Use only the student's own colours, fonts and logo; never imitate another company's brand.
- What the video says is benefits for a new viewer only: no changelog lines ("now", "no longer", a recent fix), nothing obvious.
- One render, recording or install at a time, in the foreground. Never start a dev server or a render in the background (`video-capture.mjs` starts the app and stops it again inside one call).
- Publishing is the student's call too: they upload to YouTube or anywhere else themselves, Private first. Never delete or replace a published video for them.
- Helper agents, if any: a smaller, cheaper model and mechanical work only (renaming, a repeated edit). Scene design, the script and all visual checks stay on your model.

## 0. Tell the student what this takes (before anything else)

Say it plainly and let them choose:

- 2 to 4 hours of back-and-forth for a good result, and a big share of a Pro plan's usage. Best done after the app is live (`/shipyard:launch`), not before. Real-app footage adds practice pages to the app (one pull request) and a few more hours.
- Voice: a few cents per minute of speech (an OpenAI key; see `/shipyard:setup` AI keys step). Gemini voices are an option, with daily free-tier limits (`references/voice.md`). Rendering is free and local. Needs ffmpeg (a free video tool); the setup script says how to install it, and a few GB of free disk.
- Remotion, the tool that turns code into video, is free for individuals and companies of up to 3 people. Bigger companies need a paid licence: remotion.dev/license.
- The voice is synthetic. Anywhere the video is shown, add "Narrated with an AI voice".

Find the app: the current folder if it has `.shipyard-app.json`, otherwise `node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show` lists apps. Ask only what is unclear: promo (30 to 60 s) or how-to for one feature (15 to 40 s), who it is for, the language it speaks, and the call to action (the last line, for example "Try it free"). Recommend rebuilt UI unless the student needs the real screens; then real-app footage.

## 1. Set up the tools

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-setup.mjs" <appDir>` (add `--general` for an app Shipyard did not make, after the upgrade)

Copies the video engine (one fixed, tested version) into `<appDir>/video/`, installs it (a few hundred MB, once, a few minutes), and renders a small made-up example as a check. Read the contact sheet picture it prints (Read tool) to confirm it shows "Acme Tasks" scenes. If ffmpeg is missing it prints the install line; install it, then run again. Later: `video-setup.mjs <appDir> --update` refreshes the engine and never touches the student's own work.

Then read `<appDir>/video/README.md` completely. It is the engine's manual; this skill is the workflow, so do not repeat it to the student.

## 2. Study the app, then write the script

Read `references/script.md` now. In short: list the features that are really shipped, read the real design tokens (`src/app/globals.css`, `DESIGN.md`, `BRAND` in `src/lib/constants.ts`, `public/icon.svg`), read the app's own copy for the hero line, invent ONE consistent fake scenario, then write `video/src/scripts/<tag>.json` and register the product in `video/src/products.json` and `video/src/products.ts` now, before the voice: a voiced script that no product lists is skipped and cannot be rendered.

**Show the script to the student in plain text and wait for a yes.** Then check it costs nothing yet:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-voice.mjs" <appDir> --tag <tag> --dry-run` (checks the file and which keys exist; spends nothing).

## 3. Make the voice

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-voice.mjs" <appDir> --tag <tag>`

Options: `--provider openai|gemini|deepgram|eleven`, `--voice <name>`, `--pace fast`, `--retime`. It makes the audio, the word timings, `video/src/timelines/<tag>.json` and captions `video/out/<tag>.vtt`. A missing key is reported by name: tell the student to add it to the keys file (open it with `secrets-init.mjs`), then run again. OpenAI is the default; a Deepgram key (`DEEPGRAM_API_KEY`, add the line by hand) gives tighter word timings; Gemini needs `GEMINI_API_KEY`. Re-running only voices changed lines.

After the script is approved, read `references/voice.md`: picking key lines by ear, fixing one line without touching the rest, another language, provider quotas, pacing, and lines for people talking inside the video.

## 4. Build the scenes

Rebuilt UI: read `references/scenes.md` now. Copy `video/src/acme` to `video/src/<tag>`, rebuild one small piece of the app's UI per scene using its real tokens, time every animation to spoken words, then run `cd "<appDir>/video" && npx tsc --noEmit`.

Real-app footage: read `references/footage.md` now. Add practice pages to the app, write a capture file, record it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/video-capture.mjs" <appDir> <capture> --page <path>`, then build the scenes on the recording with `<Footage>`.

Real run: read `references/real-run.md` now, and plan the take with the student before anything is recorded.

## 5. Check with stills, then render

Read `references/qa-render.md` now. Stills (single frames) are cheap and fast: fix with stills first. Then:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/video-render.mjs" <appDir> <tag>:light [<tag>:dark] [<tag>:light::vertical] [<tag>:light::silent]`

It renders one cut at a time, checks for dead air (a frozen stretch over half a second) and loudness, and prints a contact sheet path per cut. Read each sheet. Fix, re-render only what changed. It stops early when the disk is nearly full or another video render is running on the computer; long real-app footage may need `--low-memory`. Add `--youtube` for a master that goes to YouTube: it makes the sound as loud as YouTube expects and renders at 1440p, so the app's text stays sharp there. A render that runs out of memory is tried once more by itself, one frame at a time.

## 6. Publish the web copy

Read `references/publish.md` now. `node "${CLAUDE_PLUGIN_ROOT}/scripts/video-publish.mjs" <appDir> <render-name>` makes a web mp4 under 10 MB, a poster and captions in `<appDir>/public/video/` and prints the snippet to paste. Offer to add a video section to the home page (follow the app's `AGENTS.md`: tokens only, designed states). Commit and deploy only with the student's yes.

## 7. YouTube and other sites

If the student wants it on YouTube, read `references/youtube.md`. They upload the full-quality render from `video/out/` (rendered with `--youtube`) themselves, Private first; you prepare the title, description and subtitles. Turn off YouTube's automatic subtitles when the video shows its own captions.

## 8. Finish

Report: the output paths (mp4s, posters, captions), the list of cuts made, anything not verified (for example "silent cut checked by stills only"), and the reminder to show "Narrated with an AI voice". Delete old renders from `video/out/` (each is several MB), keeping the `--youtube` master until the student has uploaded it. Save a short lesson to `~/.shipyard/learnings.md` if you hit a new problem.

## If something fails

Every script says what to do in plain words and accepts `--help` and `--json`. Setup, voice, capture and publish can be run again safely. If a render fails, read the last lines it shows; the usual causes are a typo in a scene file (run `npx tsc --noEmit` in `video/`), a scene id that does not match the script, a missing timeline (run the voice step), or the computer running out of memory or disk ("disk space is low": see `references/qa-render.md`). Do not work around a script by touching keys or `.env` files.
