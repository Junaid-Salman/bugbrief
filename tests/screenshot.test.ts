/** Step 4: the capture pipeline with fakes (criteria 4, 5, 6, 7, 14, 21, 22) and captureForPick. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickedPage } from '../src/core/element-model';
import { SCREENSHOT } from '../src/core/limits';
import { sanitizePick } from '../src/core/element-model';
import { createCapturer, safeMessage, type Bitmap, type CaptureDeps, type CaptureRequest, type TabInfo } from '../src/background/screenshot';

const URL_OK = 'https://example.com/page?token=SECRETVALUE';
const page: PickedPage = {
  url: URL_OK,
  title: 'Private title',
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 2,
};
const request = (patch: Partial<CaptureRequest> = {}): CaptureRequest => ({
  tabId: 7,
  rect: { x: 100, y: 200, width: 300, height: 100 },
  page,
  ...patch,
});

interface Rig {
  deps: CaptureDeps;
  clock: { t: number };
  sleeps: number[];
  captures: Array<{ at: number; windowId: number }>;
  encodes: Array<{ crop: unknown; width: number; height: number }>;
  closes: ReturnType<typeof vi.fn>;
  tab: { value: TabInfo | undefined | 'throw' };
  setBitmap(width: number, height: number): void;
  captureImpl: { fn: (windowId: number) => Promise<string> };
  encodeChars: { fn: (width: number, height: number) => number };
  storage: { inUse: number | 'throw'; quota: number };
  decodeError: { value?: Error };
  /** Runs inside every fake sleep, so a test can change the world while the pipeline waits. */
  onSleep: { fn?: (ms: number) => void };
  timers: Array<{ callback: () => void; ms: number; cancelled: boolean }>;
  /** Decode and encode calls that never settle, and a count of decode calls. */
  hang: { decode: boolean; encode: boolean };
  decodeCalls: { n: number };
}

function makeRig(): Rig {
  const clock = { t: 100_000 };
  const sleeps: number[] = [];
  const captures: Rig['captures'] = [];
  const encodes: Rig['encodes'] = [];
  const closes = vi.fn();
  let bitmap = { width: 2560, height: 1600 };
  const tab: Rig['tab'] = { value: { active: true, windowId: 3, url: URL_OK } };
  const captureImpl: Rig['captureImpl'] = {
    fn: async () => 'data:image/png;base64,RAW',
  };
  const encodeChars: Rig['encodeChars'] = { fn: () => 100 };
  const storage: Rig['storage'] = { inUse: 0, quota: 10_485_760 };
  const decodeError: Rig['decodeError'] = {};
  const onSleep: Rig['onSleep'] = {};
  const timers: Rig['timers'] = [];
  const hang: Rig['hang'] = { decode: false, encode: false };
  const decodeCalls: Rig['decodeCalls'] = { n: 0 };
  const deps: CaptureDeps = {
    async getTab() {
      if (tab.value === 'throw') throw new Error('tab gone');
      return tab.value;
    },
    async capture(windowId) {
      captures.push({ at: clock.t, windowId });
      return captureImpl.fn(windowId);
    },
    async decode() {
      decodeCalls.n += 1;
      if (hang.decode) return new Promise<Bitmap>(() => undefined);
      if (decodeError.value) throw decodeError.value;
      const b: Bitmap = { ...bitmap, close: closes };
      return b;
    },
    async encode(_bitmap, crop, width, height) {
      encodes.push({ crop, width, height });
      if (hang.encode) return new Promise<string>(() => undefined);
      return `data:image/png;base64,${'x'.repeat(encodeChars.fn(width, height))}`;
    },
    async storageBytesInUse() {
      if (storage.inUse === 'throw') throw new Error('no usage');
      return storage.inUse;
    },
    storageQuota: () => storage.quota,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      onSleep.fn?.(ms);
    },
    setTimer(callback, ms) {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    deps, clock, sleeps, captures, encodes, closes, tab, captureImpl, encodeChars, storage, decodeError,
    onSleep, timers, hang, decodeCalls,
    setBitmap: (width, height) => void (bitmap = { width, height }),
  };
}

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('geometry refusals (criterion 4)', () => {
  it.each([
    ['no-size', { x: 10, y: 10, width: 0, height: 50 }],
    ['no-size', { x: 10, y: 10, width: 50, height: 0.4 }],
    ['offscreen', { x: 1300, y: 10, width: 50, height: 50 }],
    ['offscreen', { x: 10, y: -80, width: 50, height: 50 }],
  ])('%s: no tab read and no capture', async (reason, rect) => {
    const result = await createCapturer(rig.deps).capture(request({ rect }));
    expect(result).toEqual({ ok: false, reason });
    expect(rig.captures).toEqual([]);
  });
});

