# <APP_NAME> design

## Look

Calm and clear. Soft grey-white pages, one friendly blue accent, gently rounded corners. Good for general apps, first projects, anything that should just feel clean.
Light is the default; dark switches on with `data-theme="dark"` on `<html>`, set before the first paint by the small script in `src/app/layout.tsx`. The person's choice (`light`, `dark` or `system`) is saved in `localStorage` under `theme`.

## Colours

Defined in `src/app/globals.css` between the `shipyard:tokens:light` and `shipyard:tokens:dark` markers. Never write a colour value in a component; use these variables (and `--accent-soft`, a pale mix of the accent and the card).

| Use | Variable | Light | Dark |
|---|---|---|---|
| page background | `--background` | `#f6f7f9` | `#0e1116` |
| main text | `--foreground` | `#14161a` | `#eceff4` |
| card background | `--card` | `#ffffff` | `#171b22` |
| grey text | `--muted` | `#5b6270` | `#9aa3b2` |
| thin lines | `--line` | `#e3e6eb` | `#262c36` |
| input borders | `--line-strong` | `#b9bfca` | `#3a4250` |
| accent colour | `--accent` | `#2563eb` | `#6b9bff` |
| text on accent buttons | `--accent-contrast` | `#ffffff` | `#0a0f1a` |
| keyboard focus outline | `--focus` | `#2563eb` | `#6b9bff` |
| error colour | `--danger` | `#c0362c` | `#ef6a5e` |
| text on error buttons | `--danger-contrast` | `#ffffff` | `#14161a` |

## Type

Body: the device font (system). Headings: same as body, weight 700, letter spacing normal. Loaded in `src/lib/fonts.ts` and used through `--app-font` and `--heading-font`.
Text size is comfortable: body 16px, `h1` 31.5px (smaller on phones), `h2` 25px, `h3` 20px. They come from the variables `--font-size-base`, `--h1-size`, `--h2-size`, `--h3-size`, `--heading-weight` and `--heading-tracking`; never type a size into a component. Inputs stay 16px or bigger. One `h1` per page.

## Layout

Written by the design step; change it there. The shape variables sit in `src/app/globals.css` between the `shipyard:tokens:shape` markers.

- Menu: tabs at the bottom (`bottom-nav`, `LAYOUT` in `src/lib/constants.ts`). On phones every layout shows a tab bar at the bottom.
- Homepage: one centred message (`focus`, `HOME_STYLE` in `src/lib/theme.ts`). The words on it live in `src/lib/home-content.ts`.
- Cards: a thin outline (`bordered`).
- Buttons: filled, with the button corner size (`solid`).
- Top bar: on a card-coloured bar with a line underneath (`bar`).
- Spacing: regular. Unit 6px, card padding 16px, gaps 12px.
- Page width: medium, up to 960px.

Cards, buttons and the top bar take their style from `data-cards`, `data-buttons` and `data-header` on `<html>` (from `LOOK` in `src/lib/theme.ts`). Use `.card`, `.btn`, `.btn-primary`, `.btn-secondary` and `.app-header` and the look follows; do not restyle them per page.

## Corners and depth

Cards use `--radius` (14px, rounded). Buttons and inputs use `--radius-sm` (10px).
Depth: a soft shadow (`--shadow: 0 6px 24px rgba(0, 0, 0, 0.07)`).

## Rules

- One accent colour. No gradients, no purple glow, no gradient text.
- Colours only through the variables above, so dark mode keeps working. Use the classes in `globals.css` (`.btn`, `.card`, `.input`, `.list-row`) before writing new CSS.
- No em dashes in text people read. No emoji as icons. No fake numbers, reviews or "trusted by".
- 44px touch targets, visible focus, respect reduced motion.
- Empty, loading and error states are designed, not blank.
- Run `npm run check:design` before saying a screen is done.

## Source

A ready-made Shipyard look: "Calm and clear" (`calm-blue`).
Change it with `/shipyard:design`. That rewrites this file, the colour block in `globals.css`, `src/lib/theme.ts` and `src/lib/fonts.ts` together, so edit through the design step, not by hand.
