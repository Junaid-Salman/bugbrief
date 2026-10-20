// Checks that the demo shop works: it loads the page in jsdom against the folder's own server and looks at what
// happens. It is free, needs no browser and calls no network service. Usage: node scripts/demo-verify.mjs [folder]
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const repoDemo = fileURLToPath(new URL('../demo', import.meta.url));
const REQUIRED = ['server.mjs', 'shop/index.html', 'shop/app.js', 'shop/orders.mjs'];
const SETTLE_MS = 5000;

const sum = (items) => items.reduce((total, item) => total + Number(item.price) * Number(item.qty), 0);

/** Loads the shop from a copy of `folder` and returns one result per check. Never throws for a broken demo. */
export async function verifyDemo(folder = repoDemo) {
  const source = resolve(folder);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });

  const missing = REQUIRED.filter((file) => !existsSync(join(source, file)));
  check('the demo files exist', missing.length === 0, `missing: ${missing.join(', ')}`);
  if (missing.length > 0) return { ok: false, results };

  const work = mkdtempSync(join(tmpdir(), 'bugbrief-verify-'));
  let server;
  let dom;
  const cleanups = [];
  try {
    cpSync(source, work, { recursive: true });
    const { createDemoServer } = await import(pathToFileURL(join(work, 'server.mjs')).href);
    server = createDemoServer();
    await new Promise((resolveListen) => server.listen(0, resolveListen));
    const base = `http://localhost:${server.address().port}`;

    const uncaught = [];
    const consoleErrors = [];
    const requests = [];
    const pending = [];
    const onRejection = (reason) => uncaught.push(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.on('unhandledRejection', onRejection);
    cleanups.push(() => process.off('unhandledRejection', onRejection));
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => uncaught.push(String(error.detail?.message ?? error.message)));
    virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));

    dom = await JSDOM.fromURL(`${base}/`, {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.fetch = (input, init = {}) => {
          const call = (async () => {
            const response = await fetch(new URL(String(input), base), init);
            const text = await response.clone().text();
            requests.push({ url: String(input), method: init.method ?? 'GET', body: init.body, status: response.status, text });
            return response;
          })();
          pending.push(call.catch(() => undefined));
          return call;
        };
      },
    });

    await Promise.race([
      new Promise((done) => (dom.window.document.readyState === 'complete' ? done() : dom.window.addEventListener('load', done))),
      new Promise((done) => setTimeout(done, SETTLE_MS)),
    ]);
    await Promise.race([Promise.allSettled(pending), new Promise((done) => setTimeout(done, SETTLE_MS))]);
    // Let the page's own continuations after the last answer run (for example the console.error after a 500).
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));

    check('no uncaught error while the page loads', uncaught.length === 0, uncaught[0] ?? '');
    const order = requests.find((request) => request.method === 'POST' && request.url.endsWith('/api/orders'));
    let totalOk = false;
    let detail = order ? `status ${order.status}` : 'the page sent no POST /api/orders';
    if (order && order.status >= 200 && order.status < 300) {
      try {
        const sent = JSON.parse(String(order.body));
        const got = Number(JSON.parse(order.text).total);
        totalOk = Math.abs(got - sum(sent.items)) < 0.005;
        if (!totalOk) detail = `total ${got} does not equal the ${sum(sent.items)} the page sent`;
      } catch {
        detail = 'the order request or its answer is not valid JSON';
      }
    }
    check('the order request succeeds with the right total', totalOk, detail);
    check('the page logs no console error', consoleErrors.length === 0, consoleErrors[0] ?? '');
    const document = dom.window.document;
    const items = document.querySelectorAll('#cart-list .cart-item').length;
    const label = document.getElementById('discount-label')?.textContent?.trim();
    check('the cart still shows three items and the discount label', items === 3 && label === 'Discount (-20%)', `${items} items, label "${label}"`);
  } catch (error) {
    check('the verifier ran', false, error instanceof Error ? error.message : String(error));
  } finally {
    for (const cleanup of cleanups) cleanup();
    dom?.window.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((closed) => server.close(closed));
    }
    rmSync(work, { recursive: true, force: true });
  }
  return { ok: results.every((result) => result.ok), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A folder with a server that never answers or never exits must not hang the command.
  setTimeout(() => {
    console.error('demo:verify timed out after 30 s');
    process.exit(2);
  }, 30_000).unref();
  const folder = process.argv[2] ?? repoDemo;
  const { ok, results } = await verifyDemo(folder);
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
  console.log(ok ? '\nThe demo works.' : '\nThe demo is still broken.');
  process.exit(ok ? 0 : 1);
}
