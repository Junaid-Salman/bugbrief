/** Step 4: assembly through the whole pipeline (criteria 2, 10, 17). */
import { describe, expect, it } from 'vitest';
import { buildCapsule, NOTHING_TO_REPORT, type BuildDeps } from '../src/background/capsule-builder';
import { FIELD } from '../src/core/limits';
import type { PickedPage } from '../src/core/element-model';
import type { ConsoleEntry, ElementSnapshot, NetworkEntry } from '../src/core/types';
import { consoleEntry, networkEntry, t, UA } from './helpers/capsule';
import { SEED, mulberry32, randomSecret } from './helpers/secrets';

const EMPTY_TALLY = { entries: 0, occurrences: 0 };
const NOW = new Date('2026-10-20T10:15:30.120Z');

interface Rig {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pageUrl?: string;
  page?: { title: string; viewport?: { width: number; height: number }; forUrl: string };
  element?: { snapshot: ElementSnapshot; tabId: number; pickedAt: number; page: PickedPage; screenshot: { status: 'pending' } | { status: 'captured' } | { status: 'clipped' } | { status: 'unavailable'; reason: 'tab-not-active' } };
  userAgent: string;
}

function deps(rig: Rig): BuildDeps {
  return {
    readBuffer: () => ({
      console: rig.console, network: rig.network, pageUrl: rig.pageUrl, page: rig.page,
      evicted: { console: EMPTY_TALLY, network: EMPTY_TALLY },
    }),
    readElement: () => rig.element,
    userAgent: () => rig.userAgent,
    now: () => NOW,
  };
}

const snapshot = (patch: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  selector: '#buy', outerHTML: '<button id="buy">Buy</button>', styles: { display: 'block' },
  rect: { x: 1, y: 2, width: 30, height: 40 }, screenshotDataUrl: '', ...patch,
});
const elementPage = (url = 'http://localhost:5174/'): PickedPage => ({ url, title: 'Element page', viewport: { width: 800, height: 600 }, devicePixelRatio: 1 });

function rigWith(patch: Partial<Rig> = {}): Rig {
  return {
    console: [consoleEntry({ message: 'TypeError: boom', count: 2 })],
    network: [networkEntry({ url: 'http://localhost:5174/api/orders', count: 3 })],
    pageUrl: 'http://localhost:5174/', page: { title: 'Orders', viewport: { width: 1440, height: 900 }, forUrl: 'http://localhost:5174/' },
    userAgent: UA, ...patch,
  };
}

