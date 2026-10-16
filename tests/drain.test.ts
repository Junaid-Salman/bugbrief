import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, drain, withTimeout } from '../src/background/drain';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function track(set: Set<Promise<unknown>>, ms: number): Promise<void> {
  const task: Promise<void> = new Promise<void>((resolve) => setTimeout(resolve, ms)).finally(() => {
    set.delete(task);
  });
  set.add(task);
  return task;
}

describe('withTimeout', () => {
  it('resolves with the value when it finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(5), 100)).resolves.toBe(5);
  });
  it('rejects with TimeoutError when it takes too long', async () => {
    const pending = withTimeout(new Promise(() => undefined), 100);
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });
  it('passes through a rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });
});

describe('drain', () => {
  it('returns true immediately for an empty set', async () => {
    await expect(drain(new Set(), 2000)).resolves.toBe(true);
  });
  it('waits for in-flight tasks that finish before the deadline', async () => {
    const set = new Set<Promise<unknown>>();
    track(set, 500);
    const result = drain(set, 2000);
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toBe(true);
    expect(set.size).toBe(0);
  });
  it('also waits for tasks added while draining', async () => {
    const set = new Set<Promise<unknown>>();
    track(set, 300);
    const result = drain(set, 2000);
    await vi.advanceTimersByTimeAsync(100);
    track(set, 500);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(true);
    expect(set.size).toBe(0);
  });
  it('gives up at the deadline when a task hangs', async () => {
    const set = new Set<Promise<unknown>>();
    set.add(new Promise(() => undefined));
    const result = drain(set, 2000);
    await vi.advanceTimersByTimeAsync(2100);
    await expect(result).resolves.toBe(false);
  });
});
