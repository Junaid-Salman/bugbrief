/** Phase 4.1: fixes from Reviews/p4-redaction-review.md. Criteria 16 to 25 of the P4 plan. */
import { describe, expect, it } from 'vitest';
import { redactBody } from '../src/core/redact-body';
import { redactText } from '../src/core/redact-text';
import { isMasked } from '../src/core/redact-spans';
import { redactHtml } from '../src/core/redact-html';
import { redactCapsule, sealRedacted, type CapsuleDraft } from '../src/core/redact';
import { decodeForDetection } from '../src/core/redact-url';
import { stripInternal } from '../src/core/consolidate';

const R = '[REDACTED]';

describe('criterion 21: the sentinel is compared whole', () => {
  it.each([
    ['password=[REDACTED]hunter2', `password=${R}`],
    ['password: [REDACTED]hunter2', `password: ${R}`],
    ['{"password":"[REDACTED]hunter2"}', `{"password":"${R}"}`],
  ])('masks the tail in %s', (input, expected) => {
    const first = redactText(input);
    expect(first.text).toBe(expected);
    expect(first.count).toBe(1);
    expect(redactText(first.text).count).toBe(0); // second pass is a no-op
  });

  it.each([`password=${R}`, `{"password":"${R}"}`, `password: ${R}`, `j***@domain.com`])(
    'still skips and does not count %s',
    (input) => {
      expect(redactText(input)).toEqual({ text: input, count: 0 });
    },
  );

  it('masks a JSON body value that only starts with the sentinel', () => {
    expect(redactBody(`{"token":"${R}abc"}`).text).toBe(`{"token":"${R}"}`);
  });

  it('only a real masked email counts as masked', () => {
    expect(isMasked(R)).toBe(true);
    expect(isMasked('j***@domain.com')).toBe(true);
    expect(isMasked('***@domain.com')).toBe(true);
    expect(isMasked('x***@anything but a host')).toBe(false);
    expect(isMasked(`${R}x***@evil`)).toBe(false);
    expect(isMasked('x***@evil.com\nsecret')).toBe(false);
  });
});

