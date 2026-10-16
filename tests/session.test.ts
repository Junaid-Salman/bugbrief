import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

interface Behavior {
  hangEvaluate: boolean;
  hangDetach: boolean;
  hangBody: boolean;
  hangMethods: string[];
  bodyGate?: Promise<void>;
  frameTreeGate?: Promise<void>;
  frameUrl: string;
  failBufferSet: number;
  failStateSet: number;
  targets?: Array<{ tabId: number; attached: boolean }>;
}

function installChrome() {
  const store = new Map<string, unknown>();
  const sent: Array<{ method: string; params?: unknown }> = [];
  const order: string[] = [];
  const setCalls: Array<Record<string, unknown>> = [];
  const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  const postData = new Map<string, { postData: string; base64Encoded: boolean }>();
  const behavior: Behavior = {
    hangEvaluate: false,
    hangDetach: false,
    hangBody: false,
    hangMethods: [],
    frameUrl: 'http://localhost:5174/',
    failBufferSet: 0,
    failStateSet: 0,
  };
  const chromeMock = {
    storage: {
      session: {
        async get(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
        },
        async set(items: Record<string, unknown>) {
          if ('recordingState' in items && behavior.failStateSet > 0) {
            behavior.failStateSet -= 1;
            throw new Error('state write failed');
          }
          if ('buffer.console' in items && behavior.failBufferSet > 0) {
            behavior.failBufferSet -= 1;
            throw new Error('buffer write failed');
          }
          setCalls.push(items);
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
      async attach(target: { tabId: number }) {
        order.push(`attach:${target.tabId}`);
      },
      async detach(target: { tabId: number }) {
        order.push(`detach:${target.tabId}`);
        if (behavior.hangDetach) await new Promise(() => undefined);
      },
      async getTargets() {
        return (behavior.targets ?? [{ tabId: 7, attached: true }, { tabId: 8, attached: true }]).map((target) => ({
          type: 'page',
          id: `t${target.tabId}`,
          title: '',
          url: '',
          ...target,
        }));
      },
      async sendCommand(_target: unknown, method: string, params?: { requestId?: string }) {
        sent.push({ method, params });
        if (behavior.hangMethods.includes(method)) await new Promise(() => undefined);
        if (method === 'Page.getFrameTree') {
          if (behavior.frameTreeGate) await behavior.frameTreeGate;
          return { frameTree: { frame: { id: 'MAIN', url: behavior.frameUrl } } };
        }
        if (method === 'Network.getResponseBody') {
          if (behavior.hangBody) await new Promise(() => undefined);
          if (behavior.bodyGate) await behavior.bodyGate;
          const found = bodies.get(params?.requestId ?? '');
          if (!found) throw new Error('No resource with given identifier');
          return found;
        }
        if (method === 'Network.getRequestPostData') {
          const found = postData.get(params?.requestId ?? '');
          if (!found) throw new Error('No data found');
          return found;
        }
        if (method === 'Runtime.evaluate') {
          if (behavior.hangEvaluate) await new Promise(() => undefined);
          return { result: { value: '{}' } };
        }
        return {};
      },
      onEvent: { addListener: (_: Listener) => undefined },
      onDetach: { addListener: (_: Listener) => undefined },
    },
  };
  vi.stubGlobal('chrome', chromeMock);
  return { store, sent, order, setCalls, bodies, postData, behavior };
}

type Env = ReturnType<typeof installChrome>;

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

const finished = (id: string, length = 10) => ({ requestId: id, timestamp: 100.2, encodedDataLength: length });

interface StoredEntry {
  count: number;
  url: string;
  method?: string;
  status?: number | null;
  message?: string;
  pageUrl?: string;
  responseBody?: string;
  requestBody?: string;
  responseBodyTruncated?: boolean;
  requestBodyTruncated?: boolean;
  errorText?: string;
}

const storedNetwork = (env: Env) => (env.store.get('buffer.network') ?? []) as StoredEntry[];
const storedConsole = (env: Env) => (env.store.get('buffer.console') ?? []) as StoredEntry[];

const recordingState = { status: 'recording', tabId: 7, startedAt: 1 };
const markedRecord = {
  requestId: 'p1',
  method: 'GET',
  url: 'http://localhost:5174/api/p1',
  headers: {},
  hasPostData: false,
  wallTimeMs: 1_760_000_000_000,
  monotonicSeconds: 100,
  marked: true,
  status: 500,
  mimeType: 'application/json',
  responseUrl: 'http://localhost:5174/api/p1',
  responseMonotonicSeconds: 100.1,
  pageUrl: 'http://localhost:5174/',
};

function preloadRecordingWithPending(env: Env) {
  env.store.set('recordingState', recordingState);
  env.store.set('buffer.pending', [markedRecord]);
  env.store.set('buffer.console', []);
  env.store.set('buffer.network', []);
  env.store.set('buffer.meta', {
    nextSeq: 1,
    evicted: { console: { entries: 0, occurrences: 0 }, network: { entries: 0, occurrences: 0 } },
  });
}

async function boot(preload?: (env: Env) => void) {
  vi.resetModules();
  const env = installChrome();
  preload?.(env);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = await import('../src/background/debugger-session');
  const state = await import('../src/background/state');
  return { env, session, state };
}

const loggedText = () => JSON.stringify([...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]);

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await session.stopRecording();
    expect(storedConsole(env)[0]?.pageUrl).toBe('http://localhost:5174/');
  });

  it('keeps the earliest 20 and caps console entries at 200', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    for (let i = 0; i < 250; i++) await session.handleEvent(source, 'Runtime.exceptionThrown', exception(`Distinct ${i}`));
    await session.stopRecording();
    const { counts } = await session.getCounts();
    expect(counts.console.unique).toBe(200);
    expect(counts.console.evicted.entries).toBe(50);
    const messages = new Set(storedConsole(env).map((entry) => entry.message));
    for (let i = 0; i < 20; i++) expect(messages.has(`Distinct ${i}`)).toBe(true);
    expect(messages.has('Distinct 249')).toBe(true);
  });

  it('inserts a 500 at loadingFinished with its body', async () => {
    const { session, env } = await boot();
    env.bodies.set('r1', { body: '{"error":"Order service unavailable"}', base64Encoded: false });
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r1', 'http://localhost:5174/api/orders', 'POST', { postData: '{"item":1}', hasPostData: true }));
    await session.handleEvent(source, 'Network.responseReceived', response('r1', 'http://localhost:5174/api/orders', 500));
    await session.handleEvent(source, 'Network.loadingFinished', finished('r1', 40));
    await session.stopRecording();
    const entries = storedNetwork(env);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'POST', status: 500, responseBody: '{"error":"Order service unavailable"}', requestBody: '{"item":1}' });
    expect(entries[0]?.url).toContain('/api/orders');
  });

  it('caps a large body and flags it, and fetches a request body Chrome did not inline', async () => {
    const { session, env } = await boot();
    env.bodies.set('r2', { body: 'x'.repeat(100_000), base64Encoded: false });
    env.postData.set('r2', { postData: 'p'.repeat(200_000), base64Encoded: false });
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r2', 'http://localhost:5174/api/upload', 'POST', { hasPostData: true }));
    await session.handleEvent(source, 'Network.responseReceived', response('r2', 'http://localhost:5174/api/upload', 500));
    await session.handleEvent(source, 'Network.loadingFinished', finished('r2', 100_000));
    await session.stopRecording();
    const entry = storedNetwork(env)[0];
    expect(entry?.responseBody).toHaveLength(24_576);
    expect(entry?.responseBodyTruncated).toBe(true);
    expect(entry?.requestBody).toHaveLength(8_192);
    expect(entry?.requestBodyTruncated).toBe(true);
  });

  it('stores no body for a binary 500', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r3', 'http://localhost:5174/api/binary-500'));
    await session.handleEvent(source, 'Network.responseReceived', response('r3', 'http://localhost:5174/api/binary-500', 500, 'image/png'));
    await session.handleEvent(source, 'Network.loadingFinished', finished('r3', 70));
    await session.stopRecording();
    expect(env.sent.some((call) => call.method === 'Network.getResponseBody')).toBe(false);
    const entry = storedNetwork(env)[0];
    expect(entry).toMatchObject({ status: 500 });
    expect(entry?.responseBody).toBeUndefined();
  });

  it('inserts an unfinished 500 without a body when Stop arrives before loadingFinished', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Network.requestWillBeSent', request('r4', 'http://localhost:5174/api/slow-body-500'));
    await session.handleEvent(source, 'Network.responseReceived', response('r4', 'http://localhost:5174/api/slow-body-500', 500));
    await session.stopRecording();
    const entries = storedNetwork(env);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toContain('/api/slow-body-500');
    expect(entries[0]?.status).toBe(500);
    expect(entries[0]?.responseBody).toBeUndefined();
  });

  it('persists the buffer so a restarted worker keeps the counts', async () => {
    const first = await boot();
    await first.session.startRecording(7);
    for (let i = 0; i < 5; i++) await first.session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await first.session.stopRecording();
    const kept = new Map(first.env.store);

    const second = await boot((env) => {
      for (const [key, value] of kept) env.store.set(key, value);
    });
    const { counts } = await second.session.getCounts();
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
    const { session, env } = await boot();
    await session.startRecording(7);
    await session.handleEvent(source, 'Page.frameNavigated', { frame: { id: 'CHILD', parentId: 'MAIN', url: 'http://localhost:5174/iframe' } });
    await session.handleEvent(source, 'Page.frameNavigated', { frame: { id: 'MAIN', url: 'http://localhost:5174/next' } });
    await session.handleEvent(source, 'Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'http://localhost:5174/spa/step-1' });
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await session.stopRecording();
    expect(storedConsole(env)[0]?.pageUrl).toBe('http://localhost:5174/spa/step-1');
  });

  it('reports persistence as off when every buffer write fails', async () => {
    const { session, env } = await boot();
    await session.startRecording(7);
    env.behavior.failBufferSet = 99;
    await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await session.stopRecording();
    expect((await session.getCounts()).persistenceOk).toBe(false);
  });

  it('keeps an event that arrives before ready resolves', async () => {
    const { session } = await boot((env) => preloadRecordingWithPending(env));
    const handling = session.handleEvent(source, 'Runtime.exceptionThrown', exception());
    await session.ready;
    await handling;
    expect((await session.getCounts()).counts.console.total).toBe(1);
  });

  describe('loadingFailed for a marked request', () => {
    it('keeps the status and drops the body', async () => {
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Network.requestWillBeSent', request('f1', 'http://localhost:5174/api/f1'));
      await session.handleEvent(source, 'Network.responseReceived', response('f1', 'http://localhost:5174/api/f1', 500));
      await session.handleEvent(source, 'Network.loadingFailed', { requestId: 'f1', timestamp: 100.3, type: 'Fetch', errorText: 'net::ERR_CONNECTION_RESET' });
      await session.stopRecording();
      expect(storedNetwork(env)[0]).toMatchObject({ status: 500, errorText: 'net::ERR_CONNECTION_RESET' });
      expect(storedNetwork(env)[0]?.responseBody).toBeUndefined();
    });

    it('keeps the status when a reload cancels it', async () => {
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Network.requestWillBeSent', request('f2', 'http://localhost:5174/api/f2'));
      await session.handleEvent(source, 'Network.responseReceived', response('f2', 'http://localhost:5174/api/f2', 500));
      await session.handleEvent(source, 'Network.loadingFailed', { requestId: 'f2', timestamp: 100.3, type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true });
      await session.stopRecording();
      expect(storedNetwork(env)[0]).toMatchObject({ status: 500 });
    });

    it('drops an unmarked canceled request', async () => {
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Network.requestWillBeSent', request('f3', 'http://localhost:5174/api/f3'));
      await session.handleEvent(source, 'Network.loadingFailed', { requestId: 'f3', timestamp: 100.3, type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true });
      await session.stopRecording();
      expect(storedNetwork(env)).toHaveLength(0);
    });
  });

  describe('Stop on a frozen or closing tab', () => {
    const stoppedWrites = (env: Env) => env.setCalls.filter((items) => (items.recordingState as { status?: string } | undefined)?.status === 'stopped');

    it('reaches stopped and flushes the buffer when Runtime.evaluate never answers', async () => {
      vi.useFakeTimers();
      vi.stubEnv('VITE_BUGBRIEF_DEBUG', 'true'); // the metadata read only runs in a debug build
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
      env.behavior.hangEvaluate = true;
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(1500);
      await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
      expect(storedConsole(env)).toHaveLength(1);
      expect((env.store.get('recordingState') as { status: string }).status).toBe('stopped');
      vi.useRealTimers();
    });

    it('reaches stopped when detach never answers', async () => {
      vi.useFakeTimers();
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
      env.behavior.hangDetach = true;
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(1500);
      await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
      expect(storedConsole(env)).toHaveLength(1);
      vi.useRealTimers();
    });

    it('reaches stopped within the budget when a body fetch, the metadata read and detach all hang', async () => {
      vi.useFakeTimers();
      vi.stubEnv('VITE_BUGBRIEF_DEBUG', 'true');
      const { session, env } = await boot();
      env.bodies.set('r9', { body: 'x', base64Encoded: false });
      await session.startRecording(7);
      env.behavior.hangBody = true;
      await session.handleEvent(source, 'Network.requestWillBeSent', request('r9', 'http://localhost:5174/api/x'));
      await session.handleEvent(source, 'Network.responseReceived', response('r9', 'http://localhost:5174/api/x', 500));
      await session.handleEvent(source, 'Network.loadingFinished', finished('r9'));
      env.behavior.hangEvaluate = true;
      env.behavior.hangDetach = true;
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
      vi.useRealTimers();
    });

    it('logs a warning when the drain times out', async () => {
      vi.useFakeTimers();
      const { session, env } = await boot();
      await session.startRecording(7);
      env.behavior.hangBody = true;
      await session.handleEvent(source, 'Network.requestWillBeSent', request('r8', 'http://localhost:5174/api/y'));
      await session.handleEvent(source, 'Network.responseReceived', response('r8', 'http://localhost:5174/api/y', 500));
      await session.handleEvent(source, 'Network.loadingFinished', finished('r8'));
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(2500);
      await stopping;
      expect(vi.mocked(console.warn).mock.calls.some((call) => call[0] === '[BugBrief] drain timed out')).toBe(true);
      vi.useRealTimers();
    });

    it('runs once when Stop, banner Cancel and tab close overlap', async () => {
      const { session, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
      await Promise.all([
        session.stopRecording(),
        session.handleDetach(source, 'canceled_by_user'),
        session.handleTabRemoved(7),
      ]);
      expect(stoppedWrites(env)).toHaveLength(1);
      expect((await session.getCounts()).counts.console.total).toBe(1);
    });

    it('can finish again after a run that fails', async () => {
      const { session, env, state } = await boot();
      await session.startRecording(7);
      const area = chrome.storage.session as unknown as { set: (items: Record<string, unknown>) => Promise<void> };
      const original = area.set.bind(area);
      let failures = 1;
      area.set = async (items) => {
        if (failures > 0 && 'recordingState' in items) {
          failures -= 1;
          throw new Error('storage unavailable');
        }
        return original(items);
      };
      await expect(session.finishSession('canceled_by_user')).rejects.toThrow('storage unavailable');
      await expect(session.finishSession('stop')).resolves.toMatchObject({ status: 'stopped' });
      expect(state.getCurrent().status).toBe('stopped');
      expect(env.store.size).toBeGreaterThan(0);
    });
  });

  describe('late body fetches (M1)', () => {
    async function recordSlowFetch() {
      const booted = await boot();
      let release!: () => void;
      booted.env.behavior.bodyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      booted.env.bodies.set('r7', { body: 'late body', base64Encoded: false });
      await booted.session.startRecording(7);
      await booted.session.handleEvent(source, 'Network.requestWillBeSent', request('r7', 'http://localhost:5174/api/late'));
      await booted.session.handleEvent(source, 'Network.responseReceived', response('r7', 'http://localhost:5174/api/late', 500));
      await booted.session.handleEvent(source, 'Network.loadingFinished', finished('r7'));
      return { ...booted, release };
    }

    it('inserts a body-less entry before stopped when a fetch outlives the drain, and ignores the late body', async () => {
      vi.useFakeTimers();
      const { session, env, release } = await recordSlowFetch();
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(2600);
      await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
      expect(storedNetwork(env)).toHaveLength(1);
      expect(storedNetwork(env)[0]?.responseBody).toBeUndefined();
      release();
      await vi.advanceTimersByTimeAsync(100);
      const { counts } = await session.getCounts();
      expect(counts.network).toMatchObject({ unique: 1, total: 1 });
      vi.useRealTimers();
    });

    it('does the same when banner Cancel ends the session while a fetch runs', async () => {
      const { session, env, release } = await recordSlowFetch();
      await session.handleDetach(source, 'canceled_by_user');
      expect(storedNetwork(env)).toHaveLength(1);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await session.getCounts()).counts.network).toMatchObject({ unique: 1, total: 1 });
    });

    it('drops a late body after Clear', async () => {
      vi.useFakeTimers();
      const { session, release } = await recordSlowFetch();
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(2600);
      await stopping;
      await session.clearBuffers();
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect((await session.getCounts()).counts.network.total).toBe(0);
      vi.useRealTimers();
    });

    it('drops a late body after a new recording starts', async () => {
      vi.useFakeTimers();
      const { session, release } = await recordSlowFetch();
      const stopping = session.stopRecording();
      await vi.advanceTimersByTimeAsync(2600);
      await stopping;
      await session.startRecording(7);
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect((await session.getCounts()).counts.network.total).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('a session found dead (M5)', () => {
    it('finalizes pending requests on wake when the debugger is gone', async () => {
      const { session, env } = await boot((e) => {
        preloadRecordingWithPending(e);
        e.behavior.targets = [{ tabId: 7, attached: false }];
      });
      await expect(session.ready).resolves.toMatchObject({ status: 'stopped' });
      expect((await session.getCounts()).counts.network).toMatchObject({ unique: 1, total: 1 });
      expect(storedNetwork(env)).toHaveLength(1);
      expect(storedNetwork(env)[0]?.responseBody).toBeUndefined();
      expect(env.store.get('buffer.pending')).toEqual([]);
    });

    it('finalizes only once when reconcile runs again at the same time', async () => {
      const { session, state } = await boot((e) => {
        preloadRecordingWithPending(e);
        e.behavior.targets = [{ tabId: 7, attached: false }];
      });
      await session.ready;
      await Promise.all([state.reconcile(), state.reconcile()]);
      expect((await session.getCounts()).counts.network.total).toBe(1);
    });

    it('finalizes a request that was in flight when a session died right after Start', async () => {
      const { session, state, env } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Network.requestWillBeSent', request('d1', 'http://localhost:5174/api/d1'));
      await session.handleEvent(source, 'Network.responseReceived', response('d1', 'http://localhost:5174/api/d1', 500));
      env.behavior.targets = [{ tabId: 7, attached: false }];
      await expect(state.reconcile()).resolves.toMatchObject({ status: 'stopped' });
      expect((await session.getCounts()).counts.network.total).toBe(1);
    });

    it('finalizes a rehydrated live recording when its request finishes', async () => {
      const { session, env } = await boot((e) => {
        preloadRecordingWithPending(e);
        e.bodies.set('p1', { body: '{"error":"restored"}', base64Encoded: false });
      });
      await session.ready;
      await session.handleEvent(source, 'Network.loadingFinished', finished('p1', 20));
      await session.stopRecording();
      expect(storedNetwork(env)).toHaveLength(1);
      expect(storedNetwork(env)[0]?.responseBody).toBe('{"error":"restored"}');
    });
  });

  describe('Start, Stop and Clear (M6)', () => {
    it('detaches and returns to idle when the recording state cannot be saved', async () => {
      const { session, state, env } = await boot();
      env.behavior.failStateSet = 1;
      await expect(session.startRecording(7)).rejects.toThrow('state write failed');
      expect(env.order).toContain('detach:7');
      expect(state.getCurrent().status).toBe('idle');
    });

    it('keeps an event that arrives while the frame tree is still loading', async () => {
      const { session, state, env } = await boot();
      let openTree!: () => void;
      env.behavior.frameTreeGate = new Promise<void>((resolve) => {
        openTree = resolve;
      });
      const starting = session.startRecording(7);
      await vi.waitFor(() => expect(state.getCurrent().status).toBe('recording'));
      await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
      openTree();
      await starting;
      await session.stopRecording();
      expect(storedConsole(env)).toHaveLength(1);
      expect(storedConsole(env)[0]?.pageUrl).toBe('http://localhost:5174/');
    });

    describe('Start on a frozen tab (R2-M1)', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('lets Stop run after Page.getFrameTree hangs, and keeps the tab URL', async () => {
        const { session, state, env } = await boot();
        env.behavior.hangMethods = ['Page.getFrameTree'];
        const starting = session.startRecording(7);
        const stopping = session.stopRecording();
        await vi.advanceTimersByTimeAsync(3100);
        await expect(starting).resolves.toMatchObject({ status: 'recording' });
        await vi.advanceTimersByTimeAsync(100);
        await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
        expect(state.getCurrent().status).toBe('stopped');
      });

      it('fails Start, detaches and returns to idle when an enable call hangs', async () => {
        const { session, state, env } = await boot();
        env.behavior.hangMethods = ['Page.enable'];
        const starting = session.startRecording(7);
        const failure = expect(starting).rejects.toThrow(/Could not enable debugging domains.*Page\.enable/);
        await vi.advanceTimersByTimeAsync(3100);
        await failure;
        expect(env.order).toContain('detach:7');
        expect(state.getCurrent().status).toBe('idle');
      });

      it('can start again after a timed-out Start, and Clear waits behind it', async () => {
        const { session, state, env } = await boot();
        env.behavior.hangMethods = ['Runtime.enable'];
        const first = session.startRecording(7);
        const firstFailure = expect(first).rejects.toThrow('timed out');
        const clearing = session.clearBuffers();
        await vi.advanceTimersByTimeAsync(3100);
        await firstFailure;
        await expect(clearing).resolves.toMatchObject({ status: 'idle' });
        env.behavior.hangMethods = [];
        await expect(session.startRecording(7)).resolves.toMatchObject({ status: 'recording' });
        expect(state.getCurrent().status).toBe('recording');
      });
    });

    it('runs overlapping starts one after the other', async () => {
      const { session, state, env } = await boot();
      await Promise.all([session.startRecording(7), session.startRecording(8)]);
      const attach7 = env.order.indexOf('attach:7');
      const detach7 = env.order.indexOf('detach:7');
      const attach8 = env.order.indexOf('attach:8');
      expect(attach7).toBeGreaterThanOrEqual(0);
      expect(detach7).toBeGreaterThan(attach7);
      expect(attach8).toBeGreaterThan(detach7);
      expect(state.getCurrent()).toMatchObject({ status: 'recording', tabId: 8 });
    });

    it('lets Clear wait for an overlapping Stop', async () => {
      const { session } = await boot();
      await session.startRecording(7);
      await session.handleEvent(source, 'Runtime.exceptionThrown', exception());
      const [stopped, cleared] = await Promise.all([session.stopRecording(), session.clearBuffers()]);
      expect(stopped.status).toBe('stopped');
      expect(cleared.status).toBe('idle');
      expect((await session.getCounts()).counts.console.total).toBe(0);
    });
  });

  describe('logging (M2)', () => {
    async function recordSecrets() {
      const booted = await boot();
      booted.env.behavior.frameUrl = 'http://localhost:5174/?session=PAGESECRET';
      booted.env.bodies.set('s1', { body: '{"token":"SECRETBODY"}', base64Encoded: false });
      await booted.session.startRecording(7);
      await booted.session.handleEvent(
        source,
        'Network.requestWillBeSent',
        request('s1', 'http://localhost:5174/api/orders?token=SECRETQ&email=a@b.co', 'POST', { postData: '{"password":"hunter2"}', hasPostData: true }),
      );
      await booted.session.handleEvent(source, 'Network.responseReceived', response('s1', 'http://localhost:5174/api/orders?token=SECRETQ', 500));
      await booted.session.handleEvent(source, 'Network.loadingFinished', finished('s1'));
      await booted.session.handleEvent(source, 'Runtime.exceptionThrown', exception('Auth failed token=ABC999'));
      await booted.session.stopRecording();
      return booted;
    }

    it('prints no captured data and skips the metadata read in a normal build', async () => {
      const { env } = await recordSecrets();
      const text = loggedText();
      for (const secret of ['SECRETQ', 'hunter2', 'SECRETBODY', 'ABC999', 'PAGESECRET', '/api/orders', 'localhost:5174']) {
        expect(text).not.toContain(secret);
      }
      expect(env.sent.some((call) => call.method === 'Runtime.evaluate')).toBe(false);
      expect(vi.mocked(console.log).mock.calls.some((call) => call[0] === '[BugBrief] recording stopped')).toBe(true);
    });

    it('prints entry lines, the summary and reads the metadata in a debug build', async () => {
      vi.stubEnv('VITE_BUGBRIEF_DEBUG', 'true');
      const { env } = await recordSecrets();
      const lines = vi.mocked(console.log).mock.calls.map((call) => call[0]);
      expect(lines).toContain('[BugBrief] console');
      expect(lines).toContain('[BugBrief] network');
      expect(lines).toContain('[BugBrief] buffer summary');
      expect(env.sent.some((call) => call.method === 'Runtime.evaluate')).toBe(true);
    });
  });

  describe('ready on wake', () => {
    it('resolves within the probe timeout when the tab is frozen', async () => {
      vi.useFakeTimers();
      const { session } = await boot((env) => {
        env.store.set('recordingState', { status: 'recording', tabId: 7, startedAt: 1 });
        env.behavior.hangEvaluate = true;
      });
      let settled = false;
      void session.ready.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(settled).toBe(true);
      expect((await session.ready).status).toBe('recording');
      vi.useRealTimers();
    });

    it('marks a recording stopped on wake when the debugger is really gone', async () => {
      const { session } = await boot((env) => {
        env.store.set('recordingState', { status: 'recording', tabId: 7, startedAt: 1 });
        env.behavior.targets = [{ tabId: 7, attached: false }];
      });
      expect((await session.ready).status).toBe('stopped');
    });
  });
});
