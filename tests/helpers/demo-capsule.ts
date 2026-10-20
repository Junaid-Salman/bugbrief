import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildCapsule, type BuildDeps, type BuildResult } from '../../src/background/capsule-builder';
import type { PickedPage } from '../../src/core/element-model';
import { emptyState, insertConsole, insertNetwork, type BufferState } from '../../src/core/buffer-model';
import type { ElementSnapshot, RawConsoleEntry } from '../../src/core/types';
import { createDemoServer } from '../../demo/server.mjs';
import { UA } from './capsule';

/** The page the extension would record, as Chrome would report it. The port in the run below is random. */
export const DEMO_ORIGIN = 'http://localhost:5174';
export const DEMO_PAGE_URL = `${DEMO_ORIGIN}/?token=demo-session-3b7f1c9e2a`;
const NOW = new Date('2026-10-20T10:15:40.000Z');
const at = (seconds: number): number => Date.UTC(2026, 9, 20, 10, 15, seconds);
const EMPTY = { entries: 0, occurrences: 0 };

export interface DemoRun {
  /** The error the page throws while it loads, as a message and Chrome-shaped stack. */
  exception: { message: string; stack: string };
  /** What the page logged with console.error, with the stack of the call. */
  consoleError: { message: string; stack: string };
  request: { method: string; url: string; requestHeaders: Record<string, string>; requestBody: string; status: number; responseBody: string };
  /** The picked element's HTML after the page rendered. */
  summaryHtml: string;
}

const rewrite = (text: string, origin: string): string => text.split(origin).join(DEMO_ORIGIN);

/** The line and column of a snippet in app.js, so a moved line moves the stack with it. */
function locate(source: string, snippet: string): { line: number; column: number } {
  const index = source.indexOf(snippet);
  if (index < 0) throw new Error(`"${snippet}" not found in demo/shop/app.js`);
  const before = source.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

/** Loads the real demo page in jsdom against the real demo server and records what the extension would see. */
export async function runDemoPage(): Promise<DemoRun> {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let dom: JSDOM | undefined;
  try {
    let thrown: { name: string; message: string; stack?: string } | undefined;
    const logged: string[] = [];
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string; status: number; text: string }> = [];
    const pending: Array<Promise<unknown>> = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
    dom = await JSDOM.fromURL(`${origin}/`, {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        // The window's own error event carries the real error object with its stack, unlike jsdom's console report.
        window.addEventListener('error', (event: never) => {
          const error = (event as { error?: unknown }).error as { name?: unknown; message?: unknown; stack?: unknown } | null;
          if (!thrown && error && typeof error.message === 'string') {
            thrown = { name: String(error.name ?? 'Error'), message: error.message, stack: typeof error.stack === 'string' ? error.stack : undefined };
          }
        });
        (window as unknown as { fetch: unknown }).fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
          const call = (async () => {
            const response = await fetch(new URL(String(input), origin), init);
            const text = await response.clone().text();
            calls.push({ method: init.method ?? 'GET', url: String(input), headers: init.headers ?? {}, body: String(init.body ?? ''), status: response.status, text });
            return response;
          })();
          pending.push(call.catch(() => undefined));
          return call;
        };
      },
    });
    await new Promise<void>((done) => (dom?.window.document.readyState === 'complete' ? done() : dom?.window.addEventListener('load', () => done())));
    await Promise.allSettled(pending);
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    const order = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/orders'));
    if (!thrown || !order || logged.length === 0) throw new Error('the demo page did not fail the way the planted bugs say');
    const appSource = readFileSync(new URL('../../demo/shop/app.js', import.meta.url), 'utf8');
    const frames = String(thrown.stack ?? '').split('\n').slice(1).filter((line) => /\/shop\/app\.js:\d+:\d+|<anonymous>/.test(line) && !line.includes('node_modules') && !line.includes('jsdom'));
    const logAt = locate(appSource, 'console.error(');
    return {
      exception: { message: `Uncaught ${thrown.name}: ${thrown.message}`, stack: [`${thrown.name}: ${thrown.message}`, ...frames.map((frame) => rewrite(frame, origin))].join('\n') },
      consoleError: { message: logged[0] ?? '', stack: `Error\n    at placeOrder (${DEMO_ORIGIN}/shop/app.js:${logAt.line}:${logAt.column})` },
      request: {
        method: order.method,
        url: `${DEMO_ORIGIN}/api/orders`,
        requestHeaders: Object.fromEntries(Object.entries(order.headers).map(([name, value]) => [name.toLowerCase(), String(value)])),
        requestBody: order.body,
        status: order.status,
        responseBody: order.text,
      },
      summaryHtml: dom.window.document.getElementById('summary')?.outerHTML ?? '',
    };
  } finally {
    dom?.window.close();
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
}

export interface DemoCapsuleOptions {
  /** How many times the page error fired. The default is the one reload the demo walkthrough does. */
  exceptionCount?: number;
  /** Extra console entries, inserted through the same merge as the real buffer. */
  extraConsole?: RawConsoleEntry[];
  /** The page URL the element was picked on. Defaults to the recorded page. */
  elementPageUrl?: string;
}

/**
 * The Tier A capsule. Raw events go through the real buffer (merge on insert), then the real builder, which
 * redacts, caps, links, summarizes and renders. Only the events are modeled: they match what the demo page produces.
 */
export function buildDemoCapsule(run: DemoRun, options: DemoCapsuleOptions = {}): { result: BuildResult; input: unknown } {
  const state: BufferState = emptyState();
  state.pageUrl = DEMO_PAGE_URL;
  state.page = { title: 'Your Cart | Demo Shop', viewport: { width: 1280, height: 800 }, forUrl: DEMO_PAGE_URL };
  const script = `${DEMO_ORIGIN}/shop/app.js`;
  for (let n = 0; n < (options.exceptionCount ?? 1); n++) {
    insertConsole(state, { level: 'error', message: run.exception.message, stack: run.exception.stack, url: script, timestamp: at(21 + n), pageUrl: DEMO_PAGE_URL });
  }
  insertConsole(state, { level: 'error', message: run.consoleError.message, stack: run.consoleError.stack, url: script, timestamp: at(30), pageUrl: DEMO_PAGE_URL });
  for (const extra of options.extraConsole ?? []) insertConsole(state, extra);
  insertNetwork(state, {
    method: run.request.method, url: run.request.url, status: run.request.status, timestamp: at(30), pageUrl: DEMO_PAGE_URL,
    requestHeaders: run.request.requestHeaders, requestBody: run.request.requestBody, responseBody: run.request.responseBody,
  });
  const snapshot: ElementSnapshot = {
    selector: '#summary',
    outerHTML: run.summaryHtml,
    styles: { display: 'block', width: '313px' },
    rect: { x: 712, y: 171, width: 313, height: 288 },
    screenshotDataUrl: 'data:image/png;base64,AAAA',
  };
  const picked: PickedPage = { url: options.elementPageUrl ?? DEMO_PAGE_URL, title: 'Your Cart | Demo Shop', viewport: { width: 1280, height: 800 }, devicePixelRatio: 1 };
  const deps: BuildDeps = {
    readBuffer: () => state,
    readElement: () => ({ snapshot, tabId: 1, pickedAt: 5, page: picked, screenshot: { status: 'captured' } }),
    userAgent: () => UA,
    now: () => NOW,
  };
  return { result: buildCapsule(deps, { userNote: 'Go to Checkout does nothing: the page throws an error and the order fails with a 500.' }), input: { state, snapshot, picked } };
}
