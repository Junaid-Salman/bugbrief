import { describe, expect, it } from 'vitest';
import {
  consoleFingerprint,
  cyrb53,
  foldConsole,
  foldNetwork,
  networkFingerprint,
  normalizeFile,
  normalizeMessage,
  normalizePath,
  toConsoleEntry,
  toNetworkEntry,
  topFrameKeys,
} from '../src/core/consolidate';
import type { RawConsoleEntry, RawNetworkEntry } from '../src/core/types';

const consoleEntry = (overrides: Partial<RawConsoleEntry> = {}): RawConsoleEntry => ({
  level: 'error',
  message: "TypeError: Cannot read properties of undefined (reading 'map')",
  stack: '    at OrderList (http://localhost:5174/main.js:142:18)\n    at render (http://localhost:5174/vendor.js:10:2)',
  url: 'http://localhost:5174/main.js',
  timestamp: 1000,
  ...overrides,
});

const networkEntry = (overrides: Partial<RawNetworkEntry> = {}): RawNetworkEntry => ({
  method: 'POST',
  url: 'http://localhost:5174/api/orders/123',
  status: 500,
  requestHeaders: {},
  responseBody: '{"error":"Order service unavailable"}',
  timestamp: 1000,
  ...overrides,
});

describe('normalizers', () => {
  it('replaces UUIDs, ISO timestamps, long hex and big numbers', () => {
    expect(normalizeMessage('id 9d3f1c2a-1111-4222-8333-abcdefabcdef at 2026-10-16T17:00:00.123Z')).toBe('id <uuid> at <ts>');
    expect(normalizeMessage('token a1b2c3d4e5f6a7b8 n 1234567')).toBe('token <hex> n <n>');
  });
  it('drops query strings and hashes from URLs', () => {
    expect(normalizeMessage('GET https://api.x.com/items?token=abc#top failed')).toBe('GET https://api.x.com/items failed');
  });
  it('keeps short numbers and words', () => {
    expect(normalizeMessage("reading '0' of item 42")).toBe("reading '0' of item 42");
  });
  it('collapses whitespace', () => {
    expect(normalizeMessage('a   b\n c')).toBe('a b c');
  });
  it('strips bundle hashes from file names only', () => {
    expect(normalizeFile('main.3f9a1c2b.js')).toBe('main.js');
    expect(normalizeFile('chunk-A1B2C3D4.js')).toBe('chunk.js');
    expect(normalizeFile('app.js')).toBe('app.js');
  });
  it('turns id-like path segments into :id', () => {
    expect(normalizePath('/api/orders/123/items/9d3f1c2a-1111-4222-8333-abcdefabcdef')).toBe('/api/orders/:id/items/:id');
    expect(normalizePath('/api/orders/latest')).toBe('/api/orders/latest');
  });
  it('extracts the top 3 frames with line and column', () => {
    const stack = ['    at a (http://x/a.js:1:2)', '    at b (http://x/b.js:3:4)', '    at (http://x/c.js:5:6)', '    at d (http://x/d.js:7:8)'].join('\n');
    expect(topFrameKeys(stack)).toEqual(['a@a.js:1:2', 'b@b.js:3:4', '<anonymous>@c.js:5:6']);
  });
});

