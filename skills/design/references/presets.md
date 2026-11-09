# The 8 ready-made looks

Pick by feeling, not by colour. A look sets more than colours: the homepage style, how cards and buttons feel, and the text size. Every look has a light and a dark version and passes the readability checks. Use the id with `apply-design.mjs <app> --preset <id>`.

| Id | Name | Feels like | Good for |
|---|---|---|---|
| `calm-blue` | Calm and clear | Soft grey-white pages, one friendly blue, gently rounded. The starter look. System font. | General apps, first projects |
| `clean-mono` | Clean monochrome | Near-black on white, thin crisp lines, tight corners. Inter. | Tools, dashboards, SaaS, lots of data |
| `warm-friendly` | Warm and friendly | Cream background, terracotta accent, soft round corners. DM Sans. | Community, lifestyle, food, hobbies |
| `editorial` | Editorial | Paper-white pages, ink-black text, serif headings, ink-blue accent, no shadows. Made for reading. | Blogs, writing, news, content-first apps |
| `fresh-green` | Fresh and healthy | Mint-white pages, deep leaf green, round and easy shapes. Manrope. | Health, habits, learning, fitness |
| `playful` | Playful | Sunny cream pages, bold tangerine accent, big round shapes, chunky headings. | Games, kid-friendly learning, social |
| `night-tech` | Night tech | Dark by default, near-black blue-grey, electric cyan, sharp lines. IBM Plex Sans. | Developer tools, gaming, music |
| `soft-pastel` | Soft pastel | Lilac-grey pages, dusty rose accent, very round corners. Nunito. | Wellbeing, journaling, kids, mindfulness |

If the student cannot decide: `calm-blue` for most apps, `clean-mono` for tools, `warm-friendly` for anything social.

Saved looks (from screenshots, a website or a DESIGN.md, saved with `--set-default`) also work with `--preset <id>`.

Each look records a menu, homepage, card, button and spacing style. The design skill passes `--keep-layout` unless the student asked for that look's menu, so applying a preset keeps the app's current navigation. Drop the flag only when they asked for the look's menu too.

## The gallery

`node "${CLAUDE_PLUGIN_ROOT}/scripts/design-gallery.mjs" --app <appDir>` opens a page showing the 8 looks on a phone and on a computer screen, light and dark. Add `--real` to see the looks on their own app instead of the pictures (takes about a minute, needs `npm install` first); offer it, don't force it. Before `--real`, write the app's real home words in `<appDir>/src/lib/home-content.ts` (otherwise every look is shown with the template's filler text; the script warns). They click "Use this look" and paste the sentence back. If they just name a look, skip the gallery.
