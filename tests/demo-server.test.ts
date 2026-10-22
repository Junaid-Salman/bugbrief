import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoServer } from '../demo/server.mjs';

const server = createDemoServer();
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('pages', () => {
  it('serves the shop at / and the test bench at /lab', async () => {
    const shop = await fetch(`${base}/`);
    expect(shop.status).toBe(200);
    expect(await shop.text()).toContain('Demo Shop');
    const lab = await fetch(`${base}/lab`);
    expect(lab.status).toBe(200);
    expect(await lab.text()).toContain('Conscribe Demo');
  });

  it('serves the shop script and stylesheet with the right types', async () => {
    const script = await fetch(`${base}/shop/app.js`);
    expect(script.headers.get('content-type')).toContain('javascript');
    const css = await fetch(`${base}/shop/styles.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('serves only plain file names under /shop/', async () => {
    expect((await fetch(`${base}/shop/..%2Fserver.mjs`)).status).toBe(404);
    expect((await fetch(`${base}/shop/orders.mjs`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('shop order endpoint', () => {
  it('fails with a 500 whose body names the cause and carries the customer email', async () => {
    const response = await post('/api/orders', { customer: { email: 'jane.doe@example.com' }, items: [{ sku: 'A', price: '1.00', qty: 1 }] });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('Order service error');
    expect(body.detail).toContain("reading 'toFixed'");
    expect(body.detail).toContain('jane.doe@example.com');
  });

  it('accepts an order that carries a total (the path a fix takes)', async () => {
    const response = await post('/api/orders', { customer: { email: 'a@b.c' }, total: 34.25 });
    expect(response.status).toBe(201);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const response = await fetch(`${base}/api/orders`, { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });
});

describe('test bench routes keep working', () => {
  it.each(['/api/lab/orders', '/api/lab/orders/123', '/api/upload'])('POST %s answers 500', async (path) => {
    expect((await post(path, { blob: 'z'.repeat(200_000) })).status).toBe(500);
  });

  it.each(['/api/missing', '/api/missing/item-7'])('GET %s answers 404 with JSON', async (path) => {
    const response = await fetch(base + path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('answers a 100 KB JSON error and a binary 500', async () => {
    const large = await fetch(`${base}/api/large-500`);
    expect(large.status).toBe(500);
    expect((await large.text()).length).toBeGreaterThan(100_000);
    const binary = await fetch(`${base}/api/binary-500`);
    expect(binary.status).toBe(500);
    expect(binary.headers.get('content-type')).toBe('image/png');
  });

  it('delivers the slow body after a delay', async () => {
    const response = await fetch(`${base}/api/slow-body-500`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Slow body arrived');
  }, 10_000);

  it('serves the iframe page', async () => {
    const response = await fetch(`${base}/iframe`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Iframe page');
  });
});
