// Guesses the layout side of a look (menu, spacing, cards, buttons, text size, page width, homepage
// pattern) from what the page reported. Pure functions on the "PageData" from extract.mjs, so they can be
// tested with fixtures and no browser. Every guess also says why, in plain words.
import { fromArray, flatten, isTransparent } from './colors.mjs';

const median = (list) => {
  const a = list.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const share = (list, test) => (list.length === 0 ? 0 : list.filter(test).length / list.length);

/** Menu: a pinned left column = sidebar; a tab bar pinned to the bottom of the phone = bottom-nav; links across the top = top-nav. */
export function guessNav({ desktop, phone }) {
  if (desktop?.layout?.fixedLeft) return { value: 'sidebar', why: 'the menu is a tall column on the left' };
  if (phone?.layout?.fixedBottomBar) return { value: 'bottom-nav', why: 'the phone version has a tab bar at the bottom' };
  if ((desktop?.layout?.headerLinks ?? 0) >= 3) return { value: 'top-nav', why: 'the links sit in a row across the top' };
  if ((desktop?.layout?.headerLinks ?? 0) >= 2) return { value: 'top-nav', why: 'there are a few links across the top' };
  return { value: 'bottom-nav', why: 'no clear menu was found, so the phone-style default is used', none: true };
}

/** Spacing: how roomy the cards (or, without cards, the page sections) are. */
export function guessDensity({ desktop }) {
  const pad = desktop?.layout?.medianCardPadding;
  if (Number.isFinite(pad) && (desktop.cards?.length ?? 0) >= 2) {
    if (pad <= 13) return { value: 'compact', why: `cards have tight padding (about ${Math.round(pad)}px)` };
    if (pad >= 22) return { value: 'airy', why: `cards have generous padding (about ${Math.round(pad)}px)` };
    return { value: 'regular', why: `cards have medium padding (about ${Math.round(pad)}px)` };
  }
  const section = median(desktop?.layout?.sectionPadding ?? []);
  if (Number.isFinite(section) && section > 0) {
    if (section <= 40) return { value: 'compact', why: 'the page sections are close together' };
    if (section >= 88) return { value: 'airy', why: 'the page sections have a lot of space around them' };
    return { value: 'regular', why: 'the page sections have medium spacing' };
  }
  return { value: 'regular', why: 'spacing could not be measured, so the middle setting is used' };
}

/** Cards: shadow, outline, tinted fill or nothing. */
export function guessCards({ desktop }) {
  const cards = desktop?.cards ?? [];
  if (cards.length === 0) return { value: 'bordered', why: 'no cards were found, so the default outlined cards are used' };
  const shadowed = share(cards, (c) => c.shadow && (c.shadow.blur >= 4 || c.shadow.alpha >= 0.05));
  const outlined = share(cards, (c) => c.borderW >= 1);
  const filled = share(cards, (c) => c.filled);
  if (shadowed >= 0.5 && outlined < 0.5) return { value: 'elevated', why: 'the cards float on a soft shadow' };
  if (outlined >= 0.5) return { value: 'bordered', why: 'the cards have a thin outline' };
  if (filled >= 0.5) return { value: 'tinted', why: 'the cards are a different shade from the page, with no outline' };
  if (shadowed >= 0.5) return { value: 'elevated', why: 'the cards have a shadow' };
  return { value: 'flat', why: 'the blocks have no outline, shadow or fill' };
}

/** Buttons: pill, sharp, outline or solid, judged on the main buttons (not the menu links). */
export function guessButtons({ desktop }) {
  const all = (desktop?.buttons ?? []).filter((b) => b.h >= 22);
  const main = all.filter((b) => !b.inHeader);
  const pool = main.length >= 2 ? main : all;
  if (pool.length === 0) return { value: 'solid', why: 'no buttons were found, so plain solid buttons are used' };
  const pill = share(pool, (b) => b.radius >= Math.min(b.h / 2 - 1, 999) && b.radius >= 14);
  const sharp = share(pool, (b) => b.radius <= 2.5);
  const outline = share(pool, (b) => !b.filled && b.bordered);
  const upperSharp = share(pool, (b) => b.upper && b.radius <= 4);
  if (outline >= 0.6) return { value: 'outline', why: 'the buttons are outlined, not filled' };
  if (pill >= 0.5) return { value: 'pill', why: 'the buttons have fully round ends' };
  if (sharp >= 0.5 || upperSharp >= 0.5) return { value: 'sharp', why: 'the buttons have square corners' };
  return { value: 'solid', why: 'the buttons are filled with slightly rounded corners' };
}

/** Text size: how big the headings are compared with the body text. */
export function guessTypeScale({ desktop }) {
  const base = desktop?.body?.fontSize || 16;
  const h2 = desktop?.headings?.h2?.fontSize;
  const h1 = desktop?.headings?.h1?.fontSize;
  if (base <= 14.5) return { value: 'compact', why: `the body text is small (${Math.round(base)}px)` };
  if (base >= 17.5) return { value: 'large', why: `the body text is big (${Math.round(base)}px)` };
  // The look's own sizes: h2 is 1.44 / 1.56 / 1.78 times the body text and h1 is 1.73 / 1.95 / 2.37 times it.
  // The cut-offs sit half way between neighbours.
  if (h2) {
    const ratio = h2 / base;
    const nice = `${ratio.toFixed(1)} times the body text`;
    if (ratio < 1.5) return { value: 'compact', why: `second-level headings are only ${nice}` };
    if (ratio < 1.7) return { value: 'comfortable', why: `second-level headings are ${nice}` };
    return { value: 'large', why: `second-level headings are ${nice}` };
  }
  if (h1) {
    const ratio = h1 / base;
    const nice = `${ratio.toFixed(1)} times the body text`;
    if (ratio < 1.84) return { value: 'compact', why: `main headings are only ${nice}` };
    if (ratio < 2.15) return { value: 'comfortable', why: `main headings are ${nice}` };
    return { value: 'large', why: `main headings are ${nice}` };
  }
  return { value: 'comfortable', why: 'no headings were found, so the middle size is used' };
}

/** Heading weight: the nearest of 500, 600, 700, 800. */
export function guessHeadingWeight({ desktop }) {
  const w = desktop?.headings?.h1?.fontWeight ?? desktop?.headings?.h2?.fontWeight ?? 700;
  const choices = [500, 600, 700, 800];
  const value = choices.reduce((best, c) => (Math.abs(c - w) < Math.abs(best - w) ? c : best), 700);
  return { value, why: `headings are weight ${w}` };
}

/** Letter spacing in headings. */
export function guessTracking({ desktop }) {
  const em = desktop?.headings?.h1?.letterSpacing ?? desktop?.headings?.h2?.letterSpacing ?? 0;
  if (em <= -0.012) return { value: 'tight', why: 'big headings are set a little tight' };
  if (em >= 0.006) return { value: 'wide', why: 'headings have open letter spacing' };
  return { value: 'normal', why: 'headings have normal letter spacing' };
}

/** Page width from the main content column. */
export function guessMaxWidth({ desktop }) {
  const widths = desktop?.layout?.containerWidths ?? [];
  const w = median(widths);
  if (!Number.isFinite(w)) return { value: 'medium', why: 'the content width could not be measured, so medium is used' };
  if (w <= 780) return { value: 'narrow', why: `the main column is narrow (about ${Math.round(w)}px)` };
  if (w <= 1100) return { value: 'medium', why: `the main column is medium width (about ${Math.round(w)}px)` };
  return { value: 'wide', why: `the main column is wide (about ${Math.round(w)}px)` };
}

/** Top bar: a bar, no bar, or the name in the middle. */
export function guessHeader({ desktop }, pageHex = '#ffffff') {
  const h = desktop?.layout?.header;
  if (!h) return { value: 'bar', why: 'no top bar was found, so the default bar is used' };
  if (h.brandCenter !== null && h.brandCenter !== undefined && Math.abs(h.brandCenter - 0.5) < 0.07) {
    return { value: 'centered', why: 'the name sits in the middle of the top bar' };
  }
  const bg = fromArray(h.bg);
  const visibleBg = bg && !isTransparent(bg, 0.5) && flatten(bg, pageHex) !== pageHex;
  if (h.bgDiffers || visibleBg || h.borderBottom || h.shadow) return { value: 'bar', why: 'the top bar has its own background or a line under it' };
  return { value: 'plain', why: 'the top bar blends into the page' };
}

/** Homepage pattern. */
export function guessHome({ desktop }, nav) {
  const l = desktop?.layout ?? {};
  if (l.heroSplit) return { value: 'split', why: 'the first screen has text on one side and a picture or preview on the other' };
  if (l.cardGrid) return { value: 'cards', why: `there is a grid of ${l.cardGrid.columns} cards in a row` };
  if (l.articleList) return { value: 'editorial', why: 'the page is a list of entries one under another' };
  if (nav === 'sidebar') return { value: 'list', why: 'an app-style page with a side menu' };
  return { value: 'focus', why: 'one centred message, no side-by-side blocks' };
}

/** All the layout fields at once -> { layout, type, reasons } ready for a token file. */
export function guessLayout({ desktop, phone }, pageHex = '#ffffff') {
  let nav = guessNav({ desktop, phone });
  const density = guessDensity({ desktop });
  const maxWidth = guessMaxWidth({ desktop });
  const home = guessHome({ desktop }, nav.value);
  // a website-style page with no menu we could find: links in the top bar suit it better than phone tabs
  if (nav.none && ['editorial', 'split', 'cards'].includes(home.value)) nav = { value: 'top-nav', why: 'it is a website-style page, so links in the top bar suit it' };
  const cards = guessCards({ desktop });
  const buttons = guessButtons({ desktop });
  const header = guessHeader({ desktop }, pageHex);
  const scale = guessTypeScale({ desktop });
  const weight = guessHeadingWeight({ desktop });
  const tracking = guessTracking({ desktop });
  return {
    layout: { nav: nav.value, density: density.value, maxWidth: maxWidth.value, home: home.value, cards: cards.value, buttons: buttons.value, header: header.value },
    type: { scale: scale.value, headingWeight: weight.value, headingTracking: tracking.value },
    reasons: { nav: nav.why, density: density.why, maxWidth: maxWidth.why, home: home.why, cards: cards.why, buttons: buttons.why, header: header.why, scale: scale.why, headingWeight: weight.why, headingTracking: tracking.why },
  };
}
