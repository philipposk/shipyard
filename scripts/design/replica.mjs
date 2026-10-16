// Pictures of a look, built from plain HTML and CSS: the design gallery uses them to show what the
// menu, the homepage, the cards, the buttons and the type of each look really do, on a phone and on
// a computer screen. They follow the same variant rules as the template (data-cards, data-buttons,
// data-header, data-density), but scaled down to fit a frame: every size is a number times --px,
// and --px is "one pixel of the real screen" inside the frame.
//
// No inline style attributes anywhere (the gallery page has a strict content policy).
import {
  COLOR_KEYS, CSS_VARS, WORDS, headingFont, lookDims, shapeNumbers, withDefaults,
} from './tokens.mjs';
import { cssFamily } from './fonts.mjs';

export const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** The screen sizes the pictures pretend to be (in CSS pixels). */
export const SCREENS = { phone: { w: 390, h: 800 }, desktop: { w: 1024, h: 640 } };

// ---------------------------------------------------------------------------------------------
// CSS

const U = (n) => `calc(${n} * var(--px))`;
const HAIR = 'max(1px, var(--px))';

/**
 * The rules every look shares. Same ideas as the template's variant rules:
 * cards (flat, bordered, elevated, tinted), buttons (solid, pill, outline, sharp),
 * header (plain, bar, centered), density (through --space, --pad-card, --gap).
 */
