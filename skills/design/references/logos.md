# Logos: the app icon and the browser tab

Use this when someone wants a real logo instead of the letter `design-icons.mjs` draws. "Logo" here means the picture on the browser tab and the installed app, in a light and a dark version that follow the device setting.

## Rules

- Draw it from their own brand: the animal, object or art they already use. Never copy another company's logo.
- Nothing ships until they say yes. Show the sheet, change what they ask for, ask again.
- Draw flat shapes by hand in SVG. No text (fonts differ per device), no gradients, no scripts, no linked files.
- If the drawing is still weak after a few tries, say so plainly and name what is off. Do not call it finished to end the loop.

## The drawing that works

A full square, 512 by 512, with no rounded corners (the tool adds them where needed):

1. **A tile:** a rectangle filling the square, first in the file. A soft warm colour in light mode, near black in dark mode.
2. **A disc:** a circle in the brand colour, `cx="256" cy="256" r="228"`. It does most of the work: it reads at 16 pixels and turns any phone's cut into a clean shape.
3. **One subject** in two or three flat colours, on the disc. Keep what matters inside the middle circle (radius 205), because phones may cut the rest away.

Only the tile changes much between light and dark, and the disc may shift a shade. The subject stays the same, so the logo stays recognisable.

Lessons from drawing real ones:

- **Dark parts go on the disc, never on the tile.** A panda's black ears vanished on a dark tile until the whole animal moved onto the disc.
- **Faces that are the same on both sides go head-on.** A panda is round head, ears, eye patches, nose. Make the patches big: they are what survives at small sizes.
- **Animals known by their outline go side-on.** Draw the long, low head of a rhino, not a short one, and make the telling part big and in a contrasting colour. An orange horn on an orange disc disappeared, and a near-black one made it a rhino.
- **Ears give the animal away.** Large pointed ears in a bright colour turned a rhino into a fox. Keep them small and in the body colour.
- **Let a neck run off the edge.** Clip it to the disc with a `clipPath` instead of inventing a bottom edge for it.
- **One detail of character is enough** (sunglasses, for example). Say goodbye to wrinkles and stripes: at tab size they turn to noise.

Optional `logo-mono.svg`: the same subject in one colour on see-through, with the dark details cut out. Phones that tint icons use it.

## Steps

1. Save drafts as `logo-light.svg` and `logo-dark.svg` in `<appDir>/design-input/` (it is not published).
2. Draw the sheet and look at it yourself first:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-logo.mjs" <appDir> --light design-input/logo-light.svg --dark design-input/logo-dark.svg --sheet design-input/logo-sheet.png --name "<App name>"`
   Check the 16 and 32 pixel versions, the browser tab, and the circle. Expect a few rounds: fix what fails before showing it.
3. Show them the sheet and ask. Change it until they say yes.
4. Move the approved drawings to `public/brand-approved/` as `logo-light.svg`, `logo-dark.svg` and, if you made one, `logo-mono.svg`. From then on `design-icons.mjs` only redraws the share image and leaves these icons alone.
5. Make the icons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-logo.mjs" <appDir>`
6. Put the tags it prints in the head of each page, replacing the old icon and manifest tags. In a Next.js app, set them in `metadata.icons` in `src/app/layout.tsx` (each with its `media`, and `icon.svg` last), and add the manifest swap as a `next/script` with `strategy="beforeInteractive"`. Add the new files to the `SHELL` list in `public/sw.js` if the app has one.

An app with no Playwright (not made by Shipyard, or a plain website): install it in a spare folder with `npm install playwright` and add `--tools <that folder>`. For several brands in one site, use `--prefix`, `--out`, `--base` and `--manifest`.

## What follows the device, said honestly

| Where | Follows light and dark? |
|---|---|
| Browser tab | Yes. Most browsers use `icon.svg`; the others use the PNG tags. Some only change it after a reload. |
| Installing the app (Android, desktop) | The icon of the mode the device is in at that moment, and it stays that way. |
| Installed app on Android, with themed icons on | Yes, tinted by the phone, using `logo-mono.svg`. |
| iPhone home screen | One icon, chosen when it is added. iOS 18 can tint it by itself. |

Tell them this up front, so an installed icon that stays the same is not a surprise.
