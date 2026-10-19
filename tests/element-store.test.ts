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

function fakeStorage(options: { failSet?: boolean; gate?: Promise<void> } = {}) {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items: Record<string, unknown>) {
      if (options.gate) await options.gate;
      if (options.failSet) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string[]) {
      if (options.gate) await options.gate;
      for (const k of keys) data.delete(k);
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
