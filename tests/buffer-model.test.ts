import { describe, expect, it } from 'vitest';
import {
  KEYS,
  countsOf,
  emptyState,
  getPending,
  insertConsole,
  insertNetwork,
  markedPending,
  rehydrateState,
  serialize,
  setPending,
  shrinkOne,
  takePending,
  trimBodies,
} from '../src/core/buffer-model';
import {
  CONSOLE_CAP,
  FIELD,
  NETWORK_CAP,
  PENDING_CAP,
  ROOT_CAUSE_WINDOW,
  SOFT_LIMIT_BYTES,
  capText,
  fitsSoftLimit,
  utf8Bytes,
} from '../src/core/limits';
import type { PendingRequest, RawConsoleEntry, RawNetworkEntry } from '../src/core/types';

const consoleRaw = (n: number, overrides: Partial<RawConsoleEntry> = {}): RawConsoleEntry => ({
  level: 'error',
  message: `Distinct ${n}`,
  stack: '    at boom (http://x/main.js:1:1)',
  url: 'http://x/main.js',
  timestamp: 1000 + n,
  ...overrides,
});

const networkRaw = (n: number, overrides: Partial<RawNetworkEntry> = {}): RawNetworkEntry => ({
  method: 'GET',
  url: `http://x/api/missing/item-${n}`,
  status: 404,
  requestHeaders: {},
  timestamp: 1000 + n,
  ...overrides,
});

const pendingReq = (id: string, overrides: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId: id,
  method: 'GET',
  url: `http://x/${id}`,
  headers: {},
  hasPostData: false,
  wallTimeMs: 1,
  monotonicSeconds: 1,
  ...overrides,
});