describe('page fields (criterion 10)', () => {
  it('a recording supplies the page fields and the worker supplies the user agent', () => {
    const result = buildCapsule(deps(rigWith()), { userNote: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('# Bug Capsule — Orders');
    expect(result.markdown).toContain('**Viewport:** 1440×900  **UA:** Chrome 155');
    expect(result.markdown).toContain('**Captured:** 2026-10-20T10:15:30.120Z');
    expect(result.markdown).not.toContain('## Selected element');
  });
  it('with no recording, the element page supplies title, URL and viewport', () => {
    const element = { snapshot: snapshot(), tabId: 3, pickedAt: 1, page: elementPage(), screenshot: { status: 'pending' as const } };
    const result = buildCapsule(deps({ console: [], network: [], userAgent: UA, element }), { userNote: '' });
    expect(result.ok && result.markdown).toContain('# Bug Capsule — Element page');
    expect(result.ok && result.markdown).toContain('**Viewport:** 800×600');
    expect(result.ok && result.markdown).toContain('## Selected element');
  });
  it('shows a Page line when the element came from another page', () => {
    const element = { snapshot: snapshot(), tabId: 3, pickedAt: 1, page: elementPage('http://localhost:5174/other?token=SECRETQ'), screenshot: { status: 'pending' as const } };
    const result = buildCapsule(deps(rigWith({ element })), { userNote: '' });
    expect(result.ok && result.markdown).toContain('**Page:** `http://localhost:5174/other?token=[REDACTED]`');
  });
  it('ignores stored metadata that belongs to another page (a navigation happened)', () => {
    const rig = rigWith({ page: { title: 'Old page', viewport: { width: 1, height: 1 }, forUrl: 'http://localhost:5174/old' } });
    const result = buildCapsule(deps(rig), { userNote: '' });
    expect(result.ok && result.markdown.split('\n')[0]).toBe('# Bug Capsule — localhost:5174');
    expect(result.ok && result.markdown).not.toContain('**Viewport:**');
  });
  it('returns a failure result, never Markdown, when there is nothing to report', () => {
    expect(buildCapsule(deps({ console: [], network: [], userAgent: UA }), { userNote: 'hello' })).toEqual({ ok: false, error: NOTHING_TO_REPORT });
  });
  it('an element alone is enough to report', () => {
    const element = { snapshot: snapshot(), tabId: 3, pickedAt: 1, page: elementPage(), screenshot: { status: 'captured' as const } };
    expect(buildCapsule(deps({ console: [], network: [], userAgent: UA, element }), { userNote: '' }).ok).toBe(true);
  });
});

describe('purity and determinism', () => {
  it('does not mutate the buffer or the element', () => {
    const element = { snapshot: snapshot({ screenshotDataUrl: 'data:image/png;base64,AAAA' }), tabId: 3, pickedAt: 1, page: elementPage(), screenshot: { status: 'captured' as const } };
    const rig = rigWith({ element });
    const before = structuredClone(rig);
    buildCapsule(deps(rig), { userNote: 'note with jane@example.com' });
    expect(rig).toEqual(before);
  });
  it('uses the supplied capturedAt and the injected clock otherwise', () => {
    const a = buildCapsule(deps(rigWith()), { userNote: '', capturedAt: '2026-01-02T03:04:05.000Z' });
    expect(a.ok && a.capturedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(a.ok && a.markdown).toContain('**Captured:** 2026-01-02T03:04:05.000Z');
    const b = buildCapsule(deps(rigWith()), { userNote: '' });
    expect(b.ok && b.capturedAt).toBe(NOW.toISOString());
  });
  it('is deterministic: the same inputs give the same Markdown and hash', () => {
    const a = buildCapsule(deps(rigWith()), { userNote: 'n' });
    const b = buildCapsule(deps(rigWith()), { userNote: 'n' });
    expect(a).toEqual(b);
  });
});

describe('previewHash (criterion 12, Q20)', () => {
  const withImage = (pickedAt: number, dataUrl: string): Rig =>
    rigWith({ element: { snapshot: snapshot({ screenshotDataUrl: dataUrl }), tabId: 3, pickedAt, page: elementPage('http://localhost:5174/'), screenshot: { status: 'captured' } } });
  const hash = (rig: Rig, note = '') => {
    const r = buildCapsule(deps(rig), { userNote: note, capturedAt: '2026-10-20T10:15:30.120Z' });
    return r.ok ? r.previewHash : '';
  };
  it('changes when the note changes', () => {
    expect(hash(rigWith(), 'a')).not.toBe(hash(rigWith(), 'b'));
  });
  it('changes for a re-pick with identical Markdown but a different image', () => {
    const one = hash(withImage(1, 'data:image/png;base64,AAAA'));
    expect(hash(withImage(2, 'data:image/png;base64,AAAA'))).not.toBe(one);
    expect(hash(withImage(1, 'data:image/png;base64,AAAAAAAA'))).not.toBe(one);
    expect(hash(withImage(1, 'data:image/png;base64,AAAA'))).toBe(one);
  });
});

describe('summary, caps and links through the pipeline (criteria 4, 5, 6)', () => {
  it('counts every entry in the summary, shows 20 and 10, and links into the shown list', () => {
    const consoles = Array.from({ length: 30 }, (_, i) => consoleEntry({ message: `failed /api/r${String(i % 15).padStart(2, '0')} number ${i}`, count: 2, timestamp: t(17, 0, i) }));
    const requests = Array.from({ length: 15 }, (_, i) => networkEntry({ url: `http://localhost:5174/api/r${String(i).padStart(2, '0')}`, count: 3, timestamp: t(17, 0, i) }));
    const result = buildCapsule(deps(rigWith({ console: consoles, network: requests })), { userNote: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('| Errors | 30 | 60 |');
    expect(result.markdown).toContain('| Failed requests | 15 | 45 |');
    expect(result.markdown).toContain('## Console errors (20)');
    expect(result.markdown).toContain('## Failed requests (10)');
    expect(result.markdown).toContain('## Also seen');
    const linked = [...result.markdown.matchAll(/failed request #(\d+)\./g)].map((m) => Number(m[1]));
    expect(linked.length).toBeGreaterThan(0);
    for (const n of linked) {
      expect(n).toBeLessThanOrEqual(10);
      expect(result.markdown).toContain(`### ${n}. `);
    }
  });
  it('caps the note at 2 000 characters and redacts it', () => {
    const result = buildCapsule(deps(rigWith()), { userNote: `contact jane@example.com ${'x'.repeat(3000)}` });
    expect(result.ok && result.markdown).toContain('j***@example.com');
    expect(result.ok && result.markdown).not.toContain('x'.repeat(FIELD.userNote));
  });
});

describe('screenshot kinds', () => {
  type State = NonNullable<Rig['element']>['screenshot'];
  const make = (screenshot: State, dataUrl = ''): Rig =>
    rigWith({ element: { snapshot: snapshot({ screenshotDataUrl: dataUrl }), tabId: 3, pickedAt: 1, page: elementPage(), screenshot } });
  it.each([
    ['pending', { status: 'pending' as const }, '', 'pending', 'still being captured'],
    ['captured', { status: 'captured' as const }, 'data:image/png;base64,AAAA', 'captured', 'capsule-20261020-101530.png (a separate file'],
    ['clipped', { status: 'clipped' as const }, 'data:image/png;base64,AAAA', 'clipped', 'clipped to the viewport'],
    ['unavailable', { status: 'unavailable' as const, reason: 'tab-not-active' as const }, '', 'unavailable', 'unavailable (the tab was not in front)'],
  ])('%s', (_label, state, dataUrl, kind, line) => {
    const result = buildCapsule(deps(make(state, dataUrl)), { userNote: '' });
    expect(result.ok && result.screenshot).toBe(kind);
    expect(result.ok && result.markdown).toContain(line);
    expect(result.ok && result.pngDataUrl).toBe(dataUrl);
  });
});

describe('a seeded secret in every field never reaches the Markdown (criterion 2)', () => {
  it('masks or omits every planted secret across the whole pipeline', () => {
    const S = {
      msg: 'password=hunter2msg', stack: 'at f (https://x.test/a.js?token=STACKSECRET:1:2)', curl: 'https://x.test/c?apikey=CURLSECRET',
      nurl: 'https://x.test/api?secret=NURLSECRET', nerr: 'jane.error@example.com', nreq: '{"password":"REQSECRET"}',
      nres: '{"accessToken":"RESSECRET"}', sel: 'input[value="SELSECRET"]', html: '<input type="password" value="HTMLSECRET">',
      style: 'url(x?token=STYLESECRET)', note: 'my password: NOTESECRET', title: 'Reset for title.secret@example.com', ua: 'UASECRET/1.0',
    };
    const element = {
      snapshot: snapshot({ selector: S.sel, outerHTML: S.html, styles: { 'background-color': S.style } }),
      tabId: 3, pickedAt: 1, page: elementPage('https://x.test/p?session=PAGESECRET'), screenshot: { status: 'pending' as const },
    };
    const rig = rigWith({
      console: [consoleEntry({ message: S.msg, stack: S.stack, url: S.curl })],
      network: [networkEntry({ url: S.nurl, errorText: S.nerr, requestBody: S.nreq, responseBody: S.nres })],
      pageUrl: 'https://x.test/?token=PAGEURLSECRET', page: { title: S.title, forUrl: 'https://x.test/?token=PAGEURLSECRET' },
      userAgent: S.ua, element,
    });
    const result = buildCapsule(deps(rig), { userNote: S.note });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const secret of ['hunter2msg', 'STACKSECRET', 'CURLSECRET', 'NURLSECRET', 'jane.error@example.com', 'REQSECRET', 'RESSECRET', 'SELSECRET', 'HTMLSECRET', 'STYLESECRET', 'NOTESECRET', 'title.secret@example.com', 'UASECRET', 'PAGESECRET', 'PAGEURLSECRET']) {
      expect(result.markdown, secret).not.toContain(secret);
    }
    expect(result.redactionCount).toBeGreaterThan(8);
  });
});

describe('worst case (criterion 17)', () => {
  it('builds a capsule from about 5 MB of entries well under the 10 s gate', () => {
    const rng = mulberry32(SEED);
    const filler = (n: number) => { let out = ''; while (out.length < n) out += `${randomSecret(rng, 'hex')} ${rng() < 0.5 ? 'GET /api/v2/users' : 'failed item-'} `; return out.slice(0, n); };
    const consoles = Array.from({ length: 200 }, (_, i) => consoleEntry({ message: `${i} ${filler(FIELD.consoleMessage - 8)}`, stack: filler(FIELD.consoleStack), timestamp: i }));
    const requests = Array.from({ length: 50 }, (_, i) => networkEntry({ url: `https://x.test/${i}/${filler(1500).replace(/\s/g, '/')}`, requestBody: `{"a":"${filler(FIELD.requestBody - 20)}"}`, responseBody: `{"b":"${filler(FIELD.responseBody - 20)}"}`, timestamp: i }));
    const start = performance.now();
    const result = buildCapsule(deps(rigWith({ console: consoles, network: requests })), { userNote: '' });
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`capsule build worst case: ${(elapsed / 1000).toFixed(2)} s, ${result.ok ? (result.markdown.length / 1024).toFixed(0) : 0} KB of Markdown`);
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});
