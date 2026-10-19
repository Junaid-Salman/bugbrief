import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizePick } from '../src/core/element-model';

function pick(selector = '#buy', extra: Record<string, unknown> = {}) {
  const picked = sanitizePick({
    type: 'ELEMENT_PICKED',
    element: { selector, outerHTML: '<b>x</b>', styles: { display: 'block' }, rect: { x: 1, y: 2, width: 3, height: 4 } },
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 1,
    pageUrl: 'https://example.com/',
    pageTitle: 'T',
    ...extra,
  });
  if (!picked) throw new Error('fixture rejected');
  return picked;
}

function fakeStorage(options: { failSet?: boolean; failKey?: string; gate?: Promise<void> } = {}) {
  const data = new Map<string, unknown>();
  const ops: string[] = [];
  return {
    data,
    ops,
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items: Record<string, unknown>) {
      if (options.gate) await options.gate;
      if (options.failSet) throw new Error('QUOTA_BYTES quota exceeded');
      if (options.failKey && options.failKey in items) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [k, v] of Object.entries(items)) {
        ops.push(`set:${k}`);
        data.set(k, structuredClone(v));
      }
    },
    async remove(keys: string[]) {
      if (options.gate) await options.gate;
      for (const k of keys) {
        ops.push(`remove:${k}`);
        data.delete(k);
      }
    },
  };
}

