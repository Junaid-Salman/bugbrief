/**
 * Steps 9 and 10: redactCapsule, the field maps, counting, the re-fold and the brand.
 * Compile-time guards run in `npm run build` (tsc includes tests/); Vitest does not typecheck.
 */
import { describe, expect, it } from 'vitest';
import { refoldRedacted, stripInternal, toConsoleEntry, toNetworkEntry, consoleFingerprint } from '../src/core/consolidate';
import {
  CAPSULE_MAP,
  CONSOLE_MAP,
  ELEMENT_MAP,
  NETWORK_MAP,
  redactCapsule,
  sealRedacted,
  type CapsuleDraft,
  type FieldMap,
  type RedactedCapsule,
} from '../src/core/redact';
import type { Capsule, CapsuleSummary, ConsoleEntry, ElementSnapshot, NetworkEntry } from '../src/core/types';

const R = '[REDACTED]';
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const SUMMARY: CapsuleSummary = {
  uniqueErrors: 0, totalErrors: 0, uniqueWarnings: 0, totalWarnings: 0, uniqueRequests: 0, totalRequests: 0,
};

// Escape-prone context around every secret: quotes, backslashes, non-ASCII.
const CTX = 'say "hi" \\ café 😀';

function fullConsole(): Required<ConsoleEntry> {
  return {
    level: 'error',
    message: `${CTX} ${TOKEN}`,
    stack: `Error: x\n    at f (https://x.com/app.js?sig=${TOKEN}:1:2)`,
    url: `https://x.com/a?token=${TOKEN}`,
    timestamp: 1,
    fingerprint: 'f',
    count: 1,
    lastSeen: 1,
    variants: 1,
    relatedRequest: 3,
    pageUrl: `https://x.com/p?apikey=${TOKEN}`,
    rawHashes: ['h'],
    seq: 4,
    touched: 5,
  };
}

function fullNetwork(): Required<NetworkEntry> {
  return {
    method: 'POST',
    url: `https://x.com/api?secret=${TOKEN}`,
    status: 500,
    errorText: `${CTX} ${TOKEN}`,
    requestHeaders: { authorization: TOKEN, 'x-note': `${CTX} ${TOKEN}` },
    requestBody: JSON.stringify({ password: `p"w\\${CTX}-zz9`, ok: 1 }),
    responseBody: JSON.stringify({ message: CTX, accessToken: `t"k\\${CTX}-yy8` }),
    durationMs: 12,
    timestamp: 2,
    fingerprint: 'g',
    count: 1,
    lastSeen: 2,
    variants: 1,
    pageUrl: `https://x.com/p?jwt=${TOKEN}`,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    rawHashes: ['h2'],
    seq: 6,
    touched: 7,
  };
}

function fullElement(): Required<ElementSnapshot> {
  return {
    selector: 'input[value="hunter2"]',
    outerHTML: `<input type="password" value="hunter2"><p>${CTX} ${TOKEN}</p>`,
    outerHTMLTruncated: false,
    styles: { backgroundImage: `url(x?token=${TOKEN})`, color: 'red' },
    rect: { x: 1, y: 2, width: 3, height: 4 },
    screenshotDataUrl: 'data:image/png;base64,AAAA',
  };
}

function fullDraft(): Required<CapsuleDraft> {
  return {
    pageUrl: `https://x.com/p?token=${TOKEN}`,
    pageTitle: `${CTX} ${TOKEN}`,
    userAgent: 'Mozilla/5.0',
    viewport: { width: 1, height: 2 },
    capturedAt: '2026-10-19T00:00:00.000Z',
    console: [fullConsole()],
    network: [fullNetwork()],
    element: fullElement(),
    userNote: 'password: hunter3',
  };
}

const SECRETS = [TOKEN, 'hunter2', 'hunter3', 'zz9', 'yy8', 'p"w'];