export function replicaCss() {
  return `
.rep{--px:calc(100cqw / 390);position:relative;overflow:hidden;width:100%;height:100%;background:var(--background);color:var(--foreground);font-family:var(--lf-body);font-size:calc(var(--basen) * var(--px));line-height:1.5;text-align:left;
--radius:calc(var(--rn) * var(--px));--radius-sm:calc(var(--rsn) * var(--px));--h1:calc(var(--h1n) * var(--px));--h2:calc(var(--h2n) * var(--px));--h3:calc(var(--h3n) * var(--px));
--space:calc(var(--spn) * var(--px));--pad-card:calc(var(--padn) * var(--px));--gap:calc(var(--gapn) * var(--px));--content-max:calc(var(--maxn) * var(--px));
--accent-soft:color-mix(in srgb,var(--accent) var(--softp,9%),var(--card))}
.rep-desktop{--px:calc(100cqw / 1024)}
.rep-phone{--h1:calc(var(--h1pn) * var(--px))}
.rep[data-shadow="soft"]{--shadow:0 ${U(6)} ${U(24)} rgba(0,0,0,var(--sha))}
.rep[data-shadow="crisp"]{--shadow:0 ${U(1)} ${U(2)} rgba(0,0,0,var(--shc)),0 0 0 ${HAIR} var(--line)}
.rep[data-shadow="none"]{--shadow:none}
.rep *{box-sizing:border-box}
.rep h1,.rep h2,.rep h3,.rep p{margin:0}
.rep h1,.rep h2,.rep h3{font-family:var(--lf-heading);font-weight:var(--hw);letter-spacing:var(--ht)}
.rep h1{font-size:var(--h1);line-height:1.12}
.rep h2{font-size:var(--h2);line-height:1.2}
.rep h3{font-size:var(--h3);line-height:1.25}
.rep .muted{color:var(--muted)}
.rep .small{font-size:${U(13)}}
.rep .ic{width:${U(22)};height:${U(22)};flex:none}

.rep .app-header{position:relative;z-index:2;height:${U(56)};flex:none}
.rep .app-header-in{display:flex;align-items:center;justify-content:space-between;gap:${U(12)};height:100%;padding:0 ${U(16)};max-width:var(--content-max);margin:0 auto}
.rep .brand{display:flex;align-items:center;gap:${U(10)};font-family:var(--lf-heading);font-weight:700;font-size:${U(17)};min-width:0}
.rep .brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rep .mark{display:grid;place-items:center;width:${U(28)};height:${U(28)};flex:none;border-radius:${U(8)};background:var(--accent);color:var(--accent-contrast);font-weight:700;font-size:${U(14)};font-family:var(--lf-body)}
.rep .avatar{display:grid;place-items:center;width:${U(32)};height:${U(32)};border-radius:50%;flex:none;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:${U(13)}}
.rep .hdr-links{display:flex;gap:${U(4)};margin:0 auto 0 ${U(24)}}
.rep .hdr-link{padding:${U(8)} ${U(12)};border-radius:var(--radius-sm);color:var(--muted);font-weight:500;font-size:${U(15)}}
.rep .hdr-link.on{color:var(--accent);font-weight:700}
.rep[data-header="bar"] .app-header{background:var(--card);border-bottom:${HAIR} solid var(--line)}
.rep[data-header="plain"] .app-header{background:transparent;border-bottom:0}
.rep[data-header="centered"] .app-header{background:transparent;border-bottom:0}
.rep[data-header="centered"] .app-header-in{display:grid;grid-template-columns:1fr auto 1fr}
.rep[data-header="centered"] .app-header-in>:last-child{justify-self:end}
.rep[data-header="centered"] .hdr-links{margin:0}
.rep[data-header="centered"] .app-header-in .brand{justify-self:center}

.rep .shell{display:flex;flex-direction:column;height:100%}
.rep .main{flex:1;min-height:0;overflow:hidden;padding:${U(0)} ${U(16)}}
.rep .page{max-width:var(--content-max);margin:0 auto;padding-top:calc(4 * var(--space));display:grid;gap:calc(4 * var(--space));align-content:start}
.rep-desktop .main{padding:0 ${U(32)}}

.rep .tabbar{position:absolute;left:0;right:0;bottom:0;z-index:3;background:var(--card);border-top:${HAIR} solid var(--line)}
.rep .tabbar-in{display:grid;grid-template-columns:repeat(3,1fr);max-width:${U(640)};margin:0 auto}
.rep .tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${U(2)};min-height:${U(60)};font-size:${U(12)};color:var(--muted)}
.rep .tab.on{color:var(--accent);font-weight:700}

.rep .sb-side{position:absolute;left:0;top:0;bottom:0;width:${U(248)};z-index:2;display:flex;flex-direction:column;background:var(--card);border-right:${HAIR} solid var(--line)}
.rep .sb-brand{display:flex;align-items:center;gap:${U(10)};height:${U(60)};padding:0 ${U(16)};font-family:var(--lf-heading);font-weight:700;font-size:${U(17)}}
.rep .sb-nav{flex:1;padding:${U(8)};display:flex;flex-direction:column;gap:${U(2)}}
.rep .sb-link{display:flex;align-items:center;gap:${U(10)};min-height:${U(44)};padding:0 ${U(12)};border-radius:var(--radius-sm);color:var(--muted);font-weight:500;font-size:${U(15)}}
.rep .sb-link.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.rep .sb-foot{padding:${U(8)};border-top:${HAIR} solid var(--line);display:flex;align-items:center;gap:${U(10)}}
.rep .sb-foot span.small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rep .sb-main{margin-left:${U(248)};height:100%}
.rep .sb-main .main{padding:0 ${U(32)}}
.rep .sb-main .page{margin:0;padding-top:${U(32)}}

.rep .card{background:var(--card);border:${HAIR} solid transparent;border-radius:var(--radius);padding:var(--pad-card)}
.rep[data-cards="flat"] .card{border-color:transparent;box-shadow:none}
.rep[data-cards="bordered"] .card{border-color:var(--line);box-shadow:var(--shadow)}
.rep[data-cards="elevated"] .card{border-color:transparent;box-shadow:var(--shadow)}
.rep[data-cards="tinted"] .card{background:var(--accent-soft);border-color:transparent;box-shadow:none}

.rep .btn{display:inline-flex;align-items:center;justify-content:center;gap:${U(8)};min-height:${U(44)};padding:0 ${U(18)};border:${HAIR} solid transparent;border-radius:var(--radius-sm);font-family:var(--lf-body);font-weight:600;font-size:${U(15)};white-space:nowrap}
.rep .btn-primary{background:var(--accent);color:var(--accent-contrast)}
.rep .btn-secondary{background:var(--card);color:var(--foreground);border-color:var(--line-strong)}
.rep[data-buttons="pill"] .btn{border-radius:999px}
.rep[data-buttons="outline"] .btn-primary{background:var(--accent-soft);color:var(--accent);border:${U(2)} solid var(--accent);font-weight:700}
.rep[data-buttons="outline"] .btn-secondary{background:transparent;border-color:var(--line);font-weight:500}
.rep[data-buttons="sharp"] .btn{border-radius:${U(2)};text-transform:uppercase;letter-spacing:.06em;font-size:${U(12.5)}}
.rep .actions{display:flex;flex-wrap:wrap;gap:${U(10)}}
.rep .link{color:var(--accent);font-weight:600;text-decoration:underline;text-underline-offset:${U(3)}}
.rep .kicker{font-size:${U(12)};font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.rep .lead{font-size:${U(18)};line-height:1.55;color:var(--muted)}
.rep .rule{height:${HAIR};background:var(--line)}

.rep .home-focus{justify-items:center;text-align:center}
.rep .home-focus>*{max-width:${U(560)}}
.rep .home-focus .actions{justify-content:center}
.rep .points{display:grid;gap:calc(2 * var(--space));width:100%;max-width:${U(720)}}
.rep-desktop .points{grid-template-columns:repeat(3,1fr)}
.rep .point{display:grid;gap:${U(4)};text-align:left}
.rep .point b{font-weight:600;font-size:${U(15)}}
.rep .point span{color:var(--muted);font-size:${U(14)}}
.rep .point::before{content:"";display:block;width:${U(28)};height:${U(3)};margin-bottom:${U(6)};border-radius:2px;background:var(--accent)}

.rep .home-split{display:grid;gap:calc(4 * var(--space));align-items:center}
.rep-desktop .home-split{grid-template-columns:1fr 1fr;padding-top:${U(24)}}
.rep .home-split .copy{display:grid;gap:calc(3 * var(--space));justify-items:start}
.rep .preview{display:grid;gap:var(--gap)}
.rep .bar{height:${U(8)};border-radius:999px;background:var(--line);overflow:hidden}
.rep .bar i{display:block;height:100%;width:60%;background:var(--accent);border-radius:999px}
.rep .row{display:flex;align-items:center;justify-content:space-between;gap:${U(12)};padding:calc(2 * var(--space)) 0;border-top:${HAIR} solid var(--line)}
.rep .row:first-child{border-top:0}

.rep .home-editorial{gap:calc(5 * var(--space))}
.rep .home-editorial .head{display:grid;gap:calc(2 * var(--space))}
.rep .entries{display:grid}
.rep .entry{display:grid;gap:${U(6)};padding:calc(3 * var(--space)) 0;border-top:${HAIR} solid var(--line-strong)}
.rep .entry p{color:var(--muted)}

.rep .home-cards .head{display:grid;gap:${U(6)};justify-items:start}
.rep .home-cards .head .actions{margin-top:${U(6)}}
.rep .grid{display:grid;gap:var(--gap);grid-template-columns:repeat(2,1fr)}
.rep-desktop .grid{grid-template-columns:repeat(3,1fr)}
.rep .tile{display:grid;gap:${U(6)};align-content:start}
.rep .tile .badge{display:grid;place-items:center;width:${U(36)};height:${U(36)};border-radius:var(--radius-sm);background:var(--accent-soft);color:var(--accent);font-weight:700;margin-bottom:${U(4)}}
.rep[data-cards="tinted"] .tile .badge{background:var(--card)}

.rep .home-list .head{display:grid;gap:${U(4)}}
.rep .list{padding:0}
.rep .list .row{padding:calc(2 * var(--space)) var(--pad-card)}
.rep .list .row:first-child{border-top:0}
.rep .list .row b{font-weight:600}
`;
}

