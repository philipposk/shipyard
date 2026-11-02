# Lessons

From making these packs on a real app (Catchy, Nov 2026). A star means a test or script guards it.

## What people say, and what to change

| They say | Change |
|---|---|
| "Too dark" | Lift the page off black: warm or slate graphite, not `#0b0d12`. Keep their hue family |
| "The boxes don't stand out" | Lighter card fill and a brighter border, in dark above all. Don't add heavier shadows: on dark they don't show |
| "Too purple" | Change the button colour, the background wash and the leftovers: info colours, focus ring, selection, avatar tint, logo gradient. Purple hides in all of them |
| "I don't like the orange" (or any button colour) | Change the button, link, glow, selection colours and any tinted background together. Use a colour already in the look when one fits: Studio's sage became its forest green |
| "Make it happier" | Warm light page, white cards, a sunny button colour, rounder shapes, a rounded heading. Give it a dark version too |
| "I like that one" with several on screen | Ask which one. Do not guess |

## What a colour swap gets wrong

- ★ A dark look needs a page well above black and cards that clearly separate. The `rules` command rejects near-black pages and low card and border contrast.
- The layout can hide your work. An inset page canvas covered Sunny's wash, and a shared panel style made its panels butter instead of white. Look at real screens, not only the colour list.
- Colours written directly into styles survive a token change. Search for the old hex values and for glows in the page background.
- A main button can use a different rule from the others. "+ New" kept the old colour until it was named directly. Check the buttons you care about one by one.
- The recording dot used the button colour, so changing buttons would have turned it green. Status colours get their own variables.
- A variable with an old purpose may have other users. Catchy's `--violet-*` also coloured notifications and marketing text, so making it dark to fix an avatar would have hidden that text. Search for every use, and give the new purpose its own variable.
- Yellow fails with white text. Very light buttons carry dark text, and links need another colour.
- A stale `.next` folder can fail a type check after a big pull. Delete it and build again before you suspect your change.

## How to work

- Read the latest main branch first. The first review of Catchy judged a checkout 45 commits behind, proposed things that already existed and guessed the wrong setting.
- When someone says they prefer "the one in Settings", find the exact words in the code and the setting. Look (colours) and layout (where things are) can be two separate settings.
- Mockups can be wrong about the app. Say what was only drawn, and what was seen running.
- Test headings with real text in each alphabet the app has, and confirm with `document.fonts` that the font loaded.
- Take preview images from real screens with a script, so they can be taken again after the next change.
- Playwright's own browser can be missing or the wrong version. `chromium.launch({ channel: "chrome" })` uses the Chrome already installed, with nothing to download.