describe('tab checks (criteria 5, 21)', () => {
  it('captures an active tab with the tab\'s current windowId', async () => {
    rig.tab.value = { active: true, windowId: 9, url: URL_OK };
    const result = await createCapturer(rig.deps).capture(request());
    expect(result.ok).toBe(true);
    expect(rig.captures).toEqual([{ at: 100_000, windowId: 9 }]);
  });

  it('never captures an inactive tab', async () => {
    rig.tab.value = { active: false, windowId: 3, url: URL_OK };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'tab-not-active' });
    expect(rig.captures).toEqual([]);
  });

  it.each([['undefined', undefined], ['a rejection', 'throw' as const]])('reports tab-not-active when the tab is gone (%s)', async (_label, value) => {
    rig.tab.value = value;
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'tab-not-active' });
    expect(rig.captures).toEqual([]);
  });

  it('maps a missing tab url to page-changed (Q4)', async () => {
    rig.tab.value = { active: true, windowId: 3 };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'page-changed' });
    expect(rig.captures).toEqual([]);
  });

  it('refuses when the url differs from the picked page', async () => {
    rig.tab.value = { active: true, windowId: 3, url: 'https://example.com/other' };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'page-changed' });
    expect(rig.captures).toEqual([]);
  });

  it('compares capped urls', async () => {
    const long = `https://example.com/${'a'.repeat(3000)}`;
    rig.tab.value = { active: true, windowId: 3, url: long };
    const result = await createCapturer(rig.deps).capture(request({ page: { ...page, url: long.slice(0, 2048) } }));
    expect(result.ok).toBe(true);
  });

  it('discards the image when the tab changed during the capture', async () => {
    let reads = 0;
    rig.deps.getTab = async () => (++reads === 1 ? { active: true, windowId: 3, url: URL_OK } : { active: false, windowId: 3, url: URL_OK });
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'tab-not-active' });
    expect(rig.captures).toHaveLength(1);
    expect(rig.encodes).toEqual([]);
    let navigated = 0;
    rig.deps.getTab = async () => ({ active: true, windowId: 3, url: ++navigated === 1 ? URL_OK : 'https://example.com/next' });
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'page-changed' });
  });
});

