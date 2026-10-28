// Pure helpers for the web copy of a video: ffmpeg arguments, file names, captions, and the snippet to paste.
// Nothing here touches the disk or runs a program, so it is easy to test.

/** Largest web copy we accept, in bytes (10 MB). */
export const MAX_BYTES = 10 * 1_000_000;

/**
 * Encoder settings to try, best quality first. The engine's own web script starts at CRF 24 and goes up by 2
 * (a higher CRF = smaller file, lower quality). We go a little further, and as a last resort also shrink the picture.
 */
export function encodeAttempts() {
  const steps = [];
  for (let crf = 24; crf <= 34; crf += 2) steps.push({ crf, shrink: false });
  steps.push({ crf: 28, shrink: true }, { crf: 32, shrink: true }, { crf: 36, shrink: true });
  return steps;
}

/**
 * ffmpeg arguments for one web encode: H.264, loudness-normalised AAC, fast start (plays before it finishes downloading).
 * `vertical` = height > width. A shrink step caps the short side at 720.
 */
export function buildEncodeArgs({ src, out, crf, shrink = false, vertical = false }) {
  const args = ['-v', 'error', '-y', '-i', src];
  if (shrink) args.push('-vf', vertical ? 'scale=720:-2' : 'scale=-2:720');
  args.push(
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', out,
  );
  return args;
}

/** ffmpeg arguments for the poster image (a frame at `at` seconds, 1280x720 or 720x1280). */
export function buildPosterArgs({ src, out, at, vertical = false }) {
  return ['-v', 'error', '-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', `scale=${vertical ? '720:1280' : '1280:720'}`, '-q:v', '3', out];
}

export const probeSizeArgs = (src) => ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src];
export const probeDurationArgs = (src) => ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src];

export function parseSize(text) {
  const m = /^\s*(\d+),(\d+)/.exec(String(text));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function parseDuration(text) {
  const n = Number(String(text).trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Where to take the poster from when the student does not say: a bit under halfway, where UI is usually on screen. */
export function defaultPosterAt(duration) {
  if (!duration) return 3;
  return Math.max(1, Math.round(duration * 0.45 * 10) / 10);
}

/**
 * A brand-neutral file base name from the render's name:
 * "acme-light-nomusic" -> "demo-light", "...-dark-..." -> "demo-dark", "-vertical" adds "-phone", "-silent" adds "-silent".
 */
export function defaultWebName(renderName) {
  const n = String(renderName);
  let base = /(?:^|-)dark(?:-|$)/.test(n) ? 'demo-dark' : 'demo-light';
  if (/(?:^|-)silent(?:-|$)/.test(n)) base += '-silent';
  if (/(?:^|-)vertical(?:-|$)/.test(n)) base += '-phone';
  return base;
}

/** File names we are willing to publish under: short, lower case, no brand or path characters. */
export const WEB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Add `line:5%` to every caption's timing line, so captions sit at the top when the video already shows text at the bottom. */
export function moveCuesToTop(vtt) {
  return String(vtt)
    .split('\n')
    .map((line) => (/^(?:\d{2}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*$/.test(line.trimEnd()) && !/\bline:/.test(line)
      ? `${line.trimEnd()} line:5%`
      : line))
    .join('\n');
}

/**
 * The captions track's language: a short code (en, el, pt-BR) and the name a viewer sees in the player's menu,
 * written in that language ("Ελληνικά" for el). Unknown codes keep the code as the name.
 */
export const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
export function captionsLanguage(lang = 'en') {
  let name = lang;
  try {
    name = new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang;
  } catch {
    // no locale data for this code: keep the code
  }
  return { lang, label: name === lang ? lang : name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) };
}

/**
 * The page snippet to paste. preload="none" so visitors do not download the video until they press play.
 * `captionsDefault` is false on purpose: captions that start switched on would cover text already in the picture.
 */
export function jsxSnippet({ base, captions = true, label = 'Product video', lang = 'en' }) {
  const track = captionsLanguage(lang);
  const lines = [
    `<video controls playsInline preload="none" poster="/video/${base}.jpg" aria-label="${label}" style={{ width: "100%", height: "auto" }}>`,
    `  <source src="/video/${base}.mp4" type="video/mp4" />`,
  ];
  if (captions) lines.push(`  <track kind="captions" src="/video/demo.vtt" srcLang="${track.lang}" label="${track.label}" />`);
  lines.push('</video>', '<p>Narrated with an AI voice.</p>');
  return lines.join('\n');
}

/** The same in plain HTML, for an app that is not built with React. */
export function htmlSnippet({ base, captions = true, label = 'Product video', lang = 'en' }) {
  const track = captionsLanguage(lang);
  const lines = [
    `<video controls playsinline preload="none" poster="/video/${base}.jpg" aria-label="${label}" style="width: 100%; height: auto">`,
    `  <source src="/video/${base}.mp4" type="video/mp4">`,
  ];
  if (captions) lines.push(`  <track kind="captions" src="/video/demo.vtt" srclang="${track.lang}" label="${track.label}">`);
  lines.push('</video>', '<p>Narrated with an AI voice.</p>');
  return lines.join('\n');
}
