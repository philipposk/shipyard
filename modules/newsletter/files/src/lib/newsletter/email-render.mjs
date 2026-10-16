// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// design-check: allow-file hard-coded-colour
// (Email programs ignore the app's stylesheet, so emails carry their own fixed colours and inline styles.)
//
// Turns the Markdown a person writes into the HTML of an email. The composer page shows the preview with this same
// code, so what you see is what is sent. It knows nothing about the database or Next.js, so it can run in the browser.

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

// Runs on already-escaped text, so the only markup that can appear is the tags added here.
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^*]*?[^\s*])\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([^_]*?[^\s_])__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    // Underscore italics only at word edges, so snake_case and file_names stay as typed.
    .replace(/(^|[^_\w])_(?=\S)([^_]*?[^\s_])_(?![_\w])/g, "$1<em>$2</em>");
}

function inline(src) {
  // Links are pulled out first so the emphasis rules can not reach into an address. Only http(s) and mailto
  // become links: anything else (javascript:, data:) stays visible as plain text.
  const links = [];
  const withSlots = src.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return whole;
    links.push(`<a href="${esc(url)}" style="color:#2f6fdf">${emphasis(esc(text))}</a>`);
    return ` ${links.length - 1} `;
  });
  return emphasis(esc(withSlots)).replace(/ (\d+) /g, (_, i) => links[Number(i)] ?? "");
}

const HEADING_STYLE = {
  1: "font-size:22px;line-height:1.3;margin:0 0 14px;color:#111",
  2: "font-size:18px;line-height:1.35;margin:22px 0 10px;color:#111",
  3: "font-size:15px;line-height:1.4;margin:18px 0 8px;color:#111",
};
const PARAGRAPH_STYLE = "margin:0 0 14px";
const LIST_STYLE = "margin:0 0 14px;padding-left:22px";

/**
 * A deliberately small Markdown: # headings (1 to 3), paragraphs, **bold**, *italic*, [links](https://...),
 * "-" and "1." lists and "---" rules. Anything else is escaped and shown as typed, so a stray "<" can never become
 * markup in someone's inbox.
 */
export function markdownToHtml(md) {
  const lines = String(md || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p style="${PARAGRAPH_STYLE}">${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag} style="${LIST_STYLE}">${list.items.map((item) => `<li style="margin:0 0 6px">${inline(item)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^\s{0,3}(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level} style="${HEADING_STYLE[level]}">${inline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr style="border:0;border-top:1px solid #e3e5ea;margin:20px 0">');
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    // An indented line right after a list item continues that item.
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The whole email: styled body plus a footer that says why the person gets it and links to a one-click unsubscribe.
 * @param {{ subject: string, bodyMd: string, unsubscribeUrl: string, brandName: string, settingsUrl?: string }} input
 * @returns {{ html: string, text: string }}
 */
export function renderNewsletterEmail({ subject, bodyMd, unsubscribeUrl, brandName, settingsUrl }) {
  const settings = settingsUrl ? ` &middot; <a href="${esc(settingsUrl)}" style="color:#6b7280">Email settings</a>` : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7">
<div style="padding:24px 12px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e8ec;border-radius:10px;padding:28px 26px;font-family:${FONT};font-size:15px;line-height:1.6;color:#222">
${markdownToHtml(bodyMd)}
</div>
<p style="max-width:560px;margin:14px auto 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#6b7280;text-align:center">
You are getting this because you asked for updates from ${esc(brandName)}.<br>
<a href="${esc(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe with one click</a>${settings}
</p>
</div>
</body></html>`;
  const text = `${String(bodyMd || "").trim()}\n\n--\nYou are getting this because you asked for updates from ${brandName}.\nUnsubscribe with one click: ${unsubscribeUrl}\n`;
  return { html, text };
}
