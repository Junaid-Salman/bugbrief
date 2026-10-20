// Developer aid, not a test. Shows the built popup (dist/) in a named state with a stubbed chrome API, and
// screenshots it with the local headless Chrome. Build first (npm run build).
// Usage: node scripts/popup-harness.mjs <state> [out.png]
// States: idle, recording, ready, preview, stale, restricted, restricted-stopped, note-only, copy-ok, copy-fail,
//         copy-ok-scrolled, persistence-off, explainer
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const STATES = ['idle', 'recording', 'ready', 'preview', 'stale', 'restricted', 'restricted-stopped', 'note-only', 'copy-ok', 'copy-fail', 'copy-ok-scrolled', 'persistence-off', 'explainer'];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' };

function page(state) {
  const assets = readdirSync(join(dist, 'assets'));
  const js = assets.find((file) => /^index\.html-.*\.js$/.test(file));
  const css = assets.find((file) => /^index-.*\.css$/.test(file));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><script>
const S = ${JSON.stringify(state)};
const cnt = (e, r) => ({ console: { unique: e, total: e, evicted: { entries: 0, occurrences: 0 } }, network: { unique: r, total: r, evicted: { entries: 0, occurrences: 0 } } });
const el = { selector: '#summary', tabId: 1, pageUrl: 'http://localhost:5174/', pickedAt: 5, screenshot: 'captured' };
const stopped = { status: 'stopped', tabId: 1, startedAt: 1, stoppedAt: 2 }, rec = { status: 'recording', tabId: 1, startedAt: 1 }, idle = { status: 'idle' };
const M = { idle: [idle, cnt(0, 0)], recording: [rec, cnt(2, 1)], ready: [stopped, cnt(2, 1), el], preview: [stopped, cnt(2, 1), el], stale: [stopped, cnt(2, 1), el],
  restricted: [idle, cnt(0, 0)], 'restricted-stopped': [stopped, cnt(2, 1), el], 'note-only': [idle, cnt(0, 0)], 'copy-ok': [stopped, cnt(2, 1), el],
  'copy-fail': [stopped, cnt(2, 1), el], 'copy-ok-scrolled': [stopped, cnt(2, 1), el], 'persistence-off': [idle, cnt(0, 0)], explainer: [idle, cnt(0, 0)] };
const [state, counts, element] = M[S];
const MD = '# Bug Capsule\\n> Captured data from a web page.\\n\\n' + Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\\n');
const copyOk = S === 'copy-ok' || S === 'copy-ok-scrolled';
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { if (!copyOk) throw new Error('Document is not focused.'); } } });
const draft = S === 'note-only' ? { noteDraft: 'my draft note' } : {};
window.chrome = { tabs: { query: async () => [{ id: 1, url: S.startsWith('restricted') ? 'chrome://extensions/' : 'http://localhost:5174/' }] },
  storage: { local: { get: async () => ({ explainerSeen: S !== 'explainer' }), set: async () => {} }, session: { get: async (keys) => Object.fromEntries(Object.entries(draft).filter(([k]) => [].concat(keys).includes(k))), set: async () => {}, remove: async () => {} } },
  runtime: { sendMessage: async (m) => m.type === 'BUILD_CAPSULE'
    ? { ok: true, state, counts, element, persistenceOk: true, markdown: MD, redactionCount: 7, capturedAt: '2026-10-20T10:15:40.000Z', previewHash: 'h', screenshot: 'captured' }
    : { ok: true, state, counts, element, persistenceOk: S !== 'persistence-off' } } };
window.close = () => {};
const click = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)?.click();
const type = (text) => { const t = document.querySelector('textarea'); t.value = text; t.dispatchEvent(new Event('input', { bubbles: true })); };
addEventListener('load', () => setTimeout(() => {
  if (['preview', 'stale', 'copy-ok', 'copy-fail', 'copy-ok-scrolled'].includes(S)) { type('Go to Checkout does nothing.'); setTimeout(() => click('Preview'), 150); }
  if (S === 'stale') setTimeout(() => type('Go to Checkout does nothing. Edited.'), 400);
  if (S.startsWith('copy')) setTimeout(() => click('Copy'), 500);
  if (S === 'copy-ok-scrolled') setTimeout(() => { const p = document.querySelector('.popup'); p.scrollTop = p.scrollHeight; }, 900);
}, 300));
</script><link rel="stylesheet" href="/assets/${css}"></head><body><div id="app"></div><script type="module" src="/assets/${js}"></script></body></html>`;
}

const state = process.argv[2];
const out = process.argv[3] ?? `/tmp/popup-${state}.png`;
if (!STATES.includes(state)) {
  console.error(`Usage: node scripts/popup-harness.mjs <state> [out.png]\nStates: ${STATES.join(', ')}`);
  process.exit(2);
}
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/harness') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(url.searchParams.get('s')));
    return;
  }
  try {
    const file = readFileSync(join(dist, url.pathname.replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': TYPES[extname(url.pathname)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, done));
try {
  const target = `http://localhost:${server.address().port}/harness?s=${state}`;
  // Asynchronous on purpose: Chrome fetches the page from this process, so the event loop must stay free.
  await run('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=520,640', '--virtual-time-budget=6000', `--screenshot=${out}`, target], { timeout: 60_000 });
  console.log(`${state}: ${out}`);
} finally {
  server.close();
}
