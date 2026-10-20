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
  getBufferState: vi.fn(() => ({ console: [], network: [], pending: [], nextSeq: 1, evicted: { console: { entries: 0, occurrences: 0 }, network: { entries: 0, occurrences: 0 } } })),
  clearBuffers: vi.fn(async () => {
    if (state.status === 'recording') throw new Error('Stop recording before clearing.');
    return (state = { status: 'idle' });
  }),
};
vi.mock('../src/background/debugger-session', () => session);
const reconcile = vi.fn(async () => state);
vi.mock('../src/background/state', () => ({ reconcile }));
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
      setTimer: () => () => undefined,
    };
    const { handleMessage } = await load();
    const response = await handleMessage(picked, tabSender);
    expect(response).toMatchObject({ ok: true, element: { screenshot: 'captured' } });
    expect((store.get('elementScreenshot') as { dataUrl: string }).dataUrl).toBe('data:image/png;base64,PNGBYTES');
    expect(await handleMessage({ type: 'CLEAR' }, popupSender)).toMatchObject({ ok: true, hasElement: false });
    expect(store.has('elementScreenshot')).toBe(false);
  });

  it('BUILD_CAPSULE refuses while recording and when there is nothing to report', async () => {
    const { handleMessage } = await load();
    expect(await handleMessage({ type: 'BUILD_CAPSULE', userNote: '' }, popupSender)).toEqual({ ok: false, error: 'Nothing to report yet.' });
    await handleMessage({ type: 'START_RECORDING', tabId: 7 }, popupSender);
    expect(await handleMessage({ type: 'BUILD_CAPSULE', userNote: '' }, popupSender)).toEqual({ ok: false, error: 'Stop recording first.' });
    expect(await handleMessage({ type: 'DOWNLOAD_CAPSULE', userNote: '', capturedAt: '2026-10-20T10:15:30.120Z', previewHash: 'x' }, popupSender)).toEqual({ ok: false, error: 'Stop recording first.' });
  });

  it('refuses BUILD_CAPSULE and DOWNLOAD_CAPSULE from a content script or another extension (P7.1)', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    const build = { type: 'BUILD_CAPSULE' as const, userNote: '' };
    const download = { type: 'DOWNLOAD_CAPSULE' as const, userNote: '', capturedAt: '2026-10-20T10:15:30.120Z', previewHash: 'x' };
    const foreign = { id: 'other', tab: undefined } as chrome.runtime.MessageSender;
    const foreignTab = { id: 'other', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
    for (const sender of [tabSender, foreign, foreignTab, {} as chrome.runtime.MessageSender]) {
      expect(await handleMessage(build, sender)).toEqual({ ok: false, error: 'Not allowed.' });
      expect(await handleMessage(download, sender)).toEqual({ ok: false, error: 'Not allowed.' });
    }
    expect(await handleMessage(build, popupSender)).toMatchObject({ ok: true });
  });

  it('BUILD_CAPSULE builds from a picked element through the real flow', async () => {
    const { handleMessage } = await load();
    await handleMessage(picked, tabSender);
    const response = await handleMessage({ type: 'BUILD_CAPSULE', userNote: 'note' }, popupSender);
    expect(response).toMatchObject({ ok: true, hasElement: true, screenshot: 'pending' });
    expect(response.ok && response.markdown).toContain('## Selected element');
    expect(response.ok && response.markdown).toContain('still being captured');
  });
});


describe('sender guards on every popup message and the picker messages (BL-030)', () => {
  const foreign = { id: 'other', tab: undefined } as chrome.runtime.MessageSender;
  const foreignTab = { id: 'other', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
  const noSender = {} as chrome.runtime.MessageSender;
  const popupMessages = [
    { type: 'START_RECORDING' as const, tabId: 7 },
    { type: 'STOP_RECORDING' as const },
    { type: 'GET_STATE' as const },
    { type: 'CLEAR' as const },
    { type: 'START_PICKER' as const, tabId: 7 },
  ];

  beforeEach(() => {
    for (const fn of [session.startRecording, session.stopRecording, session.clearBuffers, session.getCounts, reconcile, inject]) fn.mockClear();
  });

  it.each(popupMessages)('refuses $type from a content script, another extension and no sender, and touches nothing', async (message) => {
    const { handleMessage } = await load();
    for (const sender of [tabSender, foreign, foreignTab, noSender]) {
      expect(await handleMessage(message, sender)).toEqual({ ok: false, error: 'Not allowed.' });
    }
    for (const fn of [session.startRecording, session.stopRecording, session.clearBuffers, session.getCounts, reconcile, inject]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('still serves the popup', async () => {
    const { handleMessage } = await load();
    expect(await handleMessage({ type: 'GET_STATE' }, popupSender)).toMatchObject({ ok: true });
    expect(await handleMessage({ type: 'START_RECORDING', tabId: 7 }, popupSender)).toMatchObject({ ok: true });
    expect(session.startRecording).toHaveBeenCalledTimes(1);
  });

  it('refuses PICKER_CANCELLED from the popup and from foreign senders, and accepts it from our picker', async () => {
    const { handleMessage } = await load();
    for (const sender of [popupSender, foreign, foreignTab, noSender]) {
      expect(await handleMessage({ type: 'PICKER_CANCELLED' }, sender)).toEqual({ ok: false, error: 'Not allowed.' });
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(await handleMessage({ type: 'PICKER_CANCELLED' }, tabSender)).toMatchObject({ ok: true });
  });
});
