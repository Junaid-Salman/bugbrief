import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function installChrome() {
  const store = new Map<string, unknown>();
  const sent: Array<{ method: string; params?: unknown }> = [];
  const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  const postData = new Map<string, { postData: string; base64Encoded: boolean }>();
  const chromeMock = {
    storage: {
      session: {
        async get(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) store.set(key, JSON.parse(JSON.stringify(value)));
        },
        async remove(keys: string[]) {
          for (const key of keys) store.delete(key);
        },
        async getBytesInUse() {
          return JSON.stringify([...store.values()]).length;
        },
      },
    },
    tabs: { async get(tabId: number) { return { id: tabId, url: 'http://localhost:5174/' }; } },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand(_target: unknown, method: string, params?: { requestId?: string }) {
        sent.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'MAIN', url: 'http://localhost:5174/' } } };
        }
        if (method === 'Network.getResponseBody') {
          const found = bodies.get(params?.requestId ?? '');
          if (!found) throw new Error('No resource with given identifier');
          return found;
        }
        if (method === 'Network.getRequestPostData') {
          const found = postData.get(params?.requestId ?? '');
          if (!found) throw new Error('No data found');
          return found;
        }
        if (method === 'Runtime.evaluate') return { result: { value: '{}' } };
        return {};
      },
      onEvent: { addListener: (_: Listener) => undefined },
      onDetach: { addListener: (_: Listener) => undefined },
    },
  };
  vi.stubGlobal('chrome', chromeMock);
  return { store, sent, bodies, postData };
}

const source = { tabId: 7 };

const exception = (message = "TypeError: Cannot read properties of undefined (reading 'map')") => ({
  timestamp: Date.now(),
  exceptionDetails: {
    exceptionId: 1,
    text: 'Uncaught',
    lineNumber: 1,
    columnNumber: 1,
    url: 'http://localhost:5174/',
    exception: { type: 'object', description: `${message}\n    at boom (http://localhost:5174/:49:22)` },
    stackTrace: { callFrames: [{ functionName: 'boom', scriptId: '1', url: 'http://localhost:5174/', lineNumber: 48, columnNumber: 21 }] },
  },
});

const request = (id: string, url: string, method = 'GET', extra: Record<string, unknown> = {}) => ({
  requestId: id,
  loaderId: 'L',
  documentURL: 'http://localhost:5174/',
  request: { url, method, headers: {}, initialPriority: 'High', referrerPolicy: 'no-referrer', ...extra },
  timestamp: 100,
  wallTime: 1_760_000_000,
  initiator: { type: 'script' },
  redirectHasExtraInfo: false,
});

const response = (id: string, url: string, status: number, mimeType = 'application/json') => ({
  requestId: id,
  loaderId: 'L',
  timestamp: 100.1,
  type: 'Fetch',
  hasExtraInfo: false,
  response: { url, status, statusText: '', headers: {}, mimeType, charset: '', connectionReused: false, connectionId: 1, encodedDataLength: 0, securityState: 'neutral' },
});