describe('redactCapsule', () => {
  it('masks a secret placed in every mapped field, in both JSON and raw strings', () => {
    const { draft } = redactCapsule(fullDraft());
    const json = JSON.stringify(draft);
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(draft);
    for (const secret of SECRETS) {
      expect(json, secret).not.toContain(secret);
      expect(strings.some((s) => s.includes(secret)), secret).toBe(false);
    }
    // Escape-prone context that is not a secret survives.
    expect(draft.pageTitle).toContain(CTX);
    expect(draft.console[0]?.message).toContain(CTX);
  });

  it('passes non-text fields through unchanged', () => {
    const input = fullDraft();
    const { draft } = redactCapsule(input);
    expect(draft.userAgent).toBe(input.userAgent);
    expect(draft.viewport).toEqual(input.viewport);
    expect(draft.capturedAt).toBe(input.capturedAt);
    expect(draft.element?.screenshotDataUrl).toBe(input.element.screenshotDataUrl);
    expect(draft.element?.rect).toEqual(input.element.rect);
    expect(draft.element?.styles.color).toBe('red');
    expect(draft.network[0]).toMatchObject({ method: 'POST', status: 500, durationMs: 12 });
    expect(draft.console[0]).toMatchObject({ level: 'error', timestamp: 1 });
  });

  it('does not mutate its input', () => {
    const input = fullDraft();
    const snapshot = structuredClone(input);
    redactCapsule(input);
    expect(input).toEqual(snapshot);
  });

  it('handles a capsule with no element, no note and empty buffers', () => {
    const { draft, redactionCount } = redactCapsule({
      pageUrl: 'https://x.com/', pageTitle: 't', userAgent: 'ua', viewport: { width: 1, height: 1 },
      capturedAt: 'now', console: [], network: [],
    });
    expect(redactionCount).toBe(0);
    expect(draft.element).toBeUndefined();
    expect('userNote' in draft).toBe(false);
  });

  it('counts the masks it applied, once each (criterion 7)', () => {
    const draft: CapsuleDraft = {
      pageUrl: 'https://x.com/?token=a1', pageTitle: 'plain', userAgent: 'ua',
      viewport: { width: 1, height: 1 }, capturedAt: 'now',
      console: [toConsoleEntry({ level: 'error', message: 'jo@x.org and password=zz', timestamp: 1 })],
      network: [], userNote: 'nothing here',
    };
    expect(redactCapsule(draft).redactionCount).toBe(3);
  });

  it('does not count literal mask text, and a second pass counts 0 (criteria 7 and 8)', () => {
    const first = redactCapsule(fullDraft());
    expect(first.redactionCount).toBeGreaterThan(10);
    const second = redactCapsule(first.draft);
    expect(second.redactionCount).toBe(0);
    expect(second.draft).toEqual(first.draft);
    const literal = redactCapsule({ ...fullDraft(), console: [], network: [], element: undefined, pageUrl: 'x', pageTitle: `${R} j***@x.org`, userNote: undefined });
    expect(literal.redactionCount).toBe(0);
  });

  it('counts an outer mask once when a JWT sits inside a sensitive key (criterion 7)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij';
    const entry = toNetworkEntry({
      method: 'GET', url: 'https://x.com/', status: 200, requestHeaders: { authorization: `Bearer ${jwt}` },
      responseBody: JSON.stringify({ token: jwt }), timestamp: 1,
    });
    const { draft, redactionCount } = redactCapsule({
      pageUrl: 'x', pageTitle: 't', userAgent: 'ua', viewport: { width: 1, height: 1 }, capturedAt: 'n',
      console: [], network: [entry],
    });
    expect(redactionCount).toBe(2);
    expect(draft.network[0]?.requestHeaders.authorization).toBe(R);
  });

  describe('cut flags (Q22)', () => {
    const base = (network: NetworkEntry[], consoleEntries: ConsoleEntry[] = []): CapsuleDraft => ({
      pageUrl: 'x', pageTitle: 't', userAgent: 'ua', viewport: { width: 1, height: 1 }, capturedAt: 'n',
      console: consoleEntries, network,
    });

    it('applies the tolerant forms to a body only when its truncated flag is set', () => {
      const body = '{"ok":1,"note":"eyJhbGciOiJIUzI1';
      const entry = (flag: boolean) =>
        toNetworkEntry({ method: 'GET', url: 'https://x.com/', status: 500, requestHeaders: {}, responseBody: body, responseBodyTruncated: flag, timestamp: 1 });
      expect(redactCapsule(base([entry(false)])).draft.network[0]?.responseBody).toBe(body);
      expect(redactCapsule(base([entry(true)])).draft.network[0]?.responseBody).toContain(R);
    });

    it('applies the tolerant forms to a console message that reached its cap', () => {
      const tail = 'x eyJhbGciOiJIUzI1';
      const long = 'a b '.repeat(1024).slice(0, 4096 - tail.length) + tail;
      expect(long.length).toBe(4096);
      const entry = toConsoleEntry({ level: 'error', message: long, timestamp: 1 });
      expect(redactCapsule(base([], [entry])).draft.console[0]?.message.endsWith(R)).toBe(true);
      const short = toConsoleEntry({ level: 'error', message: tail, timestamp: 1 });
      expect(redactCapsule(base([], [short])).draft.console[0]?.message).toBe(tail);
    });

    it('applies the tolerant forms to outerHTML only when outerHTMLTruncated is set', () => {
      const html = '<p>eyJhbGciOiJIUzI1';
      const withElement = (outerHTMLTruncated: boolean): CapsuleDraft => ({
        ...base([]),
        element: { selector: 'p', outerHTML: html, outerHTMLTruncated, styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, screenshotDataUrl: '' },
      });
      expect(redactCapsule(withElement(false)).draft.element?.outerHTML).toBe(html);
      expect(redactCapsule(withElement(true)).draft.element?.outerHTML).toBe(`<p>${R}`);
    });
  });
});

