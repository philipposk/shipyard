# Study the app and write the script

The engine is already in `<appDir>/video/`. Everything below happens before any voice is made, so it costs nothing.

## 1. Study the app (write nothing yet)

1. **List what is shipped.** Walk the app's routes and components and write down each feature with the file behind it. Only shipped features go in the video. A feature that is half built does not.
2. **Read the real look.** Colours, fonts, corner radius, border or shadow style, and the logo:
   - `src/app/globals.css` (the CSS variables, light and dark) and `DESIGN.md`
   - `src/lib/constants.ts` (`BRAND` name and tagline) and `public/icon.svg` (logo)
   - fonts: `src/lib/fonts.ts` or the layout file. Most are Google fonts, which the video can load too.
3. **Read the app's own words.** Home page copy, `README`, `SPEC.md`: the hero line, the pitch, real prices if payments exist. Do not invent claims.
4. **Invent ONE fake scenario** that every scene reuses: a made-up person, a made-up project or recipe or client, the same numbers everywhere. It should feel real and stay consistent. No real names, emails or customer data, ever.
5. **Pick the goal and length.** Promo: 30 to 60 s. How-to for one feature: 15 to 40 s. Ask the student only if the audience or the call to action is unclear.

## 2. Write `video/src/scripts/<tag>.json`

The tag is a short word for this cut (for example `launch`). The file is a list with one line per scene:

```json
[
  {"id": "hook",  "text": "Meet Recipe Box. Your recipes, finally in one place.", "minSec": 4.4},
  {"id": "add",   "text": "Paste a link or type it in, and it lands on your shelf.", "minSec": 4.4,
   "caption": "Paste a link or type it in: it lands on your shelf."},
  {"id": "end",   "text": "Recipe Box. Cook more, search less. Try it free.", "minSec": 4.6, "holdSec": 0.6}
]
```

- `id`: the scene's name. The scene component in `video/src/<tag>/Demo.tsx` is looked up by it. Letters, numbers, dashes.
- `text`: exactly what is spoken.
- `caption`: the on-screen text for the silent cut (`""` for none). Give every line one.
- `minSec`: the scene is at least this long. Keep it close to the voice length.
- `holdSec`: extra hold at the end, usually on the end card (about 0.6).
- `speed`: a minimum speaking speed for a line that sounds slow (for example 1.08).

### Rules

- About 110 words for about 55 seconds. One idea per line, short sentences, concrete nouns, words a stranger understands.
- Structure that works: hook, name reveal, input, core result, organisation, one or two special features, sharing, end card with the name and a call to action. A repeated phrase gives rhythm.
- Every claim maps to a shipped feature. No speed claims ("in seconds") unless you measured it. No "best", "revolutionary" or other hype words.
- Say the product's name in the reveal and on the end card.
- No hard pause after a single word ("One: ..."). Write "First, ...". The voice step caps pauses and can clip it.
- No dead air: scene length minus (lead + voice) should be about 1 second or less, unless an animated end card fills it. Extra `minSec` needs matching motion.
- Never mention a real company, person or customer.
- Spell the product name the way the app does. Captions use the script's spelling, so a brand word the speech recogniser mangles still reads right.

## 3. Get the student's yes

Show the script as plain text: one line per scene with the caption, total words, and about how many seconds. Say: "This is what the voice will say. Changing a line later costs a few cents to redo." Wait for a clear yes. Change what they ask and show it again.

Then `video-voice.mjs <appDir> --tag <tag> --dry-run` checks the file and the keys without spending anything.