async function boot() {
  vi.resetModules();
  const env = installChrome();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = await import('../src/background/debugger-session');
  const state = await import('../src/background/state');
  return { env, session, state };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('debugger session with a mocked chrome API', () => {
  it('merges 50 identical exceptions into one entry', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    await Promise.all(Array.from({ length: 50 }, () => session.handleEvent(source, 'Runtime.exceptionThrown', exception())));
    const { counts } = await session.getCounts();
    expect(counts.console.unique).toBe(1);
    expect(counts.console.total).toBe(50);
  });

  it('stamps entries with the page URL seeded at start', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    const logged = vi.mocked(console.log).mock.calls.find((call) => call[0] === '[BugBrief] console');
    expect((logged?.[1] as { pageUrl?: string }).pageUrl).toBe('http://localhost:5174/');
  });

  it('keeps the earliest 20 and caps console entries at 200', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    for (let i = 0; i < 250; i++) await session.handleEvent(source, 'Runtime.exceptionThrown', exception(`Distinct ${i}`));
    const { counts } = await session.getCounts();
    expect(counts.console.unique).toBe(200);
    expect(counts.console.evicted.entries).toBe(50);
  });

  it('inserts a 500 at loadingFinished with its body', async () => {
    const { session, env } = await boot();
    env.bodies.set('r1', { body: '{"error":"Order service unavailable"}', base64Encoded: false });
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r1', 'http://localhost:5174/api/orders', 'POST', { postData: '{"item":1}', hasPostData: true }));
    await session.handleEvent(source, 'Network.responseReceived', response('r1', 'http://localhost:5174/api/orders', 500));
    await session.handleEvent(source, 'Network.loadingFinished', { requestId: 'r1', timestamp: 100.2, encodedDataLength: 40 });
    await session.stopRecording();
    const summary = vi.mocked(console.log).mock.calls.find((call) => call[0] === '[BugBrief] buffer summary')?.[1] as {
      network: Array<{ entry: string; responseBodyLength: number; requestBodyLength: number }>;
    };
    expect(summary.network).toHaveLength(1);
    expect(summary.network[0]?.entry).toContain('POST /api/orders 500');
    expect(summary.network[0]?.responseBodyLength).toBe('{"error":"Order service unavailable"}'.length);
    expect(summary.network[0]?.requestBodyLength).toBe(10);
  });

  it('caps a large body and flags it, and fetches a request body Chrome did not inline', async () => {
    const { session, env } = await boot();
    env.bodies.set('r2', { body: 'x'.repeat(100_000), base64Encoded: false });
    env.postData.set('r2', { postData: 'p'.repeat(200_000), base64Encoded: false });
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r2', 'http://localhost:5174/api/upload', 'POST', { hasPostData: true }));
    await session.handleEvent(source, 'Network.responseReceived', response('r2', 'http://localhost:5174/api/upload', 500));
    await session.handleEvent(source, 'Network.loadingFinished', { requestId: 'r2', timestamp: 100.2, encodedDataLength: 100_000 });
    await session.stopRecording();
    const summary = vi.mocked(console.log).mock.calls.find((call) => call[0] === '[BugBrief] buffer summary')?.[1] as {
      network: Array<{ responseBodyLength: number; responseBodyTruncated: boolean; requestBodyLength: number; requestBodyTruncated: boolean }>;
    };
    expect(summary.network[0]).toMatchObject({
      responseBodyLength: 24_576,
      responseBodyTruncated: true,
      requestBodyLength: 8_192,
      requestBodyTruncated: true,
    });
  });

  it('stores no body for a binary 500', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r3', 'http://localhost:5174/api/binary-500'));
    await session.handleEvent(source, 'Network.responseReceived', response('r3', 'http://localhost:5174/api/binary-500', 500, 'image/png'));
    await session.handleEvent(source, 'Network.loadingFinished', { requestId: 'r3', timestamp: 100.2, encodedDataLength: 70 });
    await session.stopRecording();
    expect(env.sent.some((call) => call.method === 'Network.getResponseBody')).toBe(false);
    const summary = vi.mocked(console.log).mock.calls.find((call) => call[0] === '[BugBrief] buffer summary')?.[1] as {
      network: Array<{ responseBodyLength: number }>;
    };
    expect(summary.network[0]?.responseBodyLength).toBe(0);
  });

  it('inserts an unfinished 500 without a body when Stop arrives before loadingFinished', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r4', 'http://localhost:5174/api/slow-body-500'));
    await session.handleEvent(source, 'Network.responseReceived', response('r4', 'http://localhost:5174/api/slow-body-500', 500));
    await session.stopRecording();
    const summary = vi.mocked(console.log).mock.calls.find((call) => call[0] === '[BugBrief] buffer summary')?.[1] as {
      network: Array<{ entry: string; responseBodyLength: number }>;
    };
    expect(summary.network).toHaveLength(1);
    expect(summary.network[0]?.entry).toContain('GET /api/slow-body-500 500');
    expect(summary.network[0]?.responseBodyLength).toBe(0);
  });

  it('persists the buffer so a restarted worker keeps the counts', async () => {
    const first = await boot();
    await first.session.startRecording(7);
    for (let i = 0; i < 5; i++) await first.session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await first.session.stopRecording();
    const kept = new Map(first.env.store);

    vi.resetModules();
    const env = installChrome();
    for (const [key, value] of kept) env.store.set(key, value);
    const session = await import('../src/background/debugger-session');
    const { counts } = await session.getCounts();
    expect(counts.console.unique).toBe(1);
    expect(counts.console.total).toBe(5);
  });

  it('Clear empties the buffer and the stored keys', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await session.stopRecording();
    await session.clearBuffers();
    const { counts } = await session.getCounts();
    expect(counts.console.unique).toBe(0);
    expect([...env.store.keys()].filter((key) => key.startsWith('buffer.'))).toEqual([]);
  });

  it('rejects Clear while recording', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    await expect(session.clearBuffers()).rejects.toThrow('Stop recording before clearing.');
  });

  it('updates the page URL on main-frame navigation and ignores iframes', async () => {
    const { session } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Page.frameNavigated', { frame: { id: 'CHILD', parentId: 'MAIN', url: 'http://localhost:5174/iframe' } });
    await session.handleEvent(source, 'Page.frameNavigated', { frame: { id: 'MAIN', url: 'http://localhost:5174/next' } });
    await session.handleEvent(source, 'Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'http://localhost:5174/spa/step-1' });
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    const logged = vi.mocked(console.log).mock.calls.filter((call) => call[0] === '[BugBrief] console').at(-1);
    expect((logged?.[1] as { pageUrl?: string }).pageUrl).toBe('http://localhost:5174/spa/step-1');
  });
});
