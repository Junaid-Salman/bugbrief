import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuffer, type SessionStorageLike } from '../src/background/buffer';
import { KEYS, insertConsole, insertNetwork } from '../src/core/buffer-model';
import type { RawConsoleEntry, RawNetworkEntry } from '../src/core/types';

const raw = (n: number): RawConsoleEntry => ({
  level: 'error',
  message: `Distinct ${n}`,
  timestamp: 1000 + n,
});

function fakeStorage() {
  const data = new Map<string, unknown>();
  const calls = { set: 0, remove: 0, get: 0 };
  let inFlight = 0;
  let maxConcurrent = 0;
  let failNext = 0;
  let failGet = false;
  const storage: SessionStorageLike = {
    async get(keys) {
      calls.get += 1;
      if (failGet) throw new Error('get failed');
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
    },
    async set(items) {
      calls.set += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async remove(keys) {
      calls.remove += 1;
      for (const key of keys) data.delete(key);
    },
  };
  return {
    storage,
    data,
    calls,
    maxConcurrent: () => maxConcurrent,
    failNext: (count: number) => {
      failNext = count;
    },
    failGet: (value: boolean) => {
      failGet = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createBuffer', () => {
  it('writes once after the debounce window', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    buffer.mutate((state) => insertConsole(state, raw(1)));
    await vi.advanceTimersByTimeAsync(249);
    expect(fake.calls.set).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.calls.set).toBe(1);
    expect((fake.data.get(KEYS.console) as unknown[]).length).toBe(1);
  });

  it('collapses a burst of mutations into one write', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    for (let i = 0; i < 20; i++) buffer.mutate((state) => insertConsole(state, raw(i)));
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.calls.set).toBe(1);
    expect((fake.data.get(KEYS.console) as unknown[]).length).toBe(20);
  });

  it('fires the max wait under a continuous flood', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    for (let t = 0; t < 12; t++) {
      buffer.mutate((state) => insertConsole(state, raw(t)));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fake.calls.set).toBeGreaterThanOrEqual(1);
  });

  it('flush writes immediately', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    buffer.mutate((state) => insertConsole(state, raw(1)));
    await buffer.flush();
    expect(fake.calls.set).toBe(1);
  });

  it('never runs two writes at once', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    for (let i = 0; i < 5; i++) {
      buffer.mutate((state) => insertConsole(state, raw(i)));
      void buffer.flush();
    }
    await buffer.flush();
    expect(fake.maxConcurrent()).toBe(1);
  });

  it('skips a write when nothing changed', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    buffer.mutate((state) => insertConsole(state, raw(1)));
    await buffer.flush();
    await buffer.flush();
    expect(fake.calls.set).toBe(1);
  });

  it('rehydrates stored state', async () => {
    const fake = fakeStorage();
    const first = createBuffer(fake.storage);
    first.mutate((state) => insertConsole(state, raw(1)));
    await first.flush();
    const second = createBuffer(fake.storage);
    const state = await second.rehydrate();
    expect(state.console).toHaveLength(1);
    second.mutate((s) => insertConsole(s, raw(1)));
    expect(second.getState().console[0]?.count).toBe(2);
  });

  it('rehydrates to empty on corrupt data', async () => {
    const fake = fakeStorage();
    fake.data.set(KEYS.console, 'garbage');
    fake.data.set(KEYS.network, [{ not: 'an entry' }]);
    const state = await createBuffer(fake.storage).rehydrate();
    expect(state.console).toEqual([]);
    expect(state.network).toEqual([]);
  });

  it('rehydrates to empty when storage throws, without rejecting', async () => {
    const fake = fakeStorage();
    fake.failGet(true);
    const state = await createBuffer(fake.storage).rehydrate();
    expect(state.console).toEqual([]);
  });

  it('reset cancels a pending write so it cannot resurrect cleared data', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    buffer.mutate((state) => insertConsole(state, raw(1)));
    await buffer.reset();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.calls.set).toBe(0);
    expect(fake.data.size).toBe(0);
    expect(buffer.getState().console).toEqual([]);
  });

  it('reset invalidates earlier generations', async () => {
    const buffer = createBuffer(fakeStorage().storage);
    const token = buffer.generation();
    expect(buffer.isCurrent(token)).toBe(true);
    await buffer.reset();
    expect(buffer.isCurrent(token)).toBe(false);
  });

  describe('write failures', () => {
    const bigNetwork = (): RawNetworkEntry => ({
      method: 'GET',
      url: 'http://x/api',
      status: 500,
      requestHeaders: {},
      responseBody: 'b'.repeat(10_000),
      timestamp: 1,
    });

    it('retries the same payload after one failure and leaves memory untouched', async () => {
      const fake = fakeStorage();
      const buffer = createBuffer(fake.storage);
      buffer.mutate((state) => insertNetwork(state, bigNetwork()));
      fake.failNext(1);
      await buffer.flush();
      expect(fake.calls.set).toBe(2);
      expect(buffer.persistenceOk()).toBe(true);
      expect(buffer.getState().network[0]?.responseBody).toHaveLength(10_000);
      expect((fake.data.get(KEYS.network) as Array<{ responseBody: string }>)[0]?.responseBody).toHaveLength(10_000);
    });

    it('trims memory only when the full payload fails twice and the trimmed one succeeds', async () => {
      const fake = fakeStorage();
      const buffer = createBuffer(fake.storage);
      buffer.mutate((state) => insertNetwork(state, bigNetwork()));
      fake.failNext(2);
      await buffer.flush();
      expect(fake.calls.set).toBe(3);
      expect(buffer.persistenceOk()).toBe(true);
      expect(buffer.getState().network[0]?.responseBody).toHaveLength(4_096);
      expect((fake.data.get(KEYS.network) as Array<{ responseBody: string }>)[0]?.responseBody).toHaveLength(4_096);
    });

    it('turns persistence off after three failures and leaves memory untouched', async () => {
      const fake = fakeStorage();
      const buffer = createBuffer(fake.storage);
      buffer.mutate((state) => insertNetwork(state, bigNetwork()));
      fake.failNext(3);
      await buffer.flush();
      expect(buffer.persistenceOk()).toBe(false);
      expect(buffer.getState().network[0]?.responseBody).toHaveLength(10_000);
    });

    it('recovers on the next successful write', async () => {
      const fake = fakeStorage();
      const buffer = createBuffer(fake.storage);
      buffer.mutate((state) => insertConsole(state, raw(1)));
      fake.failNext(3);
      await buffer.flush();
      expect(buffer.persistenceOk()).toBe(false);
      buffer.mutate((state) => insertConsole(state, raw(2)));
      await buffer.flush();
      expect(buffer.persistenceOk()).toBe(true);
    });
  });

  it('does not throw from timer callbacks when storage fails', async () => {
    const fake = fakeStorage();
    const buffer = createBuffer(fake.storage);
    fake.failNext(5);
    buffer.mutate((state) => insertConsole(state, raw(1)));
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  });
});