describe('tab check right before every call (P6.1, H1, criteria 25, 26)', () => {
  const quota = () => new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');

  it('(a) refuses when the tab goes inactive during the spacing wait of a second pick', async () => {
    const capturer = createCapturer(rig.deps);
    expect((await capturer.capture(request())).ok).toBe(true);
    rig.onSleep.fn = () => void (rig.tab.value = { active: false, windowId: 3, url: URL_OK });
    expect(await capturer.capture(request())).toEqual({ ok: false, reason: 'tab-not-active' });
    expect(rig.captures).toHaveLength(1);
  });

  it('(b) makes no further call when the tab goes inactive during a retry sleep', async () => {
    rig.captureImpl.fn = async () => {
      throw quota();
    };
    rig.onSleep.fn = (ms) => {
      if (ms === SCREENSHOT.retryDelayMs) rig.tab.value = { active: false, windowId: 3, url: URL_OK };
    };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'tab-not-active' });
    expect(rig.captures).toHaveLength(1);
  });

  it('(c) uses the new windowId when the tab moved window during a retry sleep', async () => {
    let calls = 0;
    rig.captureImpl.fn = async () => {
      if (++calls === 1) throw quota();
      return 'data:image/png;base64,RAW';
    };
    rig.onSleep.fn = (ms) => {
      if (ms === SCREENSHOT.retryDelayMs) rig.tab.value = { active: true, windowId: 9, url: URL_OK };
    };
    expect((await createCapturer(rig.deps).capture(request())).ok).toBe(true);
    expect(rig.captures.map((c) => c.windowId)).toEqual([3, 9]);
  });

  it('(d) refuses with page-changed when the url changes during the wait', async () => {
    const capturer = createCapturer(rig.deps);
    await capturer.capture(request());
    rig.onSleep.fn = () => void (rig.tab.value = { active: true, windowId: 3, url: 'https://example.com/next' });
    expect(await capturer.capture(request())).toEqual({ ok: false, reason: 'page-changed' });
    expect(rig.captures).toHaveLength(1);
  });

  it('(e) a refused check does not spend a rate-limit slot', async () => {
    const capturer = createCapturer(rig.deps);
    await capturer.capture(request());
    rig.onSleep.fn = () => void (rig.tab.value = { active: false, windowId: 3, url: URL_OK });
    await capturer.capture(request());
    rig.onSleep.fn = undefined;
    rig.tab.value = { active: true, windowId: 3, url: URL_OK };
    rig.sleeps.length = 0;
    expect((await capturer.capture(request())).ok).toBe(true);
    expect(rig.sleeps).toEqual([]);
  });
});

describe('timeout (P6.1, M2, criteria 28 to 31)', () => {
  const settle = () => vi.waitFor(() => expect(rig.timers.length).toBeGreaterThan(0));
  const never = () => new Promise<string>(() => undefined);

  it('times out a capture that never settles, from the start of the run', async () => {
    rig.captureImpl.fn = never;
    const pending = createCapturer(rig.deps).capture(request());
    await settle();
    expect(rig.timers[0]?.ms).toBe(SCREENSHOT.captureTimeoutMs);
    rig.timers[0]?.callback();
    expect(await pending).toEqual({ ok: false, reason: 'capture-failed' });
  });

  it('times out a decode that never settles', async () => {
    rig.hang.decode = true;
    const pending = createCapturer(rig.deps).capture(request());
    await vi.waitFor(() => expect(rig.decodeCalls.n).toBe(1));
    rig.timers[0]?.callback();
    expect(await pending).toEqual({ ok: false, reason: 'capture-failed' });
  });

  it('times out an encode that never settles', async () => {
    rig.hang.encode = true;
    const pending = createCapturer(rig.deps).capture(request());
    await vi.waitFor(() => expect(rig.encodes.length).toBe(1));
    rig.timers[0]?.callback();
    expect(await pending).toEqual({ ok: false, reason: 'capture-failed' });
  });

  it('cancels the timer when the request finishes in time', async () => {
    expect((await createCapturer(rig.deps).capture(request())).ok).toBe(true);
    expect(rig.timers).toHaveLength(1);
    expect(rig.timers[0]?.cancelled).toBe(true);
  });

  it('starts the timer when the run starts, not when the request is queued, and the queue survives a hang', async () => {
    let calls = 0;
    rig.captureImpl.fn = () => (++calls === 1 ? never() : Promise.resolve('data:image/png;base64,RAW'));
    const capturer = createCapturer(rig.deps);
    const first = capturer.capture(request());
    const second = capturer.capture(request());
    await settle();
    expect(rig.timers).toHaveLength(1);
    rig.timers[0]?.callback();
    expect(await first).toEqual({ ok: false, reason: 'capture-failed' });
    expect((await second).ok).toBe(true);
    expect(rig.timers).toHaveLength(2);
  });

  it('an abandoned run makes no retry, decode or encode call when its capture fails late', async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    rig.captureImpl.fn = () => new Promise<string>((_resolve, reject) => void (rejectLate = reject));
    const pending = createCapturer(rig.deps).capture(request());
    await settle();
    rig.timers[0]?.callback();
    await pending;
    rejectLate(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.captures).toHaveLength(1);
    expect(rig.decodeCalls.n).toBe(0);
    expect(rig.encodes).toEqual([]);
  });

  it('an abandoned run that gets an image late does not decode it', async () => {
    let resolveLate: (value: string) => void = () => undefined;
    rig.captureImpl.fn = () => new Promise<string>((resolve) => void (resolveLate = resolve));
    const pending = createCapturer(rig.deps).capture(request());
    await settle();
    rig.timers[0]?.callback();
    await pending;
    resolveLate('data:image/png;base64,RAW');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.decodeCalls.n).toBe(0);
  });

  it('logs the timeout without url, title or image data', async () => {
    rig.captureImpl.fn = never;
    const pending = createCapturer(rig.deps).capture(request());
    await settle();
    rig.timers[0]?.callback();
    await pending;
    const output = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map(String).join(' ');
    expect(output).toContain('timed out');
    for (const secret of ['SECRETVALUE', 'Private title', 'example.com']) expect(output).not.toContain(secret);
  });
});