/** The numbers and colours that belong to one look. Only validated ids, hex colours and known fonts reach this. */
export function lookVarsCss(input) {
  const t = withDefaults(input);
  const n = shapeNumbers(t);
  const cls = `.lk-${t.id}`;
  const theme = (name) => {
    const alphas = name === 'dark' ? { sha: 0.35, shc: 0.5 } : { sha: 0.07, shc: 0.08 };
    return `${cls}[data-view="${name}"]{${COLOR_KEYS.map((k) => `${CSS_VARS[k]}:${t[name][k]}`).join(';')};--sha:${alphas.sha};--shc:${alphas.shc};--softp:${name === 'dark' ? 7 : 9}%}`;
  };
  const base = [
    `--lf-body:${cssFamily(t.font.body)}`, `--lf-heading:${cssFamily(headingFont(t))}`,
    `--rn:${t.radius.base}`, `--rsn:${t.radius.sm}`, `--basen:${n.base}`, `--h1n:${n.h1}`, `--h1pn:${n.h1Phone}`, `--h2n:${n.h2}`, `--h3n:${n.h3}`,
    `--hw:${n.weight}`, `--ht:${n.tracking}em`, `--spn:${n.space}`, `--padn:${n.pad}`, `--gapn:${n.gap}`, `--maxn:${n.max}`,
  ].join(';');
  return `${cls}{${base}}\n${theme('light')}\n${theme('dark')}`;
}