async function load() {
  vi.resetModules();
  vi.stubGlobal('chrome', { storage: { session: fakeStorage() } });
  return import('../src/background/element');
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createElementStore', () => {
  it('stores one snapshot under one key with an empty screenshot placeholder', async () => {
    const { createElementStore, ELEMENT_KEY } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 1234);
    await store.set(7, pick());
    const stored = storage.data.get(ELEMENT_KEY) as { version: number; tabId: number; pickedAt: number; snapshot: { screenshotDataUrl: string } };
    expect(stored.version).toBe(1);
    expect(stored.tabId).toBe(7);
    expect(stored.pickedAt).toBe(1234);
    expect(stored.snapshot.screenshotDataUrl).toBe('');
    expect([...storage.data.keys()]).toEqual([ELEMENT_KEY]);
  });

  it('replaces an earlier snapshot (D4)', async () => {
    const { createElementStore } = await load();
    const store = createElementStore(fakeStorage());
    await store.set(1, pick('#one'));
    await store.set(2, pick('#two'));
    expect(store.get()?.snapshot.selector).toBe('#two');
    expect(store.get()?.tabId).toBe(2);
  });

  it('survives a simulated worker restart', async () => {
    const { createElementStore } = await load();
    const storage = fakeStorage();
    await createElementStore(storage).set(5, pick('#kept'));
    const restarted = createElementStore(storage);
    expect(restarted.get()).toBeUndefined();
    await restarted.rehydrate();
    expect(restarted.get()?.snapshot.selector).toBe('#kept');
    expect(restarted.summary()?.tabId).toBe(5);
  });

  it('ignores a stored value with the wrong shape', async () => {
    const { createElementStore, ELEMENT_KEY } = await load();
    const storage = fakeStorage();
    storage.data.set(ELEMENT_KEY, { version: 2, junk: true });
    const store = createElementStore(storage);
    expect(await store.rehydrate()).toBeUndefined();
  });

  it('clear removes memory and storage', async () => {
    const { createElementStore } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage);
    await store.set(1, pick());
    await store.clear();
    expect(store.get()).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it('a late write cannot resurrect a cleared snapshot', async () => {
    const { createElementStore } = await load();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const storage = fakeStorage({ gate });
    const store = createElementStore(storage);
    void store.set(1, pick());
    const cleared = store.clear();
    release();
    await cleared;
    await store.flush();
    expect(store.get()).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it('keeps the snapshot in memory when the write fails, and does not throw', async () => {
    const { createElementStore } = await load();
    const store = createElementStore(fakeStorage({ failSet: true }));
    await expect(store.set(1, pick())).resolves.toBeUndefined();
    expect(store.get()?.snapshot.selector).toBe('#buy');
  });
});

describe('summarize', () => {
  it('masks [value=…] and shortens to 60 characters', async () => {
    const { createElementStore } = await load();
    const store = createElementStore(fakeStorage());
    await store.set(1, pick('input[value="hunter2"]'));
    expect(store.summary()?.selector).toBe('input[value="[REDACTED]"]');
    await store.set(1, pick(`div.${'a'.repeat(100)}`));
    const shown = store.summary()?.selector ?? '';
    expect(shown.length).toBe(60);
    expect(shown.endsWith('…')).toBe(true);
  });
});

const SHOT = { dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 8, clipped: false };

describe('screenshot storage (criteria 8, 9, 18, 19, 20)', () => {
  it('stores the image under its own key, then the status', async () => {
    const { createElementStore, ELEMENT_KEY, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 100);
    await store.set(7, pick());
    expect(store.get()?.screenshot).toEqual({ status: 'pending' });
    const pickedAt = store.get()?.pickedAt as number;
    expect(store.setScreenshot(pickedAt, SHOT)).toBe(true);
    await store.flush();
    expect(storage.data.get(SCREENSHOT_KEY)).toEqual({ version: 1, pickedAt, dataUrl: SHOT.dataUrl, width: 10, height: 8 });
    expect((storage.data.get(ELEMENT_KEY) as { screenshot: { status: string } }).screenshot.status).toBe('captured');
    // The image is written before the status.
    expect(storage.ops.indexOf(`set:${SCREENSHOT_KEY}`)).toBeLessThan(storage.ops.lastIndexOf(`set:${ELEMENT_KEY}`));
    expect(store.summary()?.screenshot).toBe('captured');
  });

  it('snapshot() fills the data URL and the clipped flag for P7', async () => {
    const { createElementStore } = await load();
    const store = createElementStore(fakeStorage(), () => 100);
    expect(store.snapshot()).toBeUndefined();
    await store.set(7, pick());
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
    store.setScreenshot(store.get()?.pickedAt as number, { ...SHOT, clipped: true });
    await store.flush();
    const snapshot = store.snapshot();
    expect(snapshot?.screenshotDataUrl).toBe(SHOT.dataUrl);
    expect(snapshot?.screenshotClipped).toBe(true);
    expect(snapshot?.screenshotUnavailable).toBeUndefined();
    expect(store.summary()?.screenshot).toBe('clipped');
  });

  it('records an unavailable reason with no image and no clipped flag', async () => {
    const { createElementStore, ELEMENT_KEY, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage);
    await store.set(7, pick());
    expect(store.markUnavailable(store.get()?.pickedAt as number, 'tab-not-active')).toBe(true);
    await store.flush();
    const snapshot = store.snapshot();
    expect(snapshot?.screenshotDataUrl).toBe('');
    expect(snapshot?.screenshotUnavailable).toBe('tab-not-active');
    expect(snapshot?.screenshotClipped).toBeUndefined();
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'tab-not-active' });
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(false);
    expect((storage.data.get(ELEMENT_KEY) as { screenshot: { reason: string } }).screenshot.reason).toBe('tab-not-active');
  });

  it('drops a result for a pick that is no longer current (criterion 8)', async () => {
    const { createElementStore, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 100);
    await store.set(1, pick('#one'));
    const first = store.get()?.pickedAt as number;
    await store.set(2, pick('#two'));
    expect(store.setScreenshot(first, SHOT)).toBe(false);
    expect(store.markUnavailable(first, 'capture-failed')).toBe(false);
    await store.clear();
    const second = first + 1;
    expect(store.setScreenshot(second, SHOT)).toBe(false);
    await store.flush();
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(false);
  });

  it('a Clear during a slow image write leaves nothing behind', async () => {
    const { createElementStore } = await load();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const storage = fakeStorage({ gate });
    const store = createElementStore(storage, () => 100);
    void store.set(1, pick());
    store.setScreenshot(store.get()?.pickedAt as number, SHOT);
    const cleared = store.clear();
    release();
    await cleared;
    await store.flush();
    expect(storage.data.size).toBe(0);
    expect(store.get()).toBeUndefined();
  });

  it('a new pick removes the old image before the new element is written (criterion 18)', async () => {
    const { createElementStore, ELEMENT_KEY, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 100);
    await store.set(1, pick('#one'));
    store.setScreenshot(store.get()?.pickedAt as number, SHOT);
    await store.flush();
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(true);
    storage.ops.length = 0;
    await store.set(2, pick('#two'));
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(false);
    expect(storage.ops).toEqual([`remove:${SCREENSHOT_KEY}`, `set:${ELEMENT_KEY}`]);
    // Pick 2's capture is refused: still no image, and the snapshot has none.
    store.markUnavailable(store.get()?.pickedAt as number, 'page-changed');
    await store.flush();
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(false);
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
  });

  it('still stores the new element when the old image cannot be removed', async () => {
    const { createElementStore } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 100);
    storage.remove = async () => {
      throw new Error('boom');
    };
    await store.set(1, pick('#kept'));
    expect(storage.data.get('elementSnapshot')).toBeDefined();
  });

  it('a failed image write keeps the element and reports capture-failed', async () => {
    const { createElementStore, ELEMENT_KEY, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage({ failKey: 'elementScreenshot' });
    const store = createElementStore(storage, () => 100);
    await store.set(7, pick());
    store.setScreenshot(store.get()?.pickedAt as number, SHOT);
    await store.flush();
    expect(storage.data.has(SCREENSHOT_KEY)).toBe(false);
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'capture-failed' });
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
    expect((storage.data.get(ELEMENT_KEY) as { snapshot: { selector: string }; screenshot: { reason: string } }).snapshot.selector).toBe('#buy');
    expect((storage.data.get(ELEMENT_KEY) as { screenshot: { reason: string } }).screenshot.reason).toBe('capture-failed');
  });

  it('Clear removes both keys', async () => {
    const { createElementStore } = await load();
    const storage = fakeStorage();
    const store = createElementStore(storage, () => 100);
    await store.set(7, pick());
    store.setScreenshot(store.get()?.pickedAt as number, SHOT);
    await store.clear();
    expect(storage.data.size).toBe(0);
  });

  it('uses a strictly increasing pickedAt (criterion 20)', async () => {
    const { createElementStore } = await load();
    const store = createElementStore(fakeStorage(), () => 500);
    await store.set(1, pick());
    const first = store.get()?.pickedAt as number;
    await store.set(1, pick());
    const second = store.get()?.pickedAt as number;
    expect(first).toBe(500);
    expect(second).toBe(501);
    const earlier = createElementStore(fakeStorage(), () => 10);
    await earlier.set(1, pick());
    await earlier.set(1, pick());
    expect(earlier.get()?.pickedAt).toBe(11);
  });
});

