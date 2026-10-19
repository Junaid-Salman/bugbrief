/** Criterion 11 (Q1): GET_STATE reports the element, CLEAR removes it, START_RECORDING keeps it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '../src/shared/messages';

let state: RecordingState = { status: 'idle' };
const session = {
  ready: Promise.resolve(state),
  getCounts: vi.fn(async () => ({
    counts: { console: { unique: 0, total: 0, evicted: { entries: 0, occurrences: 0 } }, network: { unique: 0, total: 0, evicted: { entries: 0, occurrences: 0 } } },
    persistenceOk: true,
  })),
  startRecording: vi.fn(async (tabId: number) => (state = { status: 'recording', tabId, startedAt: 1 })),
  stopRecording: vi.fn(async () => (state = { status: 'stopped', tabId: 1, startedAt: 1, stoppedAt: 2 })),
  clearBuffers: vi.fn(async () => {
    if (state.status === 'recording') throw new Error('Stop recording before clearing.');
    return (state = { status: 'idle' });
  }),
};
vi.mock('../src/background/debugger-session', () => session);
vi.mock('../src/background/state', () => ({ reconcile: async () => state }));
const inject = vi.fn(async () => undefined);
vi.mock('../src/background/inject-picker', () => ({ injectPicker: inject }));

// The capture pipeline is stubbed here; tests/screenshot.test.ts covers it. One test below swaps in
// a real pipeline with fake Chrome dependencies.
const shot = vi.hoisted(() => ({
  captureForPick: vi.fn(async () => undefined),
  sharedCapturer: vi.fn(() => ({}) as never),
  real: false,
  deps: undefined as unknown,
}));
vi.mock('../src/background/screenshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/background/screenshot')>();
  return {
    ...original,
    captureForPick: (capturer: never, store: never) => (shot.real ? original.captureForPick(capturer, store) : shot.captureForPick()),
    sharedCapturer: () => (shot.real ? original.createCapturer(shot.deps as never) : shot.sharedCapturer()),
  };
});

const store = new Map<string, unknown>();
const EXT = 'ext';
const tabSender = { id: EXT, tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
const popupSender = { id: EXT } as chrome.runtime.MessageSender;

const picked = {
  type: 'ELEMENT_PICKED' as const,
  element: { selector: '#buy', outerHTML: '<b>x</b>', styles: { display: 'block' }, rect: { x: 0, y: 0, width: 1, height: 1 } },
  viewport: { width: 800, height: 600 },
  devicePixelRatio: 1,
  pageUrl: 'https://example.com/',
  pageTitle: 'T',
};

async function load() {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    runtime: { id: EXT },
    tabs: { get: async (id: number) => ({ id, url: 'https://example.com/' }) },
    storage: {
      session: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
        set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => store.set(k, structuredClone(v))),
        remove: async (keys: string[]) => void keys.forEach((k) => store.delete(k)),
      },
    },
  });
  return import('../src/background/router');
}

beforeEach(() => {
  shot.real = false;
  shot.captureForPick.mockClear();
  store.clear();
  state = { status: 'idle' };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('handleMessage with an element', () => {
  it('stores a pick and GET_STATE reports it with a summary', async () => {
    const { handleMessage } = await load();
    expect((await handleMessage({ type: 'GET_STATE' }, popupSender))).toMatchObject({ ok: true, hasElement: false });
    expect(await handleMessage(picked, tabSender)).toMatchObject({ ok: true, hasElement: true });
    const response = await handleMessage({ type: 'GET_STATE' }, popupSender);
    expect(response).toMatchObject({ ok: true, hasElement: true, element: { selector: '#buy', tabId: 7 } });
  });

  it('ignores a pick that does not come from a tab, and a bad payload', async () => {
    const { handleMessage } = await load();
    expect(await handleMessage(picked, popupSender)).toEqual({ ok: false, error: 'Pick ignored.' });
    expect(await handleMessage({ ...picked, devicePixelRatio: 'x' } as never, tabSender)).toEqual({ ok: false, error: 'Pick ignored.' });
    expect(store.size).toBe(0);
  });

  it('rejects a pick from another tab while recording, accepts the recorded tab (criterion 20)', async () => {
    const { handleMessage } = await load();
    state = { status: 'recording', tabId: 9, startedAt: 1 };
    expect(await handleMessage(picked, tabSender)).toEqual({ ok: false, error: 'Pick ignored.' });
    expect(store.size).toBe(0);
    state = { status: 'recording', tabId: 7, startedAt: 1 };
    expect(await handleMessage(picked, tabSender)).toMatchObject({ ok: true, hasElement: true });
  });

  it('PICKER_CANCELLED changes nothing', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    expect(await handleMessage({ type: 'PICKER_CANCELLED' }, tabSender)).toMatchObject({ ok: true, hasElement: true });
    expect(await handleMessage({ type: 'PICKER_CANCELLED' }, tabSender)).toMatchObject({ ok: true });
  });

  it('START_RECORDING keeps the element (Q1)', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    expect(await handleMessage({ type: 'START_RECORDING', tabId: 7 }, popupSender)).toMatchObject({ ok: true, hasElement: true });
    expect(store.has('elementSnapshot')).toBe(true);
  });

  it('CLEAR removes the element too (Q1)', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    expect(await handleMessage({ type: 'CLEAR' }, popupSender)).toMatchObject({ ok: true, hasElement: false });
    expect(store.has('elementSnapshot')).toBe(false);
  });

  it('CLEAR while recording fails and keeps the element', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    await handleMessage({ type: 'START_RECORDING', tabId: 7 }, popupSender);
    expect(await handleMessage({ type: 'CLEAR' }, popupSender)).toMatchObject({ ok: false });
    expect((await handleMessage({ type: 'GET_STATE' }, popupSender))).toMatchObject({ hasElement: true });
  });

  it('START_PICKER injects, and refuses another tab while recording (Q2)', async () => {
    const { handleMessage } = await load();
    expect(await handleMessage({ type: 'START_PICKER', tabId: 7 }, popupSender)).toMatchObject({ ok: true });
    expect(inject).toHaveBeenCalledWith(7);
    await handleMessage({ type: 'START_RECORDING', tabId: 7 }, popupSender);
    expect(await handleMessage({ type: 'START_PICKER', tabId: 8 }, popupSender)).toMatchObject({ ok: false, error: expect.stringContaining('Recording another tab') });
  });

  it('runs the capture after a stored pick, and not after an ignored one (criterion 13)', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, popupSender);
    expect(shot.captureForPick).not.toHaveBeenCalled();
    await handleMessage(picked, tabSender);
    expect(shot.captureForPick).toHaveBeenCalledTimes(1);
  });

  it('answers ok with a pending screenshot status while the capture is stubbed', async () => {
    const { handleMessage } = await load();
    const response = await handleMessage(picked, tabSender);
    expect(response).toMatchObject({ ok: true, hasElement: true, element: { screenshot: 'pending' } });
  });

  it('still answers ok when the capture rejects', async () => {
    const { handleMessage } = await load();
    shot.captureForPick.mockRejectedValueOnce(new Error('boom'));
    expect(await handleMessage(picked, tabSender)).toMatchObject({ ok: true, hasElement: true });
  });

  it('end to end with fake Chrome dependencies: pick, capture, store, report', async () => {
    shot.real = true;
    shot.deps = {
      getTab: async () => ({ active: true, windowId: 1, url: picked.pageUrl }),
      capture: async () => 'data:image/png;base64,RAW',
      decode: async () => ({ width: 1600, height: 1200, close: () => undefined }),
      encode: async () => 'data:image/png;base64,PNGBYTES',
      storageBytesInUse: async () => 0,
      storageQuota: () => 10_485_760,
      now: () => Date.now(),
      sleep: async () => undefined,
    };
    const { handleMessage } = await load();
    const response = await handleMessage(picked, tabSender);
    expect(response).toMatchObject({ ok: true, element: { screenshot: 'captured' } });
    expect((store.get('elementScreenshot') as { dataUrl: string }).dataUrl).toBe('data:image/png;base64,PNGBYTES');
    expect(await handleMessage({ type: 'CLEAR' }, popupSender)).toMatchObject({ ok: true, hasElement: false });
    expect(store.has('elementScreenshot')).toBe(false);
  });
});
