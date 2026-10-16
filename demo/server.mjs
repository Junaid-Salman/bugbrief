import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 5174);

const largeBody = JSON.stringify({
  error: 'Large error payload',
  details: 'x'.repeat(100_000),
});
const slowBody = JSON.stringify({ error: 'Slow body arrived' });
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  req.resume();

  if (req.method === 'POST' && /^\/api\/orders(\/\d+)?$/.test(url.pathname)) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Order service unavailable' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    });
    return;
  }
  if (url.pathname === '/api/missing' || url.pathname.startsWith('/api/missing/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(new URL('./index.html', import.meta.url));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, () => {
  console.log(`Demo running at http://localhost:${port}`);
});