describe('rate limit (criterion 6)', () => {
  it('spaces two captures at least 550 ms apart', async () => {
    const capturer = createCapturer(rig.deps);
    const [a, b] = await Promise.all([capturer.capture(request()), capturer.capture(request())]);
    expect(a.ok && b.ok).toBe(true);
    expect(rig.captures).toHaveLength(2);
    expect((rig.captures[1] as { at: number }).at - (rig.captures[0] as { at: number }).at).toBeGreaterThanOrEqual(SCREENSHOT.minGapMs);
  });

  it('does not wait when the previous call was long ago', async () => {
    const capturer = createCapturer(rig.deps);
    await capturer.capture(request());
    rig.clock.t += 5000;
    rig.sleeps.length = 0;
    await capturer.capture(request());
    expect(rig.sleeps).toEqual([]);
  });

  it('retries a quota error twice after 600 ms and then succeeds', async () => {
    let calls = 0;
    rig.captureImpl.fn = async () => {
      if (++calls <= 2) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
      return 'data:image/png;base64,RAW';
    };
    const result = await createCapturer(rig.deps).capture(request());
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(rig.sleeps.filter((ms) => ms === SCREENSHOT.retryDelayMs)).toHaveLength(2);
  });

  it('reports rate-limited when the quota error persists', async () => {
    rig.captureImpl.fn = async () => {
      throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'rate-limited' });
    expect(rig.captures).toHaveLength(1 + SCREENSHOT.maxRetries);
  });

  it('does not retry any other error', async () => {
    rig.captureImpl.fn = async () => {
      throw new Error('Failed to capture tab: image readback failed');
    };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'capture-failed' });
    expect(rig.captures).toHaveLength(1);
  });

  it('runs a queued pick after a failed one', async () => {
    const capturer = createCapturer(rig.deps);
    let calls = 0;
    rig.captureImpl.fn = async () => {
      if (++calls === 1) throw new Error('boom');
      return 'data:image/png;base64,RAW';
    };
    const first = capturer.capture(request());
    const second = capturer.capture(request());
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
  });
});