describe('fingerprints: must merge', () => {
  it('identical console errors', () => {
    expect(consoleFingerprint(consoleEntry())).toBe(consoleFingerprint(consoleEntry({ timestamp: 5000 })));
  });
  it('errors differing only by UUID', () => {
    const a = consoleEntry({ message: 'Order 9d3f1c2a-1111-4222-8333-abcdefabcdef not found' });
    const b = consoleEntry({ message: 'Order 0a1b2c3d-9999-4888-8777-123456789abc not found' });
    expect(consoleFingerprint(a)).toBe(consoleFingerprint(b));
  });
  it('errors differing only by timestamp, long number or query string', () => {
    const a = consoleEntry({ message: 'Failed at 2026-10-16T17:00:00Z for user 1234567 via https://x.com/a?t=1' });
    const b = consoleEntry({ message: 'Failed at 2026-10-17T09:30:11Z for user 7654321 via https://x.com/a?t=2' });
    expect(consoleFingerprint(a)).toBe(consoleFingerprint(b));
  });
  it('errors from the same bundle with different hashes', () => {
    const a = consoleEntry({ stack: '    at f (http://x/main.3f9a1c2b.js:1:2)', url: 'http://x/main.3f9a1c2b.js' });
    const b = consoleEntry({ stack: '    at f (http://x/main.aa11bb22cc.js:1:2)', url: 'http://x/main.aa11bb22cc.js' });
    expect(consoleFingerprint(a)).toBe(consoleFingerprint(b));
  });
  it('network requests to /orders/123 and /orders/456', () => {
    const a = networkEntry();
    const b = networkEntry({ url: 'http://localhost:5174/api/orders/456?x=1' });
    expect(networkFingerprint(a)).toBe(networkFingerprint(b));
  });
  it('network method case is ignored', () => {
    expect(networkFingerprint(networkEntry({ method: 'post' }))).toBe(networkFingerprint(networkEntry()));
  });
});

describe('fingerprints: must not merge', () => {
  it('different array index', () => {
    const a = consoleEntry({ message: "TypeError: Cannot read properties of undefined (reading '0')" });
    const b = consoleEntry({ message: "TypeError: Cannot read properties of undefined (reading '1')" });
    expect(consoleFingerprint(a)).not.toBe(consoleFingerprint(b));
  });
  it('same message from a different throw site', () => {
    const a = consoleEntry({ stack: '    at A (http://x/main.js:10:5)' });
    const b = consoleEntry({ stack: '    at A (http://x/main.js:99:5)' });
    expect(consoleFingerprint(a)).not.toBe(consoleFingerprint(b));
  });
  it('same message in a different function', () => {
    const a = consoleEntry({ stack: '    at A (http://x/main.js:10:5)' });
    const b = consoleEntry({ stack: '    at B (http://x/main.js:10:5)' });
    expect(consoleFingerprint(a)).not.toBe(consoleFingerprint(b));
  });
  it('error versus warning', () => {
    expect(consoleFingerprint(consoleEntry({ level: 'error' }))).not.toBe(consoleFingerprint(consoleEntry({ level: 'warning' })));
  });
  it('same message from a different script file', () => {
    expect(consoleFingerprint(consoleEntry({ url: 'http://x/a.js' }))).not.toBe(consoleFingerprint(consoleEntry({ url: 'http://x/b.js' })));
  });
  it('different words in the message', () => {
    expect(consoleFingerprint(consoleEntry({ message: 'Network timeout' }))).not.toBe(consoleFingerprint(consoleEntry({ message: 'Network offline' })));
  });
  it('different status on the same endpoint', () => {
    expect(networkFingerprint(networkEntry({ status: 500 }))).not.toBe(networkFingerprint(networkEntry({ status: 404 })));
  });
  it('different method on the same endpoint', () => {
    expect(networkFingerprint(networkEntry({ method: 'GET' }))).not.toBe(networkFingerprint(networkEntry({ method: 'POST' })));
  });
  it('different endpoints', () => {
    expect(networkFingerprint(networkEntry({ url: 'http://x/api/orders/1' }))).not.toBe(networkFingerprint(networkEntry({ url: 'http://x/api/users/1' })));
  });
  it('different response body on the same endpoint and status', () => {
    expect(networkFingerprint(networkEntry({ responseBody: '{"error":"A"}' }))).not.toBe(networkFingerprint(networkEntry({ responseBody: '{"error":"B"}' })));
  });
  it('different failure reason with no status', () => {
    const a = networkEntry({ status: null, errorText: 'net::ERR_CONNECTION_REFUSED', responseBody: undefined });
    const b = networkEntry({ status: null, errorText: 'net::ERR_NAME_NOT_RESOLVED', responseBody: undefined });
    expect(networkFingerprint(a)).not.toBe(networkFingerprint(b));
  });
});