describe('capText', () => {
  it('returns short text unchanged', () => {
    expect(capText('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('cuts long text and flags it', () => {
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
  it('never ends in a lone surrogate', () => {
    const result = capText('a😀b', 2);
    expect(result.text).toBe('a');
    expect(result.truncated).toBe(true);
  });
});

describe('insert and merge', () => {
  it('merges the same error and counts occurrences', () => {
    const state = emptyState();
    for (let i = 0; i < 50; i++) insertConsole(state, consoleRaw(1, { timestamp: 1000 + i }));
    expect(state.console).toHaveLength(1);
    expect(state.console[0]?.count).toBe(50);
  });
  it('keeps distinct errors separate', () => {
    const state = emptyState();
    insertConsole(state, consoleRaw(1));
    insertConsole(state, consoleRaw(2));
    expect(state.console).toHaveLength(2);
  });
  it('caps stored fields and flags truncated bodies', () => {
    const state = emptyState();
    insertNetwork(
      state,
      networkRaw(1, { status: 500, responseBody: 'x'.repeat(100_000), requestBody: 'y'.repeat(50_000) }),
    );
    const entry = state.network[0];
    expect(entry?.responseBody).toHaveLength(FIELD.responseBody);
    expect(entry?.requestBody).toHaveLength(FIELD.requestBody);
    expect(entry?.responseBodyTruncated).toBe(true);
    expect(entry?.requestBodyTruncated).toBe(true);
  });
  it('does not flag bodies under the cap', () => {
    const state = emptyState();
    insertNetwork(state, networkRaw(1, { status: 500, responseBody: '{"error":"x"}' }));
    expect(state.network[0]?.responseBodyTruncated).toBeUndefined();
  });
  it('caps console messages and header sets', () => {
    const state = emptyState();
    insertConsole(state, consoleRaw(1, { message: 'm'.repeat(20_000), stack: 's'.repeat(20_000) }));
    expect(state.console[0]?.message).toHaveLength(FIELD.consoleMessage);
    expect(state.console[0]?.stack).toHaveLength(FIELD.consoleStack);
    const headers: Record<string, string> = {};
    for (let i = 0; i < 100; i++) headers[`header-${i}`.padEnd(100, 'n')] = 'v'.repeat(1000);
    insertNetwork(state, networkRaw(2, { requestHeaders: headers }));
    const stored = state.network[0]?.requestHeaders ?? {};
    expect(Object.keys(stored)).toHaveLength(FIELD.maxHeaders);
    expect(Object.values(stored)[0]).toHaveLength(FIELD.headerValue);
  });
});

describe('eviction', () => {
  it('holds the console buffer at its cap with unique entries', () => {
    const state = emptyState();
    for (let i = 0; i < 250; i++) insertConsole(state, consoleRaw(i));
    expect(state.console).toHaveLength(CONSOLE_CAP);
    expect(state.evicted.console.entries).toBe(50);
    expect(state.evicted.console.occurrences).toBe(50);
  });
  it('keeps the earliest entries (root-cause window)', () => {
    const state = emptyState();
    for (let i = 0; i < 250; i++) insertConsole(state, consoleRaw(i));
    const messages = new Set(state.console.map((entry) => entry.message));
    for (let i = 0; i < ROOT_CAUSE_WINDOW; i++) expect(messages.has(`Distinct ${i}`)).toBe(true);
    expect(messages.has('Distinct 20')).toBe(false);
    expect(messages.has('Distinct 249')).toBe(true);
  });
  it('evicts the least recently touched entry, not the oldest first seen', () => {
    const state = emptyState();
    for (let i = 0; i < CONSOLE_CAP; i++) insertConsole(state, consoleRaw(i));
    insertConsole(state, consoleRaw(ROOT_CAUSE_WINDOW)); // touch an unprotected old entry
    insertConsole(state, consoleRaw(999));
    const messages = new Set(state.console.map((entry) => entry.message));
    expect(messages.has(`Distinct ${ROOT_CAUSE_WINDOW}`)).toBe(true);
    expect(messages.has(`Distinct ${ROOT_CAUSE_WINDOW + 1}`)).toBe(false);
  });
  it('holds the network buffer at its cap', () => {
    const state = emptyState();
    for (let i = 0; i < 60; i++) insertNetwork(state, networkRaw(i));
    expect(state.network).toHaveLength(NETWORK_CAP);
    expect(state.evicted.network.entries).toBe(10);
  });
  it('never evicts a new network entry whose request started before everything else', () => {
    const state = emptyState();
    for (let i = 0; i < NETWORK_CAP; i++) insertNetwork(state, networkRaw(i, { timestamp: 5000 + i }));
    insertNetwork(state, networkRaw(900, { timestamp: 1 }));
    expect(state.network.some((entry) => entry.url.endsWith('item-900'))).toBe(true);
    expect(state.network).toHaveLength(NETWORK_CAP);
  });
  it('counts evicted occurrences of merged entries', () => {
    const state = emptyState();
    for (let i = 0; i < CONSOLE_CAP; i++) insertConsole(state, consoleRaw(i));
    for (let r = 0; r < 3; r++) insertConsole(state, consoleRaw(ROOT_CAUSE_WINDOW + 1)); // 4 occurrences, old touch
    insertConsole(state, consoleRaw(ROOT_CAUSE_WINDOW)); // touch so it survives
    insertConsole(state, consoleRaw(777));
    // the least recently touched unprotected entry is 22; it has 1 occurrence
    expect(state.evicted.console.entries).toBe(1);
    expect(state.evicted.console.occurrences).toBeGreaterThanOrEqual(1);
  });
  it('is deterministic for ties on touched', () => {
    const a = emptyState();
    const b = emptyState();
    for (const state of [a, b]) for (let i = 0; i < 230; i++) insertConsole(state, consoleRaw(i));
    expect(a.console.map((entry) => entry.message)).toEqual(b.console.map((entry) => entry.message));
  });
});

describe('pending requests', () => {
  it('stores, finds and takes records', () => {
    const state = emptyState();
    setPending(state, pendingReq('a'));
    expect(getPending(state, 'a')?.url).toBe('http://x/a');
    expect(takePending(state, 'a')?.requestId).toBe('a');
    expect(getPending(state, 'a')).toBeUndefined();
  });
  it('replaces a record with the same id (redirects)', () => {
    const state = emptyState();
    setPending(state, pendingReq('a'));
    setPending(state, pendingReq('a', { url: 'http://x/redirected' }));
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.url).toBe('http://x/redirected');
  });
  it('caps the map and drops unmarked records first', () => {
    const state = emptyState();
    setPending(state, pendingReq('keep', { marked: true }));
    for (let i = 0; i < PENDING_CAP + 20; i++) setPending(state, pendingReq(`r${i}`));
    expect(state.pending.length).toBe(PENDING_CAP);
    expect(getPending(state, 'keep')).toBeDefined();
  });
  it('caps post data and flags it', () => {
    const state = emptyState();
    setPending(state, pendingReq('a', { postData: 'p'.repeat(20_000) }));
    expect(state.pending[0]?.postData).toHaveLength(FIELD.requestBody);
    expect(state.pending[0]?.postDataTruncated).toBe(true);
  });
  it('lists only marked records', () => {
    const state = emptyState();
    setPending(state, pendingReq('a'));
    setPending(state, pendingReq('b', { marked: true }));
    expect(markedPending(state).map((record) => record.requestId)).toEqual(['b']);
  });
});

describe('counts', () => {
  it('reports unique, total and evicted', () => {
    const state = emptyState();
    for (let i = 0; i < 5; i++) insertConsole(state, consoleRaw(1));
    insertConsole(state, consoleRaw(2));
    insertNetwork(state, networkRaw(1));
    const counts = countsOf(state);
    expect(counts.console).toEqual({ unique: 2, total: 6, evicted: { entries: 0, occurrences: 0 } });
    expect(counts.network.unique).toBe(1);
  });
});

describe('size guard', () => {
  const heavy = (n: number): RawNetworkEntry =>
    networkRaw(n, {
      status: 500,
      responseBody: ('"\\' + '日本').repeat(FIELD.responseBody),
      requestBody: ('"\\' + '日本').repeat(FIELD.requestBody),
      errorText: '"'.repeat(1000),
    });

  it('trimBodies cuts bodies and flags them', () => {
    const state = emptyState();
    insertNetwork(state, heavy(1));
    trimBodies(state, 100);
    expect(state.network[0]?.responseBody).toHaveLength(100);
    expect(state.network[0]?.responseBodyTruncated).toBe(true);
  });
  const fillWorstCase = () => {
    const state = emptyState();
    for (let i = 0; i < NETWORK_CAP; i++) insertNetwork(state, heavy(i));
    for (let i = 0; i < CONSOLE_CAP; i++) {
      insertConsole(
        state,
        consoleRaw(i, {
          message: `${i} ` + '"\\日'.repeat(FIELD.consoleMessage),
          stack: '"\\日'.repeat(FIELD.consoleStack),
        }),
      );
    }
    return state;
  };

  it('an ASCII worst case at the field caps fits under the soft limit', () => {
    const state = emptyState();
    for (let i = 0; i < NETWORK_CAP; i++) {
      insertNetwork(state, networkRaw(i, { status: 500, responseBody: 'x'.repeat(100_000), requestBody: 'y'.repeat(50_000) }));
    }
    for (let i = 0; i < CONSOLE_CAP; i++) {
      insertConsole(state, consoleRaw(i, { message: `${i} ` + 'm'.repeat(10_000), stack: 's'.repeat(10_000) }));
    }
    expect(utf8Bytes(JSON.stringify(serialize(state, false)))).toBeLessThanOrEqual(SOFT_LIMIT_BYTES);
  });

  it('an escape-heavy multibyte worst case exceeds the limit, and the degrade ladder brings it back under', () => {
    const state = fillWorstCase();
    expect(state.network).toHaveLength(NETWORK_CAP);
    expect(state.console).toHaveLength(CONSOLE_CAP);
    expect(utf8Bytes(JSON.stringify(serialize(state, false)))).toBeGreaterThan(SOFT_LIMIT_BYTES);
    trimBodies(state);
    let payload = serialize(state, false);
    while (!fitsSoftLimit(JSON.stringify(payload)) && shrinkOne(state)) payload = serialize(state, false);
    expect(utf8Bytes(JSON.stringify(payload))).toBeLessThanOrEqual(SOFT_LIMIT_BYTES);
    expect(state.console.length).toBeGreaterThanOrEqual(ROOT_CAUSE_WINDOW);
    expect(state.network.length).toBeGreaterThanOrEqual(ROOT_CAUSE_WINDOW);
  });

  it('shrinkOne never evicts inside the root-cause window', () => {
    const state = emptyState();
    for (let i = 0; i < ROOT_CAUSE_WINDOW; i++) insertNetwork(state, networkRaw(i));
    expect(shrinkOne(state)).toBe(false);
    expect(state.network).toHaveLength(ROOT_CAUSE_WINDOW);
  });
});

describe('serialize and rehydrate', () => {
  it('round-trips buffers, meta and marked pending records', () => {
    const state = emptyState();
    insertConsole(state, consoleRaw(1));
    insertNetwork(state, networkRaw(1));
    state.pageUrl = 'http://x/page';
    state.mainFrameId = 'F1';
    setPending(state, pendingReq('a', { marked: true }));
    setPending(state, pendingReq('b'));
    const restored = rehydrateState(JSON.parse(JSON.stringify(serialize(state, true))));
    expect(restored.console).toHaveLength(1);
    expect(restored.network).toHaveLength(1);
    expect(restored.pending.map((record) => record.requestId)).toEqual(['a']);
    expect(restored.pageUrl).toBe('http://x/page');
    expect(restored.mainFrameId).toBe('F1');
    expect(restored.nextSeq).toBe(state.nextSeq);
  });
  it('resets a key with the wrong shape and keeps the others', () => {
    const restored = rehydrateState({
      [KEYS.console]: 'garbage',
      [KEYS.network]: [{ fingerprint: 'f', count: 2 }],
      [KEYS.pending]: [{ nope: true }],
      [KEYS.meta]: 42,
    });
    expect(restored.console).toEqual([]);
    expect(restored.network).toHaveLength(1);
    expect(restored.pending).toEqual([]);
  });
  it('rehydrates empty from nothing', () => {
    expect(rehydrateState({}).console).toEqual([]);
  });
  it('new inserts after rehydrate keep counting from the stored sequence', () => {
    const state = emptyState();
    insertConsole(state, consoleRaw(1));
    const restored = rehydrateState(JSON.parse(JSON.stringify(serialize(state, true))));
    insertConsole(restored, consoleRaw(1));
    expect(restored.console).toHaveLength(1);
    expect(restored.console[0]?.count).toBe(2);
  });
  it('excludes pending records when asked', () => {
    const state = emptyState();
    setPending(state, pendingReq('a', { marked: true }));
    expect(serialize(state, false)[KEYS.pending]).toEqual([]);
  });
});