describe('crop and scale', () => {
  it('encodes the padded crop at the chosen scale and reports an unclipped element', async () => {
    const result = await createCapturer(rig.deps).capture(request());
    // rect 100,200 300x100 at scale 2, padding 16: sx = 168, sy = 368, ex = 832, ey = 632
    expect(rig.encodes[0]).toEqual({ crop: { sx: 168, sy: 368, sw: 664, sh: 264 }, width: 664, height: 264 });
    expect(result).toMatchObject({ ok: true, clipped: false, width: 664, height: 264 });
  });

  it('flags a clipped element', async () => {
    const result = await createCapturer(rig.deps).capture(request({ rect: { x: 1200, y: 700, width: 300, height: 300 } }));
    expect(result).toMatchObject({ ok: true, clipped: true });
  });

  it('uses clientWidth when the bitmap leaves out the scrollbar', async () => {
    rig.setBitmap(2530, 1600);
    await createCapturer(rig.deps).capture(request({ page: { ...page, clientWidth: 1265, clientHeight: 800 } }));
    const crop = rig.encodes[0]?.crop as { sx: number };
    expect(crop.sx).toBe(Math.floor((100 - 16) * (2530 / 1265)));
  });

  it('closes the bitmap on every path', async () => {
    await createCapturer(rig.deps).capture(request());
    expect(rig.closes).toHaveBeenCalledTimes(1);
    rig.encodeChars.fn = () => {
      throw new Error('encode boom');
    };
    await createCapturer(rig.deps).capture(request());
    expect(rig.closes).toHaveBeenCalledTimes(2);
  });
});

describe('errors map to capture-failed without throwing', () => {
  it('a decode failure', async () => {
    rig.decodeError.value = new Error('bad image');
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'capture-failed' });
    expect(rig.closes).not.toHaveBeenCalled();
  });
  it('an encode failure', async () => {
    rig.encodeChars.fn = () => {
      throw new Error('encode boom');
    };
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'capture-failed' });
  });
});

describe('size budget (criteria 7, 22)', () => {
  it('shrinks until the image fits', async () => {
    // 20 characters per pixel: 3.5M for the first attempt, then 1.97M, then 1.1M. The budget is 1.5M.
    rig.encodeChars.fn = (w, h) => w * h * 20;
    const result = await createCapturer(rig.deps).capture(request());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataUrl.length).toBeLessThanOrEqual(SCREENSHOT.maxDataUrl);
    expect(rig.encodes).toHaveLength(3);
  });

  it('reports too-large when nothing fits', async () => {
    rig.encodeChars.fn = () => SCREENSHOT.maxDataUrl + 1;
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'too-large' });
    expect(rig.encodes.length).toBeLessThanOrEqual(1 + SCREENSHOT.maxSteps);
  });

  it('uses the free storage space: a nearly full storage lowers the budget', async () => {
    rig.encodeChars.fn = () => 50_000;
    rig.storage.inUse = rig.storage.quota - SCREENSHOT.storageMargin - 10_000;
    expect(await createCapturer(rig.deps).capture(request())).toEqual({ ok: false, reason: 'too-large' });
  });

  it('an old image already counted in storage is not special: free space is quota - inUse - margin', async () => {
    rig.encodeChars.fn = () => 50_000;
    rig.storage.inUse = rig.storage.quota - SCREENSHOT.storageMargin - 60_000;
    expect((await createCapturer(rig.deps).capture(request())).ok).toBe(true);
  });

  it('a failing usage read falls back to the fixed cap', async () => {
    rig.storage.inUse = 'throw';
    rig.encodeChars.fn = () => 50_000;
    expect((await createCapturer(rig.deps).capture(request())).ok).toBe(true);
  });
});

describe('logging (criterion 14)', () => {
  it('scrubs urls and quoted text from error messages', () => {
    const text = safeMessage(new Error('Cannot access contents of url "https://example.com/page?token=SECRETVALUE". See https://x.test/a?b=SECRETVALUE'));
    expect(text).not.toContain('SECRETVALUE');
    expect(text).not.toContain('example.com');
    expect(safeMessage('x'.repeat(500)).length).toBe(120);
  });

  it('logs no url, title or image data on any path', async () => {
    rig.captureImpl.fn = async () => {
      throw new Error(`Cannot access contents of url "${URL_OK}"`);
    };
    await createCapturer(rig.deps).capture(request());
    const output = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map(String).join(' ');
    for (const secret of ['SECRETVALUE', 'Private title', 'example.com']) expect(output).not.toContain(secret);
  });
});