describe('rehydrate with a screenshot (criterion 19)', () => {
  async function stored(patch: { status?: unknown; image?: unknown; pickedAt?: number; omitScreenshot?: boolean }) {
    const { createElementStore, ELEMENT_KEY, SCREENSHOT_KEY } = await load();
    const storage = fakeStorage();
    const seed = createElementStore(storage, () => 100);
    await seed.set(7, pick());
    const element = storage.data.get(ELEMENT_KEY) as Record<string, unknown>;
    if (patch.omitScreenshot) delete element.screenshot;
    else element.screenshot = patch.status ?? { status: 'captured' };
    if (patch.image !== undefined) storage.data.set(SCREENSHOT_KEY, patch.image);
    const store = createElementStore(storage, () => 100);
    await store.rehydrate();
    await store.flush();
    return { store, storage, ELEMENT_KEY };
  }
  const image = (pickedAt: number) => ({ version: 1, pickedAt, dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1 });

  it('keeps a matching image', async () => {
    const { store } = await stored({ image: image(100) });
    expect(store.summary()?.screenshot).toBe('captured');
    expect(store.snapshot()?.screenshotDataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('turns a captured status with a mismatched image into interrupted', async () => {
    const { store, storage, ELEMENT_KEY } = await stored({ image: image(99) });
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'interrupted' });
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
    expect((storage.data.get(ELEMENT_KEY) as { screenshot: { reason: string } }).screenshot.reason).toBe('interrupted');
  });

  it('turns a captured status with no image into interrupted', async () => {
    const { store } = await stored({});
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'interrupted' });
  });

  it('turns pending into interrupted even when an image is present', async () => {
    const { store } = await stored({ status: { status: 'pending' }, image: image(100) });
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'interrupted' });
    expect(store.snapshot()?.screenshotDataUrl).toBe('');
  });

  it('ignores a malformed image', async () => {
    const { store } = await stored({ image: { version: 1, pickedAt: 100, dataUrl: 'javascript:alert(1)', width: 1, height: 1 } });
    expect(store.summary()?.reason).toBe('interrupted');
  });

  it('keeps an unavailable reason and drops an unknown one', async () => {
    const good = await stored({ status: { status: 'unavailable', reason: 'too-large' } });
    expect(good.store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'too-large' });
    const bad = await stored({ status: { status: 'unavailable', reason: 'Error: secret page text' } });
    expect(bad.store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'interrupted' });
  });

  it('treats an element stored before P6 (no screenshot field) as interrupted', async () => {
    const { store } = await stored({ omitScreenshot: true });
    expect(store.summary()).toMatchObject({ screenshot: 'unavailable', reason: 'interrupted' });
  });

  it('rejects a stored element with a malformed page', async () => {
    const { createElementStore, ELEMENT_KEY } = await load();
    const storage = fakeStorage();
    storage.data.set(ELEMENT_KEY, { version: 1, tabId: 1, pickedAt: 1, page: {}, snapshot: { selector: '#x' } });
    const store = createElementStore(storage);
    expect(await store.rehydrate()).toBeUndefined();
  });
});
