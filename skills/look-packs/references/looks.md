# The three packs

The data for each is in `packs.json`. Every pack has a light and a dark version. Names are feelings, so they fit any app.

| Pack | Light | Dark | Feels | Good for |
|---|---|---|---|---|
| `studio` | Warm paper, forest green buttons, serif headings | Warm graphite, sage buttons, clearly lifted cards | Calm, grown up, made for reading | Tools, notes, anything with long text. The safe default |
| `glass` | Frosted cards on a sky, sand and mint wash, deep-sky buttons | Lighter glass on slate and teal, sky-blue buttons | Modern, airy | Dashboards, consumer apps, anything shown off |
| `sunny` | Butter page, white cards, sunshine-yellow buttons, rounded headings | Warm dark with yellow buttons | Happy, friendly | Community, learning, habits, kids, anything that should cheer people up |

## What is in `packs.json`

`tokens` holds the seven colours `theme-packs.mjs` checks: `bg` page, `surface` cards, `text`, `muted` quiet text, `border`, `accent` buttons, `onAccent` text on buttons. `extra` holds the rest as CSS variables:

| Variable | What it is for |
|---|---|
| `--link` | Link text. Sunny needs this: yellow is unreadable as text |
| `--surface-raised`, `--field`, `--line-field` | Raised tiles, input fills, input borders |
| `--selected-bg`, `--selected-bar` | The chosen menu item or tab |
| `--ring` | The keyboard focus ring |
| `--rec` | The recording dot. Stays red |
| `--avatar-bg`, `--avatar-fg` | A person's initial in the account menu |
| `--glow` | The soft shadow under the main button |
| `--wash` | Glass and Sunny's soft background colours. Put it on a fixed layer or `background-attachment: fixed`, so scrolling repaints nothing |
| `--card-glass`, `--blur` | Glass only: the see-through card and its blur. Keep `surface` as the solid fallback for browsers without blur and for people who ask for less transparency |
| `--radius`, `--radius-control`, `--radius-button` | Corners for cards, inputs and buttons |

`heading` names the heading font and weight. Newsreader has no Greek or Cyrillic of its own, so pair it with a serif that does (Catchy uses Noto Serif for Greek). M PLUS Rounded 1c has Greek and Cyrillic.

## Making more like these

Start from the closest pack and change one idea at a time. These are what made these three work:

1. **Pick a feeling first**, in a word or two. Name the pack after it. Never a colour alone, never a brand.
2. **Build dark from the same family as light.** Warm paper gets warm graphite. A cool wash gets slate. Do not pair a warm day with a blue-black night.
3. **Keep dark clearly above black.** Page around `#141a20` to `#221e14`, cards a visible step lighter, and a border you can see. `rules` checks it.
4. **One button colour in each mode.** Keep the assistant or other special buttons apart with a second colour (Sunny's teal).
5. **Very light button colours carry dark text** and get a separate link colour.
6. **Let one more thing carry the feeling:** the heading font, the roundness, or the wash. One or two, not all.
7. **Make it truly different** from the packs already there. Five shades of one look is no choice.

Ideas to draft from, when the owner wants more: a dusk look (warm pink-grey by day, plum-free charcoal at night), a forest look (moss and cream), a newsprint look (black on off-white, one red), an ocean look (deep teal, sea-foam). Show them; do not assume.
