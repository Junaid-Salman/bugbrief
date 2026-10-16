import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 5174);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (req.method === 'POST' && /^\/api\/orders(\/\d+)?$/.test(url.pathname)) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Order service unavailable' }));
    return;
  }
  if (url.pathname === '/api/missing') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