describe('criterion 22: percent-encoded units scan in linear time', () => {
  const big = (unit: string, size = 200 * 1024) => unit.repeat(Math.ceil(size / unit.length));
  it.each([
    ['a%zz', 'a%zz'],
    ['a lone % in x', `${'x'.repeat(1000)}%`],
    ['%', '%'],
    ['%41', '%41'],
    ['/%', '/%'],
  ])('finishes under 1 s: %s', (_label, unit) => {
    const input = big(unit);
    const start = performance.now();
    redactText(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('still masks a percent-encoded secret unit', () => {
    expect(redactText('x=a%40b.com y').text).not.toContain('a%40b.com');
  });
});

describe('criterion 16: spacing forms', () => {
  it.each([
    ['password:hunter2', `password:${R}`],
    ['password = hunter2', `password = ${R}`],
    ['password : hunter2', `password : ${R}`],
    ['pwd:x1', `pwd:${R}`],
    ['login failed password=\thunter2 for bob', `login failed password=\t${R} for bob`],
    ['{"password" : "x"}', `{"password" : "${R}"}`],
    ['apiKey: abc123', `apiKey: ${R}`],
  ])('masks %s', (input, expected) => {
    const first = redactText(input);
    expect(first.text).toBe(expected);
    expect(redactText(first.text).count).toBe(0);
  });

  it.each([
    'Password: required',
    'password:undefined',
    'secret: null',
    'password = null',
    'author=bob',
    'keyboard: us',
    'passwordless: true',
    'x=1, password',
    'password:\nnext line',
    'a == b && token == c',
  ])('leaves %s alone', (input) => {
    expect(redactText(input)).toEqual({ text: input, count: 0 });
  });
});

describe('criterion 17: header-style lines', () => {
  it.each([
    ['Authorization: Token abc123def456', `Authorization: ${R}`],
    ['Cookie: sid=abc; other=def', `Cookie: ${R}`],
    ['Set-Cookie: a=b; Path=/; HttpOnly', `Set-Cookie: ${R}`],
    ['Proxy-Authorization: NTLM TlRMTVNTUAAB', `Proxy-Authorization: ${R}`],
    ['x-api-key: k_12345', `x-api-key: ${R}`],
    ['X-Auth-Token:abc', `X-Auth-Token:${R}`],
    ['failed. Authorization: Digest user="a", nonce="b"\nnext', `failed. Authorization: ${R}\nnext`],
  ])('masks %s', (input, expected) => {
    const first = redactText(input);
    expect(first.text).toBe(expected);
    expect(first.count).toBe(1);
    expect(redactText(first.text).count).toBe(0);
  });

  it('keeps the scheme word for Bearer and Basic and counts once', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnop12345');
    expect(out.text).toBe(`Authorization: Bearer ${R}`);
    expect(out.count).toBe(1);
    expect(redactText('Authorization: Basic dXNlcjpwYXNz').text).toBe(`Authorization: Basic ${R}`);
    expect(redactText('Authorization: Bearer abc').text).toBe(`Authorization: Bearer ${R}`);
  });

  it.each([
    'Authorization: required',
    'cookie: missing',
    'Authorization header missing',
    'my-cookie: abc',
    '"Authorization": "Bearer short"',
  ])('leaves %s alone or to other rules', (input) => {
    expect(redactText(input).text).not.toContain('[REDACTED]x');
    if (!input.startsWith('"')) expect(redactText(input).count).toBe(0);
  });
});

describe('criteria 18 and 19: colon keys and key names', () => {
  it.each([
    ['token: abcDEF123xyz', `token: ${R}`],
    ['credential: hunter2', `credential: ${R}`],
    ['authorization: foo', `authorization: ${R}`],
    ['api-key: abc', `api-key: ${R}`],
    ['Invalid token: abc123', `Invalid token: ${R}`],
  ])('masks %s', (input, expected) => {
    expect(redactText(input).text).toBe(expected);
  });

  it.each(['token: expired', 'Invalid token: expired', 'token: undefined', 'auth: true', 'auth: failed'])(
    'leaves %s',
    (input) => {
      expect(redactText(input).count).toBe(0);
    },
  );

  it('treats sid and ssn as sensitive but not pass, pin or code', () => {
    expect(redactText('/a?sid=abcdef12345&x=1').text).toBe(`/a?sid=${R}&x=1`);
    expect(redactText('ssn=123-45-6789').text).toBe(`ssn=${R}`);
    expect(redactBody('{"ssn":"123-45-6789","sid":"abc"}').text).toBe(`{"ssn":"${R}","sid":"${R}"}`);
    for (const kept of ['?code=4/0AX4', '?pin=1234', 'pass=hunter2', '{"pin":"1234"}']) {
      expect(redactText(kept).count, kept).toBe(0);
    }
  });
});

function draftWith(overrides: Record<string, unknown>): CapsuleDraft {
  return {
    pageUrl: 'https://x.com/',
    pageTitle: 't',
    userAgent: 'ua',
    viewport: { width: 1, height: 2 },
    capturedAt: '2026-10-19T00:00:00.000Z',
    console: [],
    network: [],
    element: { selector: 'a', outerHTML: '<a></a>', styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, screenshotDataUrl: 'data:image/png;base64,AAAA' },
    userNote: '',
    ...overrides,
  } as CapsuleDraft;
}

describe('criterion 23: non-string values in text fields (Q29)', () => {
  it('stringifies and redacts an object where a string is expected', () => {
    const { draft, redactionCount } = redactCapsule(draftWith({ userNote: { password: 'hunter2', ok: 1 } }));
    expect(typeof draft.userNote).toBe('string');
    expect(JSON.stringify(draft)).not.toContain('hunter2');
    expect(draft.userNote).toBe(`{"password":"${R}","ok":1}`);
    expect(redactionCount).toBe(1);
  });

  it('covers body, url and arrays too, and survives a circular value', () => {
    const circular: Record<string, unknown> = { token: 'abc123' };
    circular.self = circular;
    const out = redactCapsule(draftWith({
      pageTitle: ['password=hunter2'],
      pageUrl: { token: 'zzz999' },
      userNote: circular,
    }));
    const json = JSON.stringify(out.draft);
    for (const secret of ['hunter2', 'zzz999', 'abc123']) expect(json).not.toContain(secret);
  });

  it('leaves numbers and booleans in keep fields alone', () => {
    const { draft } = redactCapsule(draftWith({}));
    expect(draft.viewport).toEqual({ width: 1, height: 2 });
  });
});

describe('criterion 24: screenshot and PII decisions (D3, G22)', () => {
  it('D3: screenshotDataUrl is returned unchanged, only the preview warns (P7)', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(200);
    const el = draftWith({}).element;
    const { draft } = redactCapsule(draftWith({ element: { ...el, screenshotDataUrl: url } }));
    expect(draft.element?.screenshotDataUrl).toBe(url);
  });

  it('G22: card numbers, phone numbers and names are not detected (out of scope, documented)', () => {
    const text = 'card 4111 1111 1111 1111 call +1 555 010 9999 name Ann Lee';
    expect(redactText(text)).toEqual({ text, count: 0 });
  });
});

describe('Q31: autocomplete values mark an input as sensitive', () => {
  it.each(['cc-number', 'cc-csc', 'cc-exp', 'one-time-code', 'current-password', 'new-password'])(
    'masks the value of an input with autocomplete=%s',
    (token) => {
      const html = `<input name="card" autocomplete="${token}" value="4111111111111111">`;
      const out = redactHtml(html);
      expect(out.text).toBe(`<input name="card" autocomplete="${token}" value="${R}">`);
      expect(redactHtml(out.text).count).toBe(0);
    },
  );

  it('handles the section-prefixed and combined forms', () => {
    expect(redactHtml('<input autocomplete="section-pay billing cc-number" value="4111">').text).toContain(`value="${R}"`);
  });

  it('keeps pin/code names visible without the attribute (Q1) and non-sensitive autocomplete values', () => {
    for (const html of ['<input name="pin" value="1234">', '<input autocomplete="email" value="a@b">', '<input autocomplete="off" value="x">']) {
      expect(redactHtml(html).text.includes(R), html).toBe(false);
    }
  });
});

describe('criterion 25 and cleanups', () => {
  it('sealRedacted rejects a bad redactionCount', () => {
    const { draft } = redactCapsule(draftWith({}));
    const summary = { uniqueErrors: 0, totalErrors: 0, uniqueWarnings: 0, totalWarnings: 0, uniqueRequests: 0, totalRequests: 0 };
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => sealRedacted(draft, { summary, redactionCount: bad })).toThrow(RangeError);
    }
    expect(sealRedacted(draft, { summary, redactionCount: 3 }).redactionCount).toBe(3);
  });

  it('decodeOnce fallback decodes UTF-8 sequences when decodeURIComponent throws', () => {
    expect(decodeForDetection('%E2%82%AC%zz')).toBe('\u20ac%zz');
    expect(decodeForDetection('a%40b%')).toBe('a@b%');
  });

  it('stripInternal drops exactly the four internal fields and keeps the rest', () => {
    const out = stripInternal({ rawHashes: ['h'], seq: 1, touched: 2, relatedRequest: 3, requestHeaders: { a: 'b' }, count: 4 });
    expect(out).toEqual({ requestHeaders: { a: 'b' }, count: 4 });
  });
});

