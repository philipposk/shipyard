// The part of design-from-url that runs INSIDE the web page: it reads computed styles and measurements
// and returns plain numbers, colours and font names. It never reads or returns the page's text, images,
// logos or links. It clicks nothing and changes nothing on the page.
//
// This function is sent to the browser with page.evaluate(extractPageData, options), so it must be
// completely self-contained (no imports, no outside variables).
//
// Result ("PageData"):
//   { vw, vh, docHeight,
//     body: { bg, color, fontFamily, fontSize }, htmlBg,
//     headings: { h1, h2, h3 } each { fontFamily, fontWeight, fontSize, letterSpacing (em), color } or null,
//     buttons: [{ tag, bg, color, radius, borderW, borderColor, fontWeight, fontSize, upper, w, h, padX, padY, inHeader, filled, bordered }],
//     linkColors: [{ color, weight }],
//     cards: [{ bg, radius, borderW, borderColor, shadow: { blur, spread, alpha, inset } | null, padding, w, h, filled }],
//     borders: [{ color, weight }], bgColors: [{ color, weight }], textColors: [{ color, weight, fontSize }],
//     layout: { fixedLeft, headerLinks, header, fixedBottomBar, containerWidths, sectionPadding, heroSplit, cardGrid, articleList } }
// Colours are [r, g, b, a] arrays (a 0..1).
export function extractPageData(options) {
  const opts = options || {};
  const MAX_BUTTONS = opts.maxButtons || 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.documentElement;
  const docHeight = Math.min(Math.max(root.scrollHeight, vh), 12000);

  // ---- colour reading (any colour space the browser knows) ----
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colourCache = new Map();
  function rgba(css) {
    if (!css || css === 'none' || css === 'transparent') return [0, 0, 0, 0];
    if (colourCache.has(css)) return colourCache.get(css);
    let out = null;
    const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css);
    if (m) {
      let a = 1;
      if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), a];
    } else if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#010203';
      ctx.fillStyle = css;
      if (ctx.fillStyle !== '#010203') {
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2], Math.round((d[3] / 255) * 100) / 100];
      }
    }
    colourCache.set(css, out);
    return out;
  }
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const alphaOf = (c) => (c ? c[3] : 0);

  // ---- element helpers ----
  const styleOf = (el) => window.getComputedStyle(el);
  function visible(el, st, rect) {
    const s = st || styleOf(el);
    const r = rect || el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    if (r.width < 4 || r.height < 4) return false;
    if (r.right <= 0 || r.left >= vw) return false;
    return true;
  }
  const pageTop = (r) => r.top + window.scrollY;
  function radiusPx(st, r) {
    const raw = st.borderTopLeftRadius || '0px';
    if (raw.indexOf('%') !== -1) return Math.min(r.width, r.height) * (parseFloat(raw) / 100);
    return Math.min(px(raw), Math.min(r.width, r.height) / 2 + 0.5);
  }
  function borderInfo(st) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    let best = null;
    for (const side of sides) {
      const w = px(st['border' + side + 'Width']);
      const style = st['border' + side + 'Style'];
      if (w >= 1 && style !== 'none' && style !== 'hidden') {
        const c = rgba(st['border' + side + 'Color']);
        if (c && c[3] > 0.08) {
          best = { w, color: c };
          break;
        }
      }
    }
    return best;
  }
  function shadowInfo(st) {
    const raw = st.boxShadow;
    if (!raw || raw === 'none') return null;
    // split on top-level commas, keep the first outer shadow
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of raw) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) {
      const inset = /\binset\b/.test(part);
      if (inset) continue;
      const colour = /(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]{3,8})/i.exec(part);
      const rest = part.replace(colour ? colour[0] : '', '');
      const nums = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
      const c = colour ? rgba(colour[0]) : [0, 0, 0, 0.2];
      if (nums.length >= 2 && c && c[3] > 0.01) {
        return { blur: nums[2] || 0, spread: nums[3] || 0, offsetY: nums[1] || 0, alpha: c[3] };
      }
    }
    return null;
  }
  const median = (list) => {
    const a = list.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    if (a.length === 0) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };

  // ---- the page itself ----
  const bodyStyle = styleOf(document.body);
  const body = {
    bg: rgba(bodyStyle.backgroundColor),
    color: rgba(bodyStyle.color),
    fontFamily: bodyStyle.fontFamily,
    fontSize: px(bodyStyle.fontSize),
  };
  const htmlBg = rgba(styleOf(root).backgroundColor);
  // what the page background really is, to tell cards from the page
  const pageBg = alphaOf(body.bg) > 0.5 ? body.bg : alphaOf(htmlBg) > 0.5 ? htmlBg : [255, 255, 255, 1];
  const sameAsPage = (c) => c && Math.abs(c[0] - pageBg[0]) + Math.abs(c[1] - pageBg[1]) + Math.abs(c[2] - pageBg[2]) < 12;

  // ---- headings ----
  function headingInfo(tag) {
    const list = Array.from(document.querySelectorAll(tag));
    for (const el of list) {
      const st = styleOf(el);
      const r = el.getBoundingClientRect();
      if (!visible(el, st, r) || !(el.textContent || '').trim()) continue;
      const size = px(st.fontSize);
      return {
        fontFamily: st.fontFamily,
        fontWeight: parseInt(st.fontWeight, 10) || 400,
        fontSize: size,
        letterSpacing: st.letterSpacing === 'normal' ? 0 : px(st.letterSpacing) / (size || 16),
        color: rgba(st.color),
        top: Math.round(pageTop(r)),
      };
    }
    return null;
  }
  const headings = { h1: headingInfo('h1'), h2: headingInfo('h2'), h3: headingInfo('h3') };

  // ---- walk the page once ----
  const all = Array.from(document.body.querySelectorAll('*'));
  const limit = 5000;
  const bgAreas = new Map();
  const textAreas = new Map();
  const borderWeights = new Map();
  const linkWeights = new Map();
  const add = (map, key, w) => map.set(key, (map.get(key) || 0) + w);
  const buttons = [];
  const plainButtons = [];
  const cards = [];

  const CARD_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'A', 'FORM', 'ASIDE', 'FIGURE', 'MAIN', 'DETAILS']);
  const walked = all.length > limit ? all.slice(0, limit) : all;
  for (const el of walked) {
    const st = styleOf(el);
    if (st.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, st, r)) continue;
    const top = pageTop(r);
    if (top > 12000) continue;
    const clippedW = Math.min(r.right, vw) - Math.max(r.left, 0);
    const clippedArea = Math.max(0, clippedW) * Math.max(0, Math.min(r.height, 12000));
    const bg = rgba(st.backgroundColor);
    const filled = alphaOf(bg) > 0.5;
    if (filled) add(bgAreas, bg.join(','), clippedArea);
    else if (alphaOf(bg) > 0.15) add(bgAreas, bg.join(','), clippedArea * alphaOf(bg));

    // text colour, weighted by the area the words roughly cover (never the words themselves)
    let chars = 0;
    for (const n of el.childNodes) if (n.nodeType === 3) chars += n.nodeValue.trim().length;
    if (chars > 0) {
      const size = px(st.fontSize) || 16;
      const area = Math.min(clippedArea || 1, chars * size * size * 0.55);
      const c = rgba(st.color);
      if (c && c[3] > 0.1) {
        const key = c.join(',') + '|' + (size <= 15 ? 's' : 'n');
        add(textAreas, key, area);
        if (el.tagName === 'A' && !el.closest('button')) add(linkWeights, c.join(','), area);
      }
    }

    // borders, weighted by how long they are
    const border = borderInfo(st);
    if (border) {
      let len = 0;
      for (const side of ['Top', 'Bottom']) if (px(st['border' + side + 'Width']) >= 1 && st['border' + side + 'Style'] !== 'none') len += r.width;
      for (const side of ['Left', 'Right']) if (px(st['border' + side + 'Width']) >= 1 && st['border' + side + 'Style'] !== 'none') len += r.height;
      add(borderWeights, border.color.join(','), Math.max(len, 1));
    }

    const radius = radiusPx(st, r);
    const shadow = shadowInfo(st);
    const tag = el.tagName;

    // buttons: real buttons, role=button, and links that look like buttons
    const isBtnTag = tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button)$/i.test(el.getAttribute('type') || '')) || el.getAttribute('role') === 'button';
    const looksLikeBtn = tag === 'A' && (filled || border) && r.height >= 28 && r.height <= 90 && r.width >= 50 && (px(st.paddingLeft) >= 8);
    if ((isBtnTag || looksLikeBtn) && r.height >= 24 && r.width >= 32 && r.height <= 120) {
      const entry = {
        tag: tag.toLowerCase(),
        bg: bg,
        color: rgba(st.color),
        radius: radius,
        borderW: border ? border.w : 0,
        borderColor: border ? border.color : null,
        fontWeight: parseInt(st.fontWeight, 10) || 400,
        fontSize: px(st.fontSize),
        upper: st.textTransform === 'uppercase',
        w: Math.round(r.width),
        h: Math.round(r.height),
        padX: px(st.paddingLeft),
        padY: px(st.paddingTop),
        inHeader: Boolean(el.closest('header, [role="banner"], nav')),
        filled: filled && !sameAsPage(bg),
        bordered: Boolean(border),
        top: Math.round(top),
      };
      if (entry.filled || entry.bordered) {
        if (buttons.length < MAX_BUTTONS) buttons.push(entry);
      } else if (plainButtons.length < 6 && isBtnTag) plainButtons.push(entry);
    }

    // card-like blocks
    if (CARD_TAGS.has(tag) && r.width >= 120 && r.height >= 60 && r.width < vw * 0.95 && radius > 0 && !el.closest('nav, header, footer')) {
      const fillsDifferently = filled && !sameAsPage(bg);
      if (fillsDifferently || border || shadow) {
        if (cards.length < 60) {
          cards.push({
            bg: bg,
            radius: radius,
            borderW: border ? border.w : 0,
            borderColor: border ? border.color : null,
            shadow: shadow,
            padding: Math.round((px(st.paddingLeft) + px(st.paddingTop)) / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            filled: fillsDifferently,
          });
        }
      }
    }
  }

  const listFrom = (map, withSize) => Array.from(map.entries()).map(([k, weight]) => {
    const parts = k.split('|');
    const c = parts[0].split(',').map(Number);
    const item = { color: c, weight: Math.round(weight) };
    if (withSize) item.fontSize = parts[1] === 's' ? 14 : 16;
    return item;
  }).sort((a, b) => b.weight - a.weight).slice(0, 24);

  // ---- layout: where does the menu live? ----
  function linksIn(el) {
    return Array.from(el.querySelectorAll('a')).filter((a) => visible(a));
  }

  // a tall, narrow column pinned to the left with stacked links
  let fixedLeft = null;
  for (const el of document.body.querySelectorAll('nav, aside, [role="navigation"], [class*="sidebar" i], [class*="sidenav" i], div, header')) {
    const r = el.getBoundingClientRect();
    if (r.left > 6 || r.width < 150 || r.width > 380 || r.height < vh * 0.6 || r.top > 60) continue;
    const st = styleOf(el);
    if (!visible(el, st, r)) continue;
    const pinned = st.position === 'fixed' || st.position === 'sticky';
    const navLike = /^(NAV|ASIDE)$/.test(el.tagName) || el.getAttribute('role') === 'navigation' || /sidebar|sidenav/i.test(el.className && el.className.toString ? el.className.toString() : '');
    if (!pinned && !navLike) continue;
    const links = linksIn(el);
    const tops = Array.from(new Set(links.map((a) => Math.round(a.getBoundingClientRect().top / 16))));
    if (links.length >= 3 && tops.length >= 3) {
      fixedLeft = { width: Math.round(r.width), height: Math.round(r.height), links: links.length };
      break;
    }
  }

  // inline links across the top
  let headerLinks = 0;
  let header = null;
  const headerEls = Array.from(document.querySelectorAll('header, [role="banner"], body > nav, body > div > nav'));
  for (const el of headerEls) {
    const st = styleOf(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, st, r) || r.top > 160 || r.width < vw * 0.6) continue;
    const links = linksIn(el).filter((a) => {
      const lr = a.getBoundingClientRect();
      return lr.top < 160 && lr.height < 90;
    });
    const rows = new Map();
    for (const a of links) {
      const lr = a.getBoundingClientRect();
      const key = Math.round((lr.top + lr.height / 2) / 14);
      rows.set(key, (rows.get(key) || 0) + 1);
    }
    const best = Math.max(0, ...Array.from(rows.values()));
    if (best > headerLinks) headerLinks = best;
    if (!header) {
      const bg = rgba(st.backgroundColor);
      const bb = px(st.borderBottomWidth) >= 1 && st.borderBottomStyle !== 'none';
      // the first brand-like thing: the first link that holds an image or svg, or else the first link
      const first = links.find((a) => a.querySelector('img, svg')) || links[0];
      let brandCenter = null;
      if (first) {
        const fr = first.getBoundingClientRect();
        brandCenter = (fr.left + fr.width / 2) / vw;
      }
      header = {
        height: Math.round(r.height),
        bg: bg,
        bgDiffers: alphaOf(bg) > 0.5 && !sameAsPage(bg),
        borderBottom: bb,
        shadow: Boolean(shadowInfo(st)),
        brandCenter: brandCenter,
      };
    }
  }

  // tab bar pinned to the bottom (phones)
  let fixedBottomBar = false;
  for (const el of document.body.querySelectorAll('nav, [role="tablist"], [role="navigation"], div, footer, ul')) {
    const st = styleOf(el);
    if (st.position !== 'fixed' && st.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, st, r)) continue;
    if (r.bottom < vh - 6 || r.bottom > vh + 6 || r.width < vw * 0.9 || r.height < 44 || r.height > 110) continue;
    const items = Array.from(el.querySelectorAll('a, button')).filter((a) => visible(a));
    const lefts = new Set(items.map((a) => Math.round(a.getBoundingClientRect().left / 20)));
    const withIcons = items.filter((a) => a.querySelector('svg, img')).length;
    const navLike = el.tagName === 'NAV' || el.getAttribute('role') === 'tablist' || el.getAttribute('role') === 'navigation' || Boolean(el.closest('nav'));
    if (items.length >= 3 && items.length <= 6 && lefts.size >= 3 && (navLike || withIcons >= 3)) {
      fixedBottomBar = true;
      break;
    }
  }

  // ---- layout: widths and spacing of the main content ----
  function innerWidth(el, depth) {
    const r = el.getBoundingClientRect();
    if (r.width < 300) return null;
    if (r.width < vw * 0.94) return r.width;
    if (depth <= 0) return null;
    const widths = [];
    for (const child of Array.from(el.children)) {
      const cs = styleOf(child);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      const w = innerWidth(child, depth - 1);
      if (w) widths.push(w);
    }
    return widths.length > 0 ? Math.max.apply(null, widths) : null;
  }
  const mainEl = document.querySelector('main') || document.body;
  const sections = Array.from(mainEl.children).filter((el) => {
    const st = styleOf(el);
    const r = el.getBoundingClientRect();
    return visible(el, st, r) && r.height >= 120 && st.position !== 'fixed';
  }).slice(0, 12);
  const containerWidths = sections.map((el) => innerWidth(el, 3)).filter(Boolean).map(Math.round);
  const sectionPadding = sections.map((el) => {
    const st = styleOf(el);
    let pad = Math.max(px(st.paddingTop), px(st.paddingBottom));
    if (pad < 16) {
      for (const child of Array.from(el.children).slice(0, 3)) {
        const cs = styleOf(child);
        pad = Math.max(pad, px(cs.paddingTop), px(cs.paddingBottom));
      }
    }
    return Math.round(pad);
  });

  // ---- layout: what does the first screen look like? ----
  const mediaSelector = 'img, svg, video, canvas, picture, iframe';
  function textLength(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().length;
  }
  let heroSplit = false;
  const h1El = Array.from(document.querySelectorAll('h1')).find((h) => visible(h));
  if (h1El && pageTop(h1El.getBoundingClientRect()) < 1000) {
    let a = h1El.parentElement;
    for (let i = 0; i < 6 && a && a !== document.body && !heroSplit; i++, a = a.parentElement) {
      const ar = a.getBoundingClientRect();
      if (ar.width < vw * 0.5) continue;
      const kids = Array.from(a.children).filter((k) => visible(k) && styleOf(k).position !== 'absolute');
      if (kids.length < 2 || kids.length > 4) continue;
      const withH1 = kids.find((k) => k.contains(h1El));
      const other = kids.find((k) => k !== withH1 && (k.querySelector(mediaSelector) || k.matches(mediaSelector) || textLength(k) < 120));
      if (!withH1 || !other) continue;
      const x = withH1.getBoundingClientRect();
      const y = other.getBoundingClientRect();
      const sideBySide = (x.right <= y.left + 8 || y.right <= x.left + 8) && Math.abs(x.top - y.top) < 160;
      const okWidths = x.width >= ar.width * 0.25 && y.width >= ar.width * 0.25 && x.width <= ar.width * 0.7 && y.width <= ar.width * 0.7;
      if (sideBySide && okWidths && y.height >= 120) heroSplit = true;
    }
  }

  let cardGrid = null;
  const parents = new Set();
  for (const el of walked) {
    if (el.children.length >= 3 && el.children.length <= 12) parents.add(el);
  }
  for (const p of parents) {
    if (cardGrid) break;
    if (p.closest('footer, nav, header')) continue;
    const pr = p.getBoundingClientRect();
    if (pageTop(pr) > 6000 || pr.width < vw * 0.4) continue;
    const kids = Array.from(p.children).filter((k) => {
      const kr = k.getBoundingClientRect();
      return visible(k) && kr.width >= 120 && kr.width <= vw * 0.5 && kr.height >= 80 && (textLength(k) >= 30 || (k.querySelector(mediaSelector) && textLength(k) >= 8));
    });
    if (kids.length < 3) continue;
    const rows = new Map();
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      const key = Math.round(pageTop(kr) / 12);
      rows.set(key, (rows.get(key) || []).concat([kr.width]));
    }
    for (const widths of rows.values()) {
      if (widths.length >= 3) {
        const lo = Math.min.apply(null, widths);
        const hi = Math.max.apply(null, widths);
        if (hi <= lo * 1.18) {
          cardGrid = { columns: widths.length };
          break;
        }
      }
    }
  }

  // a stack of articles / entries, one under another
  let articleList = false;
  const articles = Array.from(document.querySelectorAll('article')).filter((a) => visible(a) && !a.closest('footer, nav'));
  if (articles.length >= 3) {
    const lefts = new Set(articles.map((a) => Math.round(a.getBoundingClientRect().left / 8)));
    const tops = articles.map((a) => Math.round(pageTop(a.getBoundingClientRect())));
    const stacked = new Set(tops.map((t) => Math.round(t / 20))).size === tops.length;
    const wide = articles.every((a) => a.getBoundingClientRect().width >= Math.min(vw * 0.4, 360));
    articleList = lefts.size <= 2 && stacked && wide;
  }
  if (!articleList) {
    const dated = Array.from(document.querySelectorAll('time')).filter((t) => visible(t) && !t.closest('footer, nav'));
    if (dated.length >= 3) {
      const tops = new Set(dated.map((t) => Math.round(pageTop(t.getBoundingClientRect()) / 20)));
      articleList = tops.size === dated.length && !cardGrid;
    }
  }

  return {
    vw: vw,
    vh: vh,
    docHeight: docHeight,
    body: body,
    htmlBg: htmlBg,
    headings: headings,
    buttons: buttons.concat(plainButtons),
    linkColors: listFrom(linkWeights, false),
    cards: cards,
    borders: listFrom(borderWeights, false),
    bgColors: listFrom(bgAreas, false),
    textColors: listFrom(textAreas, true),
    layout: {
      fixedLeft: fixedLeft,
      headerLinks: headerLinks,
      header: header,
      fixedBottomBar: fixedBottomBar,
      containerWidths: containerWidths,
      sectionPadding: sectionPadding,
      heroSplit: heroSplit,
      cardGrid: cardGrid,
      articleList: articleList,
      medianCardPadding: median(cards.map((c) => c.padding)),
    },
  };
}