describe('captureForPick', () => {
  async function load() {
    vi.resetModules();
    const data = new Map<string, unknown>();
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
          set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
          remove: async (keys: string[]) => void keys.forEach((k) => data.delete(k)),
        },
      },
    });
    const { createElementStore } = await import('../src/background/element');
    const { captureForPick, createCapturer: make } = await import('../src/background/screenshot');
    const storage = chrome.storage.session as never;
    const store = createElementStore(storage, () => 100);
    const picked = sanitizePick({
      type: 'ELEMENT_PICKED',
      element: { selector: '#buy', outerHTML: '<b>x</b>', styles: {}, rect: { x: 100, y: 200, width: 300, height: 100 } },
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      pageUrl: URL_OK,
      pageTitle: 'T',
    });
    if (!picked) throw new Error('fixture rejected');
    await store.set(7, picked);
    return { store, captureForPick, make, data };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('stores the image on success', async () => {
    const { store, captureForPick, make } = await load();
    await captureForPick(make(rig.deps), store);
    await store.flush();
    expect(store.summary()?.screenshot).toBe('captured');
    expect(store.snapshot()?.screenshotDataUrl.startsWith('data:image/png')).toBe(true);
  });

  it('records the reason on a refusal', async () => {
    const { store, captureForPick, make } = await load();
    rig.tab.value = { active: false, windowId: 3, url: URL_OK };
    await captureForPick(make(rig.deps), store);
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'tab-not-active' });
  });

  it('records capture-failed when the capturer throws, and never throws itself', async () => {
    const { store, captureForPick } = await load();
    const broken = { capture: async () => { throw new Error('boom'); } };
    await expect(captureForPick(broken as never, store)).resolves.toBeUndefined();
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'capture-failed' });
  });

  it('records capture-failed for a hung capture and answers (criterion 29)', async () => {
    const { store, captureForPick, make } = await load();
    rig.captureImpl.fn = () => new Promise<string>(() => undefined);
    const done = captureForPick(make(rig.deps), store);
    await vi.waitFor(() => expect(rig.timers.length).toBe(1));
    rig.timers[0]?.callback();
    await expect(done).resolves.toBeUndefined();
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'capture-failed' });
  });

  it('drops a result for a pick that was replaced during the capture (criterion 8)', async () => {
    const { store, captureForPick, make } = await load();
    const first = store.get()?.pickedAt as number;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    rig.captureImpl.fn = async () => {
      await gate;
      return 'data:image/png;base64,RAW';
    };
    const pending = captureForPick(make(rig.deps), store);
    await store.set(7, sanitizePick({
      type: 'ELEMENT_PICKED',
      element: { selector: '#second', outerHTML: '<i>y</i>', styles: {}, rect: { x: 1, y: 1, width: 5, height: 5 } },
      viewport: { width: 1280, height: 800 }, devicePixelRatio: 2, pageUrl: URL_OK, pageTitle: 'T',
    }) as never);
    release();
    await pending;
    await store.flush();
    expect(store.get()?.pickedAt).toBeGreaterThan(first);
    expect(store.summary()?.screenshot).toBe('pending');
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
  });

  it('drops a result after Clear', async () => {
    const { store, captureForPick, make, data } = await load();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    rig.captureImpl.fn = async () => {
      await gate;
      return 'data:image/png;base64,RAW';
    };
    const pending = captureForPick(make(rig.deps), store);
    await store.clear();
    release();
    await pending;
    await store.flush();
    expect(store.get()).toBeUndefined();
    expect(data.size).toBe(0);
  });
});
