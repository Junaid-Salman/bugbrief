import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createOrder } from './shop/orders.mjs';

const largeBody = JSON.stringify({
  error: 'Large error payload',
  details: 'x'.repeat(100_000),
});
const slowBody = JSON.stringify({ error: 'Slow body arrived' });
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const STATIC_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function sendHtml(res, file) {
  const html = await readFile(new URL(file, import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The demo server: the shop at /, the test bench at /lab. Call listen() on the result. */
export function createDemoServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      let order;
      try {
        order = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const result = createOrder(order);
      sendJson(res, result.status, result.body);
      return;
    }
    if (req.method === 'POST' && /^\/api\/lab\/orders(\/\d+)?$/.test(url.pathname)) {
      sendJson(res, 500, { error: 'Order service unavailable' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      sendJson(res, 500, { error: 'Upload failed' });
      return;
    }
    if (url.pathname === '/api/missing' || url.pathname.startsWith('/api/missing/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (url.pathname === '/api/large-500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(largeBody);
      return;
    }
    if (url.pathname === '/api/binary-500') {
      res.writeHead(500, { 'content-type': 'image/png' });
      res.end(pngBytes);
      return;
    }
    if (url.pathname === '/api/slow-body-500') {
      res.writeHead(500, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(slowBody),
      });
      res.flushHeaders();
      setTimeout(() => res.end(slowBody), 1500);
      return;
    }
    if (url.pathname === '/iframe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>Iframe</title><p>Iframe page</p><script>setTimeout(() => { location.href = "/iframe?step=2"; }, 500);</script>',
      );
      return;
    }
    // Only plain file names under /shop/, so a path can never leave the shop folder.
    const asset = /^\/shop\/([a-z0-9-]+\.(js|css))$/.exec(url.pathname);
    if (asset) {
      const file = await readFile(new URL(`./shop/${asset[1]}`, import.meta.url));
      res.writeHead(200, { 'content-type': STATIC_TYPES[asset[2]] });
      res.end(file);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await sendHtml(res, './shop/index.html');
      return;
    }
    if (url.pathname === '/lab') {
      await sendHtml(res, './lab.html');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5174);
  createDemoServer().listen(port, () => {
    console.log(`Demo running at http://localhost:${port}`);
    console.log(`  Shop:  http://localhost:${port}/?token=demo-session-3b7f1c9e2a`);
    console.log(`  Lab:   http://localhost:${port}/lab`);
  });
}