describe('Phase 4.2 C2 (criterion 29): a header line has no length cap', () => {
  it.each(['Cookie', 'Set-Cookie', 'Authorization', 'X-Api-Key'])('masks a 10 KB and a 100 KB %s line whole', (name) => {
    for (const size of [10_000, 100_000]) {
      const line = `${name}: ${'a=b; '.repeat(Math.ceil(size / 5))}`.trimEnd();
      const first = redactText(`GET /x\n${line}\nnext line`);
      expect(first.text).toBe(`GET /x\n${name}: ${R}\nnext line`);
      expect(first.count).toBe(1);
      expect(redactText(first.text)).toEqual({ text: first.text, count: 0 });
    }
  });
});

describe('Phase 4.2 C1 (criterion 27): quoted headers', () => {
  it.each([
    ["sent 'Authorization: Token abc123def'", `sent 'Authorization: ${R}'`],
    ['"Cookie: sid=abc123"', `"Cookie: ${R}"`],
    ['{"log":"Authorization: Token abc123def","x":2}', `{"log":"Authorization: ${R}","x":2}`],
    ['{\\"log\\":\\"Cookie: sid=1\\",\\"k\\":2}', `{\\"log\\":\\"Cookie: ${R}\\",\\"k\\":2}`],
  ])('masks %s', (input, expected) => {
    const first = redactText(input);
    expect(first.text).toBe(expected);
    expect(redactText(first.text).count).toBe(0);
  });

  it('works through redactBody and the Q29 serializer', () => {
    expect(redactBody('{"log":"Authorization: Token abc123def","x":2}').text).toBe(`{"log":"Authorization: ${R}","x":2}`);
    const { draft } = redactCapsule(draftWith({ userNote: { a: 'Authorization: Token abc' } }));
    expect(draft.userNote).toBe(`{"a":"Authorization: ${R}"}`);
  });

  it('keeps JSON keys on the key rule (count 1) and leaves look-alike names alone', () => {
    const out = redactBody('{"authorization":"Token abc","x":1}');
    expect(out).toEqual({ text: `{"authorization":"${R}","x":1}`, count: 1 });
    for (const kept of ['my-cookie: abc', 'x-cookie: abc', 'mycookie: abc']) expect(redactText(kept).count, kept).toBe(0);
  });
});

