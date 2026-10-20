/** Step 2: cause and effect links into the shown list, and the summary over the full set (criteria 4, 6). */
import { describe, expect, it } from 'vitest';
import { linkCauses, summarizeCapsule } from '../src/core/consolidate';
import { applyCaps } from '../src/core/capsule';
import { consoleEntry, networkEntry, t } from './helpers/capsule';

const net = (path: string, at = t(17, 0, 0), extra = {}) => networkEntry({ url: `http://x.test${path}`, timestamp: at, ...extra });

describe('rule 1: the URL path appears in the message or in the entry url', () => {
  it('links when the message contains the path', () => {
    const out = linkCauses([consoleEntry({ message: 'POST /api/orders failed' })], [net('/api/items'), net('/api/orders')]);
    expect(out[0]?.relatedRequest).toBe(2);
  });
  it('links Chrome network-error entries through entry.url', () => {
    const entry = consoleEntry({ message: 'Failed to load resource: the server responded with a status of 500 ()', url: 'http://x.test/api/orders' });
    expect(linkCauses([entry], [net('/api/orders', t(23, 0, 0))])[0]?.relatedRequest).toBe(1);
  });
  it('the longest matching path wins', () => {
    const out = linkCauses([consoleEntry({ message: 'error calling /api/orders/42' })], [net('/api/orders'), net('/api/orders/42')]);
    expect(out[0]?.relatedRequest).toBe(2);
  });
  it('a tie on path length goes to the closest timestamp', () => {
    const out = linkCauses(
      [consoleEntry({ message: 'GET /api/a1 and /api/a2 failed', timestamp: t(17, 0, 10) })],
      [net('/api/a1', t(17, 0, 0)), net('/api/a2', t(17, 0, 9))],
    );
    expect(out[0]?.relatedRequest).toBe(2);
  });
  it('ignores "/" and paths shorter than 3 characters', () => {
    const out = linkCauses([consoleEntry({ message: 'left / right and /a', timestamp: t(17, 0, 0) })], [net('/'), net('/a'), net('/ab')]);
    expect(out[0]?.relatedRequest).toBeUndefined();
  });
});

describe('rule 2: a network-sounding message and a request within 1500 ms', () => {
  const msg = 'TypeError: Failed to fetch';
  it('links the closest request inside the window', () => {
    const out = linkCauses([consoleEntry({ message: msg, timestamp: t(17, 0, 10) })], [net('/x1', t(17, 0, 9)), net('/x2', t(17, 0, 10) + 400)]);
    expect(out[0]?.relatedRequest).toBe(2);
  });
  it('does not link outside ±1500 ms', () => {
    expect(linkCauses([consoleEntry({ message: msg, timestamp: t(17, 0, 10) })], [net('/x1', t(17, 0, 7))])[0]?.relatedRequest).toBeUndefined();
  });
  it('does not link a message that is not about the network', () => {
    expect(linkCauses([consoleEntry({ message: 'Cannot read properties of undefined', timestamp: t(17, 0, 10) })], [net('/x1', t(17, 0, 10))])[0]?.relatedRequest).toBeUndefined();
  });
  it.each(['fetch', 'network error', 'xhr', 'XMLHttpRequest', 'Failed to load resource', 'status code 500', 'net::ERR_X'])('matches %s', (word) => {
    expect(linkCauses([consoleEntry({ message: `problem: ${word}`, timestamp: t(17, 0, 0) })], [net('/x1', t(17, 0, 0))])[0]?.relatedRequest).toBe(1);
  });
});

describe('links only point into the shown list (criterion 6)', () => {
  it('does not link to an omitted request, and every index is a real heading number', () => {
    const requests = Array.from({ length: 15 }, (_, i) => net(`/api/item${String(i).padStart(2, '0')}`, t(17, 0, i)));
    const entries = [
      consoleEntry({ message: 'failed /api/item03', timestamp: t(17, 0, 3) }),
      consoleEntry({ message: 'failed /api/item12', timestamp: t(17, 0, 12) }),
    ];
    const capped = applyCaps(entries, requests);
    const out = linkCauses(capped.console, capped.network);
    expect(out.find((e) => e.message.includes('item03'))?.relatedRequest).toBe(4);
    expect(out.find((e) => e.message.includes('item12'))?.relatedRequest).toBeUndefined();
    for (const entry of out) {
      if (entry.relatedRequest !== undefined) expect(entry.relatedRequest).toBeLessThanOrEqual(capped.network.length);
    }
  });
});

describe('purity', () => {
  it('replaces a stale relatedRequest and does not mutate the input or change counts', () => {
    const stale = { ...consoleEntry({ message: 'nothing related here' }), relatedRequest: 9 };
    const input = [stale];
    const out = linkCauses(input, [net('/x1')]);
    expect(out[0]).not.toHaveProperty('relatedRequest');
    expect(stale.relatedRequest).toBe(9);
    expect(out[0]?.count).toBe(stale.count);
    expect(out).toHaveLength(1);
  });
  it('keeps every other field', () => {
    const entry = consoleEntry({ message: 'failed /api/orders', count: 4, variants: 2 });
    const out = linkCauses([entry], [net('/api/orders')])[0];
    expect(out).toMatchObject({ message: entry.message, count: 4, variants: 2, relatedRequest: 1 });
  });
});

describe('summarizeCapsule (criterion 4)', () => {
  it('counts unique and total over all entries, not just the shown ones', () => {
    const entries = [
      ...Array.from({ length: 25 }, (_, i) => consoleEntry({ message: `e${i}`, count: 2, timestamp: t(17, 0, i) })),
      consoleEntry({ level: 'warning', message: 'w', count: 3 }),
    ];
    const requests = Array.from({ length: 12 }, (_, i) => net(`/api/r${i}`, t(17, 0, i), { count: 4 }));
    const summary = summarizeCapsule(entries, requests);
    expect(summary).toEqual({ uniqueErrors: 25, totalErrors: 50, uniqueWarnings: 1, totalWarnings: 3, uniqueRequests: 12, totalRequests: 48 });
    expect(applyCaps(entries, requests).console).toHaveLength(20); // the cap does not change the summary
  });
  it('is all zeros for nothing', () => {
    expect(summarizeCapsule([], [])).toEqual({ uniqueErrors: 0, totalErrors: 0, uniqueWarnings: 0, totalWarnings: 0, uniqueRequests: 0, totalRequests: 0 });
  });
});
