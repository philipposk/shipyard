// A tiny local website for the opt-in browser tests of design-from-url (no network, no real sites).
// Four pages with clearly different styles; the tests check that the capture notices the differences.
import http from 'node:http';

const lorem = 'Fresh loaves every morning, baked slowly and sold the same day to people nearby.';

export const PAGES = {
  // A friendly shop: links across the top, text beside a picture, three floating cards, round buttons, own dark mode.
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture shop</title>
<style>
:root{--bg:#fffaf3;--fg:#2b2118;--card:#ffffff;--accent:#0f766e;--accent-fg:#ffffff;--muted:#7a6a5c}
@media (prefers-color-scheme:dark){:root{--bg:#14110e;--fg:#f5ebe0;--card:#1f1a15;--accent:#2dd4bf;--accent-fg:#06201c;--muted:#b8a899}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Poppins","Helvetica Neue",Arial,sans-serif}
header{display:flex;align-items:center;gap:28px;padding:18px 48px;background:var(--card);border-bottom:1px solid #00000014}
header .brand{font-weight:700;font-size:20px;margin-right:auto}
header a{color:var(--fg);text-decoration:none;font-size:15px}
main{max-width:1040px;margin:0 auto;padding:0 24px}
.hero{display:flex;gap:48px;align-items:center;padding:80px 0}
.hero .copy{flex:1}
.hero .art{flex:1;height:320px;border-radius:24px;background:var(--accent);opacity:.9}
h1{font-size:52px;line-height:1.1;margin:0 0 16px;font-weight:700;letter-spacing:-0.02em}
h2{font-size:30px;margin:0 0 12px}
p{color:var(--muted);margin:0 0 20px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:600;border:0}
.btn.second{background:transparent;color:var(--fg);border:1px solid #00000033;margin-left:8px}
.cards{display:flex;gap:24px;padding:24px 0 80px}
.card{flex:1;background:var(--card);border-radius:20px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.10)}
.card h3{margin:0 0 8px;font-size:20px}
</style></head><body>
<header><span class="brand">Hearth</span><a href="#a">Bread</a><a href="#b">Pastry</a><a href="#c">Visit us</a><a href="#d">Contact</a><a class="btn" href="#e">Order</a></header>
<main>
<section class="hero"><div class="copy"><h1>Bread worth waking up for</h1><p>${lorem}</p><a class="btn" href="#o">Order now</a><a class="btn second" href="#m">See the menu</a></div><div class="art"></div></section>
<section class="cards"><div class="card"><h3>Sourdough</h3><p>${lorem}</p></div><div class="card"><h3>Croissants</h3><p>${lorem}</p></div><div class="card"><h3>Seasonal tarts</h3><p>${lorem}</p></div></section>
</main></body></html>`,

  // An app-like dashboard: tall menu column on the left, tight spacing, square buttons, black and white.
  '/dash': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f4f5;color:#09090b;font:14px/1.45 Inter,system-ui,sans-serif}
aside{position:fixed;left:0;top:0;bottom:0;width:230px;background:#fff;border-right:1px solid #e4e4e7;padding:16px}
aside a{display:block;padding:8px 10px;color:#3f3f46;text-decoration:none;border-radius:2px}
main{margin-left:230px;padding:24px;max-width:1050px}
h1{font-size:22px;margin:0 0 16px;font-weight:600;letter-spacing:-0.01em}
.row{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:4px;padding:10px}
button{background:#09090b;color:#fff;border:0;border-radius:2px;padding:6px 12px;text-transform:uppercase;font-size:12px;letter-spacing:.04em}
</style></head><body>
<aside><a href="#1">Overview</a><a href="#2">Customers</a><a href="#3">Invoices</a><a href="#4">Reports</a><a href="#5">Settings</a></aside>
<main><h1>Overview</h1><div class="row"><div class="card"><h2 style="font-size:16px;margin:0 0 6px">Revenue</h2><p>${lorem}</p><button>Export</button></div><div class="card"><h2 style="font-size:16px;margin:0 0 6px">Orders</h2><p>${lorem}</p><button>Open</button></div></div></main>
</body></html>`,

  // A reading site: serif type, a stack of articles, outline buttons, narrow column.
  '/blog': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture blog</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#fbf8f1;color:#1b1b18;font:19px/1.6 Georgia,"Times New Roman",serif}
main{max-width:680px;margin:0 auto;padding:48px 20px}
h1{font-size:44px;line-height:1.1;margin:0 0 32px;font-weight:600}
article{padding:24px 0;border-top:1px solid #d9d2c3}
article h2{font-size:26px;margin:0 0 6px}
article p{margin:0;color:#5c574b}
time{font-size:14px;color:#6b6556}
a.btn{display:inline-block;border:1.5px solid #8a1c1c;color:#8a1c1c;padding:10px 20px;border-radius:0;text-decoration:none;margin-top:24px;font-family:system-ui,sans-serif;font-size:15px}
</style></head><body><main><h1>Notes from the oven</h1>
<article><time>12 Oct</time><h2>Why we proof overnight</h2><p>${lorem}</p></article>
<article><time>3 Oct</time><h2>Flour, water, salt, time</h2><p>${lorem}</p></article>
<article><time>21 Sep</time><h2>A short history of the baguette</h2><p>${lorem}</p></article>
<a class="btn" href="#more">Older notes</a></main></body></html>`,

  // A dark-only site.
  '/dark': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture dark</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b1020;color:#e6edf7;font:16px/1.5 "IBM Plex Sans",system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:64px 24px}
h1{font-size:40px;margin:0 0 12px;font-weight:600}
p{color:#9fb0c8}
.btn{display:inline-block;background:#22d3ee;color:#06202a;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}
</style></head><body><main><h1>Build faster</h1><p>${lorem}</p><a class="btn" href="#go">Start</a></main></body></html>`,
};

/** Starts the fixture site on a free local port. Returns { origin, close }. */
export function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = PAGES[url.pathname];
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