describe('Phase 4.2 M2 (criterion 28, Q32): the mask stops at the closing quote', () => {
  it.each([
    ['{"log":"see Cookie: sid=1","k":"v"}', `{"log":"see Cookie: ${R}","k":"v"}`],
    ['{"log":"Authorization: Token abc","k":1}', `{"log":"Authorization: ${R}","k":1}`],
    ['{"a":"say \\"hi\\" Cookie: x=1","k":1}', `{"a":"say \\"hi\\" Cookie: ${R}","k":1}`],
    ['{"h":"Authorization: Digest user=\\"a\\", nonce=\\"b\\"","k":1}', `{"h":"Authorization: ${R}","k":1}`],
    ['[{"m":"Cookie: a=b"},{"m":"ok"}]', `[{"m":"Cookie: ${R}"},{"m":"ok"}]`],
  ])('keeps the rest of %s', (input, expected) => {
    expect(redactBody(input).text).toBe(expected);
  });

  it('a header at the start of a line still runs to the end, quotes included', () => {
    expect(redactText('Authorization: Digest user="a", nonce="b"').text).toBe(`Authorization: ${R}`);
    expect(redactText('Cookie: a="1"; b="2"').text).toBe(`Cookie: ${R}`);
  });

  it('odd quotes in prose never leave a secret behind (unclear means end of line)', () => {
    for (const input of ['5" screen. Cookie: sid=1; b="x"', "it's odd. Authorization: Token it's secret9", 'He said "hi Cookie: sid=abc']) {
      const out = redactText(input).text;
      for (const secret of ['sid=1', 'secret9', 'sid=abc', 'x"']) expect(out.includes(secret), `${input} -> ${out}`).toBe(false);
    }
  });
});

describe('Phase 4.2 M1 (criterion 31, Q33): bad values in text fields do not crash', () => {
  const consoleEntry = (overrides: Record<string, unknown>) => ({
    level: 'error', message: 'ok', timestamp: 1, fingerprint: 'f', count: 1, lastSeen: 1, variants: 1,
    rawHashes: ['h'], seq: 1, touched: 1, ...overrides,
  });
  const networkEntry = (overrides: Record<string, unknown>) => ({
    method: 'GET', url: 'https://x.com/a', status: 500, requestHeaders: {}, timestamp: 1, fingerprint: 'f',
    count: 1, lastSeen: 1, variants: 1, rawHashes: ['h'], seq: 1, touched: 1, ...overrides,
  });

  it.each([5, null, true, 10n])('console.message = %s', (message) => {
    const { draft } = redactCapsule(draftWith({ console: [consoleEntry({ message })] }));
    expect(typeof draft.console[0]?.message).toBe('string');
  });

  it('a missing console.message and network.url become empty strings', () => {
    const { message, ...noMessage } = consoleEntry({});
    void message;
    const { url, ...noUrl } = networkEntry({});
    void url;
    const out = redactCapsule(draftWith({ console: [noMessage], network: [noUrl] })).draft;
    expect(out.console[0]?.message).toBe('');
    expect(out.network[0]?.url).toBe('');
  });

  it('numbers in optional text fields become strings, null drops them', () => {
    const out = redactCapsule(draftWith({
      network: [networkEntry({ errorText: 7, responseBody: 12, requestBody: null })],
    })).draft.network[0];
    expect(out?.errorText).toBe('7');
    expect(out?.responseBody).toBe('12');
    expect('requestBody' in (out ?? {})).toBe(false);
  });

  it('top-level numbers and null become strings, and keep fields are untouched', () => {
    const { draft } = redactCapsule(draftWith({ userNote: 5, pageTitle: null }));
    expect(draft.userNote).toBe('5');
    expect(draft.pageTitle).toBe('');
    expect(draft.viewport).toEqual({ width: 1, height: 2 });
  });

  it('still masks a secret stored as an object value with a numeric password', () => {
    const { draft } = redactCapsule(draftWith({ userNote: { password: 123456 } }));
    expect(draft.userNote).toBe(`{"password":"${R}"}`);
  });
});