describe('fingerprint safety', () => {
  it('is a short hex hash that never contains the input text', () => {
    const secret = 'sk_live_supersecretvalue';
    const fingerprint = consoleFingerprint(consoleEntry({ message: `Auth failed with ${secret}` }));
    expect(fingerprint).toMatch(/^[0-9a-f]{1,14}$/);
    expect(fingerprint).not.toContain(secret);
  });
  it('cyrb53 is deterministic and seed-sensitive', () => {
    expect(cyrb53('abc')).toBe(cyrb53('abc'));
    expect(cyrb53('abc')).not.toBe(cyrb53('abc', 1));
  });
});

describe('fold', () => {
  it('merges identical console entries and counts them', () => {
    let entry = toConsoleEntry(consoleEntry({ timestamp: 1000 }));
    for (let i = 1; i < 5; i++) entry = foldConsole(entry, toConsoleEntry(consoleEntry({ timestamp: 1000 + i * 100 })));
    expect(entry.count).toBe(5);
    expect(entry.timestamp).toBe(1000);
    expect(entry.lastSeen).toBe(1400);
    expect(entry.variants).toBe(1);
  });
  it('counts message variants when merged raw text differs', () => {
    const a = toConsoleEntry(consoleEntry({ message: 'Order 9d3f1c2a-1111-4222-8333-abcdefabcdef failed', timestamp: 1 }));
    const b = toConsoleEntry(consoleEntry({ message: 'Order 0a1b2c3d-9999-4888-8777-123456789abc failed', timestamp: 2 }));
    expect(a.fingerprint).toBe(b.fingerprint);
    const merged = foldConsole(a, b);
    expect(merged.count).toBe(2);
    expect(merged.variants).toBe(2);
  });
  it('keeps the first occurrence content regardless of fold order', () => {
    const first = toConsoleEntry(consoleEntry({ message: 'Order 100000 failed', timestamp: 1 }));
    const second = toConsoleEntry(consoleEntry({ message: 'Order 200000 failed', timestamp: 2 }));
    expect(foldConsole(second, first).message).toBe('Order 100000 failed');
  });
  it('caps tracked variants at 20', () => {
    let entry = toNetworkEntry(networkEntry({ responseBody: undefined, requestBody: 'v0', timestamp: 1 }));
    for (let i = 1; i < 30; i++) {
      entry = foldNetwork(entry, toNetworkEntry(networkEntry({ responseBody: undefined, requestBody: `v${i}`, timestamp: 1 + i })));
    }
    expect(entry.count).toBe(30);
    expect(entry.variants).toBe(20);
    expect(entry.rawHashes?.length).toBe(20);
  });
  it('merges network entries on first/last seen and keeps the first body', () => {
    const a = toNetworkEntry(networkEntry({ timestamp: 10, responseBody: '{"error":"x"}' }));
    const b = toNetworkEntry(networkEntry({ timestamp: 20, url: 'http://localhost:5174/api/orders/456', responseBody: '{"error":"x"}' }));
    expect(a.fingerprint).toBe(b.fingerprint);
    const merged = foldNetwork(a, b);
    expect(merged.count).toBe(2);
    expect(merged.timestamp).toBe(10);
    expect(merged.lastSeen).toBe(20);
    expect(merged.url).toBe('http://localhost:5174/api/orders/123');
  });
  it('sums counts when re-folding already merged entries', () => {
    let a = toConsoleEntry(consoleEntry({ timestamp: 1 }));
    a = foldConsole(a, toConsoleEntry(consoleEntry({ timestamp: 2 })));
    let b = toConsoleEntry(consoleEntry({ timestamp: 3 }));
    b = foldConsole(b, toConsoleEntry(consoleEntry({ timestamp: 4 })));
    const merged = foldConsole(a, b);
    expect(merged.count).toBe(4);
    expect(merged.lastSeen).toBe(4);
  });
});