describe('field maps are exhaustive (criterion 6)', () => {
  it('every key of a full fixture has a mapping, including optional fields', () => {
    const covered = (fixture: object, map: object): string[] => Object.keys(fixture).filter((key) => !(key in map));
    expect(covered(fullDraft(), CAPSULE_MAP)).toEqual([]);
    expect(covered(fullConsole(), CONSOLE_MAP)).toEqual([]);
    expect(covered(fullNetwork(), NETWORK_MAP)).toEqual([]);
    expect(covered(fullElement(), ELEMENT_MAP)).toEqual([]);
  });

  it('fails to compile when a key is missing from a map', () => {
    // @ts-expect-error `outerHTMLTruncated` is missing, so tsc must reject this map
    const missing: FieldMap<ElementSnapshot> = {
      selector: 'selector', outerHTML: 'html', styles: 'styles', rect: 'keep', screenshotDataUrl: 'keep',
    };
    expect(Object.keys(missing)).toHaveLength(5);
  });

  it('keeps relatedRequest only in the console map', () => {
    expect(CONSOLE_MAP.relatedRequest).toBe('strip');
    expect('relatedRequest' in NETWORK_MAP).toBe(false);
  });
});

describe('re-fold (criterion 13, Q9)', () => {
  it('merges entries that differ only by a secret, with the recomputed fingerprint', () => {
    const a = toConsoleEntry({ level: 'error', message: 'request failed token=abc111', timestamp: 1 });
    const b = toConsoleEntry({ level: 'error', message: 'request failed token=zzz999', timestamp: 2 });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const { draft } = redactCapsule(wrap([a, b], []));
    expect(draft.console).toHaveLength(1);
    const merged = draft.console[0] as ConsoleEntry;
    expect(merged.count).toBe(2);
    expect(merged.variants).toBe(2);
    expect(merged.lastSeen).toBe(2);
    expect(merged.message).toBe(`request failed token=${R}`);
    expect(merged.fingerprint).toBe(consoleFingerprint(merged));
    expect(merged.fingerprint).not.toBe(a.fingerprint);
  });

  it('keeps variants at 1 for identical raw text, and 2 for different raw text with the same redacted text', () => {
    const same1 = toConsoleEntry({ level: 'error', message: 'boom', timestamp: 1 });
    const same2 = toConsoleEntry({ level: 'error', message: 'boom', timestamp: 2 });
    expect((redactCapsule(wrap([same1, same2], [])).draft.console[0] as ConsoleEntry).variants).toBe(1);
    const x = toConsoleEntry({ level: 'error', message: 'boom password=aaa', timestamp: 1 });
    const y = toConsoleEntry({ level: 'error', message: 'boom password=bbb', timestamp: 2 });
    expect((redactCapsule(wrap([x, y], [])).draft.console[0] as ConsoleEntry).variants).toBe(2);
  });

  it('merges network entries, keeps requestHeaders and strips the internal fields', () => {
    const make = (secret: string, timestamp: number) =>
      toNetworkEntry({
        method: 'POST', url: `https://x.com/api?token=${secret}`, status: 500,
        requestHeaders: { accept: 'application/json', authorization: secret }, timestamp,
      });
    const { draft } = redactCapsule(wrap([], [make('aaa111', 1), make('bbb222', 2)]));
    expect(draft.network).toHaveLength(1);
    const entry = draft.network[0] as NetworkEntry;
    expect(entry.count).toBe(2);
    expect(entry.requestHeaders).toEqual({ accept: 'application/json', authorization: R });
    for (const key of ['rawHashes', 'seq', 'touched', 'relatedRequest']) expect(key in entry).toBe(false);
  });

  it('strips a stale relatedRequest from input entries, and every internal field from the output', () => {
    const entry = { ...toConsoleEntry({ level: 'error', message: 'x', timestamp: 1 }), relatedRequest: 9, seq: 1, touched: 2 };
    const { draft } = redactCapsule(wrap([entry], []));
    const out = draft.console[0] as ConsoleEntry;
    for (const key of ['rawHashes', 'seq', 'touched', 'relatedRequest']) expect(key in out).toBe(false);
  });

  it('sorts by timestamp and keeps input order for equal timestamps', () => {
    const entries = ['c', 'a', 'b'].map((message) =>
      toConsoleEntry({ level: 'error', message, timestamp: 5 }),
    );
    expect(refoldRedacted(entries, []).console.map((e) => e.message)).toEqual(['c', 'a', 'b']);
    const out = refoldRedacted(
      [toConsoleEntry({ level: 'error', message: 'late', timestamp: 9 }), toConsoleEntry({ level: 'error', message: 'early', timestamp: 1 })],
      [],
    );
    expect(out.console.map((e) => e.message)).toEqual(['early', 'late']);
  });

  it('stripInternal removes exactly the internal names', () => {
    expect(stripInternal({ a: 1, rawHashes: ['x'], seq: 1, touched: 2, relatedRequest: 3 })).toEqual({ a: 1 });
  });
});

