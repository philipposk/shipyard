// Draws a quick sketch from a few short lines ("title Notes", "list 4 check", "fab +") instead of
// hand-written SVG. The agent writes a handful of words per option; this file turns them into a
// consistent grey-box SVG. Fewer tokens to write, and every option is drawn the same way.

export const FRAMES = { phone: [180, 320], desktop: [360, 240], card: [240, 140] };
export const DEFAULT_ACCENT = '#2563eb';
const INK = '#111', MID = '#666', LINE = '#ccc', FILL = '#eee', BG = '#fff';
const PAD = 12;

/** The block words and what each draws, for --help, errors and the skill. */
export const BLOCK_HELP = [
  ['title <words>', 'screen title'],
  ['text <n>', 'n grey lines of body text (default 2)'],
  ['label <words>', 'one short line of real words'],
  ['input <placeholder> [| <button>]', 'a text field, with a button beside it if given'],
  ['button <words>', 'a full-width button'],
  ['list <n> [check] [done:<i,j>]', 'n rows; check adds tick boxes; done ticks those rows'],
  ['cards <n>', 'n taller cards with an image area'],
  ['image', 'an image or chart placeholder'],
  ['chips <a|b|c>', 'a row of small pills'],
  ['tabs <a|b|c>', 'a tab strip, the first one selected'],
  ['toggle <words> [on]', 'a settings row with a switch'],
  ['ghost <words>', 'a dashed "add" row'],
  ['space', 'empty gap'],
  ['sidebar <a|b|c>', 'desktop: a left menu; blocks after it go to the right'],
  ['fab <symbol>', 'pinned: a round floating button, bottom right'],
  ['footer <words>', 'pinned: a full-width button at the bottom'],
  ['nav <a|b|c>', 'pinned: a bottom tab bar'],
  ['sheet <title> [| <button>]', 'pinned: a bottom sheet over a dimmed screen'],
  ['toast <words>', 'pinned: a small message near the bottom'],
];
const KINDS = new Set(BLOCK_HELP.map(([w]) => w.split(' ')[0]));
const PINNED = new Set(['fab', 'footer', 'nav', 'sheet', 'toast']);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
const t = (x, y, s, size, fill, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`;
const bar = (x, y, w, fill = LINE) => r(x, y, w, 4, fill, ' rx="2"');
const split = (s) => String(s ?? '').split('|').map((p) => p.trim()).filter(Boolean);

/** Parse one block line: optional leading * (accent), a kind word, the rest. */
export function parseBlock(line) {
  const raw = String(line ?? '').trim();
  const accent = raw.startsWith('*');
  const body = accent ? raw.slice(1).trim() : raw;
  const m = /^([a-z]+)\b\s*(.*)$/.exec(body);
  if (!m || !KINDS.has(m[1])) return { error: `"${raw.slice(0, 40)}" is not a block. Blocks: ${[...KINDS].join(', ')}.` };
  return { kind: m[1], arg: m[2], accent };
}

/** Problems in a block list (unknown words, empty lists, a sidebar outside desktop). */
export function blockProblems(blocks, frame = 'phone') {
  const out = [];
  if (!FRAMES[frame]) out.push(`"frame" is phone, desktop or card, not "${frame}".`);
  if (!Array.isArray(blocks) || !blocks.length) return [...out, 'needs "blocks": a list of lines such as "title Notes".'];
  if (blocks.length > 14) out.push(`has ${blocks.length} blocks; a quick sketch needs at most 14.`);
  for (const b of blocks) {
    const p = parseBlock(b);
    if (p.error) out.push(p.error);
    else if (p.kind === 'sidebar' && frame !== 'desktop') out.push('"sidebar" only fits frame "desktop".');
  }
  return out;
}

/** Draw a block list as an SVG string. */
export function renderBlocks(blocks, { frame = 'phone', accent = DEFAULT_ACCENT } = {}) {
  const [W, H] = FRAMES[frame] ?? FRAMES.phone;
  const parts = [r(0, 0, W, H, BG, ` stroke="${LINE}"`)];
  const pinned = [];
  let x = PAD, w = W - PAD * 2, y = PAD;
  const tone = (b) => (b.accent ? accent : MID);
  for (const line of blocks) {
    const b = parseBlock(line);
    if (b.error) continue;
    if (PINNED.has(b.kind)) {
      pinned.push(b);
      continue;
    }
    const a = b.arg;
    switch (b.kind) {
      case 'title':
        parts.push(t(x, y + 14, a || 'Title', 14, b.accent ? accent : INK, ' font-weight="600"'));
        y += 24;
        break;
      case 'label':
        parts.push(t(x, y + 10, a, 10, b.accent ? accent : INK));
        y += 16;
        break;
      case 'text': {
        const n = Math.min(Number.parseInt(a, 10) || 2, 6);
        for (let i = 0; i < n; i++) parts.push(bar(x, y + 2 + i * 9, i === n - 1 ? w * 0.6 : w, b.accent ? accent : LINE));
        y += n * 9 + 6;
        break;
      }
      case 'input': {
        const [ph, btn] = split(a);
        const bw = btn ? Math.max(36, btn.length * 6 + 16) : 0;
        const iw = w - (btn ? bw + 6 : 0);
        parts.push(r(x, y, iw, 26, BG, ` rx="4" stroke="${b.accent ? accent : MID}"`));
        parts.push(t(x + 8, y + 17, ph || 'Type here', 10, '#999'));
        if (btn) {
          parts.push(r(x + iw + 6, y, bw, 26, b.accent ? accent : INK, ' rx="4"'));
          parts.push(t(x + iw + 6 + bw / 2, y + 17, btn, 10, BG, ' text-anchor="middle"'));
        }
        y += 34;
        break;
      }
      case 'button':
        parts.push(r(x, y, w, 28, b.accent ? accent : INK, ' rx="4"'));
        parts.push(t(x + w / 2, y + 18, a || 'Button', 11, BG, ' text-anchor="middle"'));
        y += 36;
        break;
      case 'list': {
        const n = Math.min(Number.parseInt(a, 10) || 3, 8);
        const check = /\bcheck\b/.test(a);
        const done = new Set((/\bdone:([\d,]+)/.exec(a)?.[1] ?? '').split(',').filter(Boolean).map(Number));
        for (let i = 1; i <= n; i++) {
          const ticked = done.has(i);
          parts.push(r(x, y, w, 30, BG, ` rx="4" stroke="${LINE}"`));
          let tx = x + 8;
          if (check) {
            parts.push(r(x + 8, y + 8, 14, 14, ticked ? accent : BG, ` rx="3" stroke="${ticked ? accent : MID}"`));
            if (ticked) parts.push(`<path d="M${x + 11} ${y + 15}l3 3 5-6" stroke="${BG}" stroke-width="2" fill="none"/>`);
            tx = x + 30;
          }
          const len = (w - (tx - x) - 16) * [0.8, 0.55, 0.7, 0.45, 0.65, 0.5, 0.75, 0.6][i - 1];
          parts.push(bar(tx, y + 9, len, ticked ? LINE : b.accent ? accent : MID));
          parts.push(bar(tx, y + 18, len * 0.45));
          y += 36;
        }
        break;
      }
      case 'cards': {
        const n = Math.min(Number.parseInt(a, 10) || 2, 4);
        for (let i = 0; i < n; i++) {
          parts.push(r(x, y, w, 64, BG, ` rx="6" stroke="${b.accent ? accent : LINE}"`));
          parts.push(r(x + 8, y + 8, 48, 48, FILL, ' rx="4"'));
          parts.push(bar(x + 64, y + 14, (w - 80) * 0.8, MID));
          parts.push(bar(x + 64, y + 26, (w - 80) * 0.5));
          y += 72;
        }
        break;
      }
      case 'image': {
        const h = Math.round(w * 0.5);
        parts.push(r(x, y, w, h, FILL, ' rx="4"'));
        parts.push(`<path d="M${x} ${y + h}L${x + w} ${y}" stroke="${LINE}"/>`);
        y += h + 8;
        break;
      }
      case 'chips': {
        let cx = x;
        split(a).forEach((c, i) => {
          const cw = c.length * 6 + 16;
          parts.push(r(cx, y, cw, 20, i === 0 && b.accent ? accent : FILL, ' rx="10"'));
          parts.push(t(cx + cw / 2, y + 14, c, 9, i === 0 && b.accent ? BG : INK, ' text-anchor="middle"'));
          cx += cw + 6;
        });
        y += 28;
        break;
      }
      case 'tabs': {
        const items = split(a);
        const tw = w / Math.max(items.length, 1);
        items.forEach((c, i) => {
          parts.push(t(x + tw * i + tw / 2, y + 12, c, 10, i === 0 ? INK : MID, ' text-anchor="middle"'));
          if (i === 0) parts.push(r(x + tw * i + 6, y + 18, tw - 12, 2, b.accent ? accent : INK));
        });
        parts.push(r(x, y + 20, w, 1, LINE));
        y += 28;
        break;
      }
      case 'toggle': {
        const on = /\bon$/.test(a);
        const label = a.replace(/\s*\bon$/, '');
        parts.push(t(x, y + 14, label || 'Setting', 11, INK));
        parts.push(r(x + w - 30, y + 3, 30, 16, on ? accent : LINE, ' rx="8"'));
        parts.push(`<circle cx="${on ? x + w - 8 : x + w - 22}" cy="${y + 11}" r="6" fill="${BG}"/>`);
        y += 26;
        break;
      }
      case 'ghost':
        parts.push(r(x, y, w, 28, BG, ` rx="4" stroke="${b.accent ? accent : MID}" stroke-dasharray="4 3"`));
        parts.push(t(x + 10, y + 18, a || '+ Add', 10, b.accent ? accent : MID));
        y += 36;
        break;
      case 'space':
        y += 16;
        break;
      case 'sidebar': {
        const items = split(a);
        const sw = 84;
        parts.push(r(0, 0, sw, H, FILL));
        items.forEach((c, i) => parts.push(t(PAD, PAD + 14 + i * 20, c, 10, i === 0 ? INK : MID, i === 0 ? ' font-weight="600"' : '')));
        x = sw + PAD;
        w = W - sw - PAD * 2;
        y = PAD;
        break;
      }
      default:
        break;
    }
  }
  for (const b of pinned) {
    const a = b.arg;
    const color = b.accent ? accent : INK;
    switch (b.kind) {
      case 'fab':
        parts.push(`<circle cx="${W - PAD - 18}" cy="${H - PAD - 18 - (pinned.some((p) => p.kind === 'nav') ? 40 : 0)}" r="18" fill="${color}"/>`);
        parts.push(t(W - PAD - 18, H - PAD - 12 - (pinned.some((p) => p.kind === 'nav') ? 40 : 0), a || '+', 18, BG, ' text-anchor="middle"'));
        break;
      case 'footer':
        parts.push(r(PAD, H - PAD - 30, W - PAD * 2, 30, color, ' rx="4"'));
        parts.push(t(W / 2, H - PAD - 11, a || 'Continue', 11, BG, ' text-anchor="middle"'));
        break;
      case 'nav': {
        const items = split(a);
        const tw = W / Math.max(items.length, 1);
        parts.push(r(0, H - 40, W, 40, BG, ` stroke="${LINE}"`));
        items.forEach((c, i) => {
          parts.push(`<circle cx="${tw * i + tw / 2}" cy="${H - 26}" r="5" fill="${i === 0 ? color : LINE}"/>`);
          parts.push(t(tw * i + tw / 2, H - 9, c, 8, i === 0 ? INK : MID, ' text-anchor="middle"'));
        });
        break;
      }
      case 'sheet': {
        const [title, btn] = split(a);
        const sh = Math.round(H * 0.42);
        parts.push(r(0, 0, W, H, '#000', ' fill-opacity="0.3"'));
        parts.push(r(0, H - sh, W, sh + 8, BG, ' rx="10"'));
        parts.push(r(W / 2 - 14, H - sh + 6, 28, 4, LINE, ' rx="2"'));
        parts.push(t(PAD, H - sh + 30, title || 'Sheet', 12, INK, ' font-weight="600"'));
        parts.push(r(PAD, H - sh + 40, W - PAD * 2, 26, BG, ` rx="4" stroke="${MID}"`));
        parts.push(bar(PAD + 8, H - sh + 51, (W - PAD * 2) * 0.5));
        if (btn) {
          parts.push(r(PAD, H - sh + 74, W - PAD * 2, 28, color, ' rx="4"'));
          parts.push(t(W / 2, H - sh + 92, btn, 11, BG, ' text-anchor="middle"'));
        }
        break;
      }
      case 'toast': {
        const tw = Math.min(W - PAD * 2, a.length * 6 + 24);
        const ty = H - PAD - 28 - (pinned.some((p) => p.kind === 'nav') ? 40 : 0);
        parts.push(r(W / 2 - tw / 2, ty, tw, 24, color, ' rx="12"'));
        parts.push(t(W / 2, ty + 16, a || 'Saved', 10, BG, ' text-anchor="middle"'));
        break;
      }
      default:
        break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif">${parts.join('')}</svg>\n`;
}
