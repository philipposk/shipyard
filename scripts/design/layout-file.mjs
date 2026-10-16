// The LAYOUT line in an app's src/lib/constants.ts: read it, rewrite it. Pure text helpers, shared by
// set-layout.mjs and the design writers.
export const LAYOUTS = ['bottom-nav', 'sidebar', 'top-nav'];
export const LAYOUT_CAST = '"bottom-nav" | "sidebar" | "top-nav"';

// export const LAYOUT = "bottom-nav" as "bottom-nav" | "sidebar" | "top-nav";
// export const LAYOUT: Layout = "bottom-nav";
const LAYOUT_LINE = /^(export const LAYOUT)(\s*:\s*[^=\r\n]+?)?(\s*=\s*)"(?:bottom-nav|sidebar|top-nav)"(\s+as\s+[^;\r\n]+?)?(\s*;?)([ \t]*)$/m;

/** The layout named on the LAYOUT line, or null when the line is missing or in another shape. */
export function readLayout(source) {
  const m = /^export const LAYOUT\b[^=\r\n]*=\s*"(bottom-nav|sidebar|top-nav)"/m.exec(source);
  return m ? m[1] : null;
}

/** Returns the new file text, or null when the LAYOUT line is not in the expected shape. */
export function withLayout(source, layout) {
  if (!LAYOUTS.includes(layout) || !LAYOUT_LINE.test(source)) return null;
  return source.replace(LAYOUT_LINE, (_all, head, annotation, eq, _cast, semi, tail) => {
    // With a type annotation the value needs no cast; without one the cast lists all three layouts.
    const type = annotation ? '' : ` as ${LAYOUT_CAST}`;
    return `${head}${annotation ?? ''}${eq}"${layout}"${type}${semi.trim() || ';'}${tail}`;
  });
}