describe('brand (Q23)', () => {
  it('seals a draft, and a P7-style link, cap and re-seal flow still type-checks', () => {
    const { draft, redactionCount } = redactCapsule(fullDraft());
    const sealed: RedactedCapsule = sealRedacted(draft, { summary: SUMMARY, redactionCount });
    expect(sealed.redactionCount).toBe(redactionCount);

    // P7 derives new objects by spreading the branded draft: links, caps, trims.
    const derived = {
      ...draft,
      console: draft.console.slice(0, 20).map((entry) => ({ ...entry, relatedRequest: 1 })),
      network: draft.network.slice(0, 10),
    };
    const resealed: RedactedCapsule = sealRedacted(derived, { summary: SUMMARY, redactionCount });
    expect(resealed.console[0]?.relatedRequest).toBe(1);
  });

  it('rejects forged drafts and capsules at compile time', () => {
    const plain: Capsule = { ...fullDraft(), summary: SUMMARY, redactionCount: 0 };
    // @ts-expect-error an unbranded draft is rejected by sealRedacted
    sealRedacted(fullDraft(), { summary: SUMMARY, redactionCount: 0 });
    // @ts-expect-error an unbranded Capsule is not a RedactedCapsule
    const forged: RedactedCapsule = plain;
    expect(forged.summary).toBe(SUMMARY);
  });
});

function wrap(consoleEntries: ConsoleEntry[], network: NetworkEntry[]): CapsuleDraft {
  return {
    pageUrl: 'https://x.com/', pageTitle: 't', userAgent: 'ua', viewport: { width: 1, height: 1 },
    capturedAt: 'now', console: consoleEntries, network,
  };
}