// ---------------------------------------------------------------------------------------------
// HTML

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
  items: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const NAV = [['home', 'Home'], ['items', 'Items'], ['settings', 'Settings']];

/**
 * Words on the sample homepages. They are the same neutral words the template ships in
 * src/lib/home-content.ts, so the gallery shows what a new app really looks like.
 */
const copyFor = (name) => ({
  h: name, p: 'A short description of this app.', primary: 'Get started', secondary: 'Learn more',
  points: [['Yours alone', 'Everything you add stays private to your account.'], ['On every screen', 'Works in the browser on your phone and your computer.'], ['Light or dark', 'Pick the look that is easy on your eyes.']],
  entries: [
    ['items', 'Your space', 'Items', 'Add things and keep them in one place.'],
    ['home', 'About', `What ${name} is`, 'A short description of this app.'],
    ['settings', 'Help', 'Questions and answers', 'Find help signing in or get in touch.'],
  ],
});

function homeHtml(home, kind, appName) {
  const c = copyFor(appName);
  const phone = kind === 'phone';
  const actions = `<div class="actions"><span class="btn btn-primary">${esc(c.primary)}</span><span class="btn btn-secondary">${esc(c.secondary)}</span></div>`;
  switch (home) {
    case 'split':
      return `<div class="page home-split"><div class="copy"><h1>${esc(c.h)}</h1><p class="lead">${esc(c.p)}</p>${actions}</div>
<div class="card preview"><div class="row"><h3>Items</h3></div><div class="bar"><i></i></div>${c.entries.slice(0, phone ? 2 : 3).map(([, k, a]) => `<div class="row"><span>${esc(a)}</span><span class="muted small">${esc(k)}</span></div>`).join('')}</div></div>`;
    case 'editorial':
      return `<div class="page home-editorial"><div class="head"><h1>${esc(c.h)}</h1><p class="lead">${esc(c.p)}</p>${actions}</div>
<div class="entries">${c.entries.map(([, k, a, x]) => `<div class="entry"><span class="kicker">${esc(k)}</span><h3>${esc(a)}</h3><p>${esc(x)}</p></div>`).join('')}</div></div>`;
    case 'cards':
      return `<div class="page home-cards"><div class="head"><h1>${esc(c.h)}</h1><p class="lead">${esc(c.p)}</p>${actions}</div>
<div class="grid">${c.entries.map(([i, , a, d]) => `<div class="card tile"><span class="badge">${icon(i)}</span><h3>${esc(a)}</h3><span class="muted small">${esc(d)}</span></div>`).join('')}</div></div>`;
    case 'list':
      return `<div class="page home-list"><div class="head"><h1>${esc(c.h)}</h1><p class="muted">${esc(c.p)}</p></div>
${actions}
<div class="card list">${c.entries.map(([, , a, d]) => `<div class="row"><b>${esc(a)}</b><span class="muted small">${esc(d)}</span></div>`).join('')}</div></div>`;
    default:
      return `<div class="page home-focus"><h1>${esc(c.h)}</h1><p class="lead">${esc(c.p)}</p>${actions}
<div class="points">${c.points.map(([a, d]) => `<div class="card point"><b>${esc(a)}</b><span>${esc(d)}</span></div>`).join('')}</div></div>`;
  }
}

/**
 * One picture of a look: kind "phone" or "desktop", with the look's own menu, header and homepage.
 * (A phone always has the tab bar; the menu style shows on the computer picture.)
 */
export function renderReplica(input, { appName = 'Your app', kind = 'phone' } = {}) {
  const t = withDefaults(input);
  const L = t.layout;
  const name = String(appName || 'Your app');
  const initial = name.trim().slice(0, 1).toUpperCase() || 'A';
  const attrs = `data-density="${L.density}" data-cards="${L.cards}" data-buttons="${L.buttons}" data-header="${L.header}" data-shadow="${t.shadow}"`;
  const home = homeHtml(L.home, kind, name);
  const brand = `<span class="brand"><span class="mark">${esc(initial)}</span><span>${esc(name)}</span></span>`;
  const avatar = '<span class="avatar">SK</span>';
  const tabs = `<nav class="tabbar" aria-hidden="true"><div class="tabbar-in">${NAV.map(([i, label], n) => `<span class="tab${n === 0 ? ' on' : ''}">${icon(i)}${label}</span>`).join('')}</div></nav>`;
  const links = `<span class="hdr-links">${NAV.map(([, label], n) => `<span class="hdr-link${n === 0 ? ' on' : ''}">${label}</span>`).join('')}</span>`;
  let body;
  if (kind === 'desktop' && L.nav === 'sidebar') {
    body = `<aside class="sb-side"><div class="sb-brand"><span class="mark">${esc(initial)}</span><span>${esc(name)}</span></div>
<div class="sb-nav">${NAV.map(([i, label], n) => `<span class="sb-link${n === 0 ? ' on' : ''}">${icon(i)}${label}</span>`).join('')}</div>
<div class="sb-foot">${avatar}<span class="small muted">sam@example.com</span></div></aside>
<div class="sb-main"><div class="main">${home}</div></div>`;
  } else if (kind === 'desktop' && L.nav === 'top-nav') {
    const centered = L.header === 'centered';
    body = `<div class="shell"><header class="app-header"><div class="app-header-in">${centered ? `${links}${brand}${avatar}` : `${brand}${links}${avatar}`}</div></header><div class="main">${home}</div></div>`;
  } else {
    const row = L.header === 'centered' ? `<span></span>${brand}${avatar}` : `${brand}${avatar}`;
    body = `<div class="shell"><header class="app-header"><div class="app-header-in">${row}</div></header><div class="main">${home}</div></div>${tabs}`;
  }
  return `<div class="rep rep-${kind}" ${attrs}>${body}</div>`;
}

/** Short plain-English facts about a look, for the gallery card: [[label, value], ...] */
export function lookFacts(input) {
  const t = withDefaults(input);
  const d = lookDims(t);
  const fontName = (n) => (n === 'system' ? 'device font' : n);
  const head = headingFont(t);
  const font = head === t.font.body ? fontName(t.font.body) : `${fontName(head)} + ${fontName(t.font.body)}`;
  return [
    ['Menu', WORDS.nav[d.nav]],
    ['Homepage', WORDS.home[d.home]],
    ['Cards', WORDS.cards[d.cards]],
    ['Buttons', WORDS.buttons[d.buttons]],
    ['Spacing', WORDS.density[d.density]],
    ['Text', `${WORDS.scale[d.scale]}, ${font}`],
  ];
}
