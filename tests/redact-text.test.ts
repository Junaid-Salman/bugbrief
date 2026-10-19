/** Steps 3 to 7: URLs, JSON, bodies, free text and headers. */
import { describe, expect, it } from 'vitest';
import { redactBody } from '../src/core/redact-body';
import { redactHeaders } from '../src/core/redact-headers';
import { jsonSpans } from '../src/core/redact-json';
import { redactText } from '../src/core/redact-text';
import { redactUrl, urlSpans } from '../src/core/redact-url';
import { applySpans } from '../src/core/redact-spans';

const R = '[REDACTED]';

describe('redactUrl', () => {
  it('masks sensitive query values and leaves author/keyboard/design alone', () => {
    expect(redactUrl('https://x.com/a?token=abc&author=bob&keyboard=us&design=1').text).toBe(
      `https://x.com/a?token=${R}&author=bob&keyboard=us&design=1`,
    );
    expect(redactUrl('https://x.com/a?apiKey=k1&session_id=s1&X-Amz-Signature=zz').text).toBe(
      `https://x.com/a?apiKey=${R}&session_id=${R}&X-Amz-Signature=${R}`,
    );
  });

  it('handles repeated keys, bare keys, + as space, &amp; and percent-encoded keys', () => {
    expect(redactUrl('/a?token=1&token=2').text).toBe(`/a?token=${R}&token=${R}`);
    expect(redactUrl('/a?token&x=1').text).toBe('/a?token&x=1');
    expect(redactUrl('/a?x=1&amp;token=zz').text).toBe(`/a?x=1&amp;token=${R}`);
    expect(redactUrl('/a?%74oken=zz').text).toBe(`/a?%74oken=${R}`);
    expect(redactUrl('/a?api+key=zz').text).toBe(`/a?api+key=${R}`);
  });

  it('masks fragment parameters and SPA route queries', () => {
    expect(redactUrl('https://x.com/cb#access_token=abc&state=ok').text).toBe(
      `https://x.com/cb#access_token=${R}&state=ok`,
    );
    expect(redactUrl('https://x.com/#/reset?token=abc&x=1').text).toBe(`https://x.com/#/reset?token=${R}&x=1`);
  });

  it('masks the password in user info, scheme-less and protocol-relative URLs', () => {
    expect(redactUrl('postgres://admin:hunter2@db.local/app').text).toBe(`postgres://admin:${R}@db.local/app`);
    expect(redactUrl('//cdn.x.com/a?sig=zz').text).toBe(`//cdn.x.com/a?sig=${R}`);
    expect(redactUrl('example.com/a?secret=zz').text).toBe(`example.com/a?secret=${R}`);
    expect(redactUrl('localhost:3000/reset/Zk3jD9aQ2mP1xYvB8nL4').text).toBe(`localhost:3000/reset/${R}`);
  });

  it('masks ;jsessionid= path parameters (Q10)', () => {
    expect(redactUrl('https://x.com/app;jsessionid=ABC123DEF/page?x=1').text).toBe(
      `https://x.com/app;jsessionid=${R}/page?x=1`,
    );
  });

  it('masks long data: payloads as a whole', () => {
    const url = `data:image/png;base64,${'iVBORw0KGgo'.repeat(10)}`;
    expect(redactUrl(url).text).toBe(`data:image/png;base64,${R}`);
    expect(redactUrl('data:text/plain,hi').text).toBe('data:text/plain,hi');
  });

  it('masks query values that decode to a secret, and nothing else (Q7)', () => {
    expect(redactUrl('/a?email=jane%40example.com&n=1').text).toBe(`/a?email=${R}&n=1`);
    expect(redactUrl('/a?next=%2Fhome').text).toBe('/a?next=%2Fhome');
    expect(redactUrl('/a?redirect=https%253A%252F%252Fx.com%253Ftoken%253Dabc').text).toBe(`/a?redirect=${R}`);
  });

  describe('path-segment rule (Q6, Q12)', () => {
    it.each(['/auth/login', '/auth/callback', '/token/refresh', '/verify/email', '/confirm/settings',
      '/auth/google-oauth2-callback', '/confirm/order-2024-details', '/verify/confirmation-email-sent'])(
      'leaves %s alone',
      (path) => {
        expect(redactUrl(`https://x.com${path}`).text).toBe(`https://x.com${path}`);
      },
    );

    it.each([
      ['/reset/Zk3jD9aQ2mP1xYvB8nL4', `/reset/${R}`],
      ['/invite/a8Fk2LmQ9xZ3vB7nT1cR', `/invite/${R}`],
      ['/verify/9f86d081884c7d65', `/verify/${R}`],
      ['/reset/AbCdEfGhIjKlMnOpQr', `/reset/${R}`],
      ['/reset/123e4567-e89b-12d3-a456-426614174000', `/reset/${R}`],
    ])('masks %s', (path, expected) => {
      expect(redactUrl(`https://x.com${path}`).text).toBe(`https://x.com${expected}`);
    });
  });

  it.each(['/reset-password/', '/password-reset/', '/verify-email/', '/accept-invitation/'])(
    'the path rule alone selects the token after %s',
    (prefix) => {
      const token = 'Zk3jD9aQ2mP1xYvB';
      const url = `https://x.com${prefix}${token}`;
      expect(urlSpans(url).map((span) => url.slice(span.start, span.end))).toEqual([token]);
      // The window around a 16-character token can also swallow adjacent path words (class 3).
      expect(redactUrl(url).text).not.toContain(token);
    },
  );

  it('keeps dashed UUIDs elsewhere in a path', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    for (const path of [`/users/${id}`, `/api/v2/orders/${id}/items/${id}`, `/a-b-${id}`]) {
      expect(redactUrl(`https://x.com${path}`).text).toBe(`https://x.com${path}`);
    }
  });
});

describe('JSON scanner', () => {
  it('masks values of sensitive keys and keeps every other byte', () => {
    const text = '{ "user": "ann", "password" : "hunter2", "n": 12345678901234567890, "nested": {"apiKey": "k"} }';
    expect(redactBody(text).text).toBe(
      `{ "user": "ann", "password" : "${R}", "n": 12345678901234567890, "nested": {"apiKey": "${R}"} }`,
    );
  });

  it('masks numbers, literals, objects and arrays whole', () => {
    expect(redactBody('{"pin":1,"otp":123456,"secret":true,"token":null}').text).toBe(
      `{"pin":1,"otp":"${R}","secret":"${R}","token":"${R}"}`,
    );
    expect(redactBody('{"credential":{"a":[1,{"b":"}"}],"c":"x"},"ok":1}').text).toBe(`{"credential":"${R}","ok":1}`);
    expect(redactBody('{"session":["a","b"],"ok":1}').text).toBe(`{"session":"${R}","ok":1}`);
  });

  it('decodes escaped keys and handles escaped quotes in values', () => {
    expect(redactBody('{"pass\\u0077ord":"x"}').text).toBe(`{"pass\\u0077ord":"${R}"}`);
    expect(redactBody('{"token":"a\\"b\\\\"}').text).toBe(`{"token":"${R}"}`);
    expect(redactBody('{"api\\/key":"x"}').text).toBe(`{"api\\/key":"${R}"}`);
  });

  it('handles double-encoded JSON inside a string', () => {
    const text = '{"payload":"{\\"password\\":\\"hunter2\\",\\"n\\":1}"}';
    const out = redactBody(text).text;
    expect(out).not.toContain('hunter2');
    expect(out).toContain('\\"n\\":1');
  });

  it('works on XSSI, BOM, NDJSON and JSONP bodies', () => {
    expect(redactBody(')]}\',\n{"token":"abc"}').text).toBe(`)]}',\n{"token":"${R}"}`);
    expect(redactBody('﻿{"token":"abc"}').text).toBe(`﻿{"token":"${R}"}`);
    expect(redactBody('{"token":"a"}\n{"token":"b"}').text).toBe(`{"token":"${R}"}\n{"token":"${R}"}`);
    expect(redactBody('cb({"token":"abc"});').text).toBe(`cb({"token":"${R}"});`);
  });

  it('handles a body cut inside a key, inside a value and right after a colon', () => {
    expect(redactBody('{"ok":1,"pass').text).toBe('{"ok":1,"pass');
    expect(redactBody('{"ok":1,"password":"hunt').text).toBe(`{"ok":1,"password":"${R}`);
    expect(redactBody('{"ok":1,"password":').text).toBe('{"ok":1,"password":');
    expect(redactBody('{"ok":1,"password":{"a":[1,2').text).toBe(`{"ok":1,"password":"${R}"`);
  });

  it('survives deep nesting without recursion', () => {
    const depth = 200_000;
    const text = `{"token":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(redactBody(text).text).toBe(`{"token":"${R}"}`);
  });

  it('is idempotent', () => {
    const once = redactBody('{"password":"x","token":5,"o":{"secret":{"a":1}}}').text;
    const twice = redactBody(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });

  it('leaves clean JSON and empty bodies alone', () => {
    expect(redactBody('{"author":"Ann","keyboard":"us"}').text).toBe('{"author":"Ann","keyboard":"us"}');
    expect(redactBody('').text).toBe('');
    expect(jsonSpans('no pairs here')).toEqual([]);
  });

  it('matches JSON.parse for generated documents (differential, fixed seed)', () => {
    let seed = 7;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const keys = ['user', 'password', 'accessToken', 'a', 'api_key', 'author', 'kéy', '__proto__', 'secret', 'n'];
    const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)] as T;
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 4 || r < 0.35) return pick(['x', 'a\"b', 'café 😀', 12, 1.5, true, null, 'tab\there']);
      if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 3) }, () => value(depth + 1));
      const entries = Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(keys), value(depth + 1)] as const);
      return Object.fromEntries(entries.filter(([k]) => k !== '__proto__'));
    };
    // Expected output: walk the parsed document and mask sensitive-key values, then compare the
    // re-serialized masked text with the scanner's output after both go through JSON.parse.
    const sensitive = new Set(['password', 'accessToken', 'api_key', 'secret']);
    const mask = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(mask);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, sensitive.has(k) ? (x === '' ? x : R) : mask(x)]),
        );
      }
      return v;
    };
    for (let i = 0; i < 200; i++) {
      const doc = value(0);
      const text = JSON.stringify(doc);
      const out = redactBody(text).text;
      const parsed = JSON.parse(out) as unknown;
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(normalize(mask(JSON.parse(text)))));
    }
    function normalize(v: unknown): unknown {
      // Non-string sensitive values become the string mask in the scanner output.
      return v;
    }
  });

  it('never leaks a complete sensitive value for any prefix of a document (criterion 4a)', () => {
    const doc = JSON.stringify({
      user: 'ann',
      password: 'hunter2-hunter2',
      nested: { apiKey: 'AbCdEf123456', list: [{ token: 'tok-9876543210' }] },
      note: 'plain text value',
    });
    const secrets = ['hunter2-hunter2', 'AbCdEf123456', 'tok-9876543210'];
    for (let length = 1; length <= doc.length; length++) {
      const prefix = doc.slice(0, length);
      const out = redactBody(prefix, { cut: true }).text;
      for (const secret of secrets) {
        if (prefix.includes(`${secret}"`)) expect(out, `${length}`).not.toContain(secret);
      }
      // No non-sensitive byte changes: removing the mask markers leaves a prefix of the original.
      expect(out.replace(/\[REDACTED\]"?/g, '')).toBe(prefix.replace(/"(password|apiKey|token)":"[^"]*"?/g, '"$1":"').replace(/"(password|apiKey|token)":"/g, '"$1":"'));
    }
  });
});

describe('redactText', () => {
  it('masks key=value and quoted key/value pairs (Q3)', () => {
    expect(redactText('login failed password=hunter2 user=ann').text).toBe(`login failed password=${R} user=ann`);
    expect(redactText('sent {"password":"x"} and {\'token\': \'y\'}').text).toBe(
      `sent {"password":"${R}"} and {'token': '${R}'}`,
    );
    // Phase 4.1 (Q27): a Cookie line is masked to the end of the line, not just the first key.
    expect(redactText('cookie: session=abc123; Path=/').text).toBe(`cookie: ${R}`);
  });

  it('masks key: value only for the strict list, with a status-word stop-list (Q8)', () => {
    expect(redactText('password: hunter').text).toBe(`password: ${R}`);
    expect(redactText('Config { secret: abc123 }').text).toBe(`Config { secret: ${R} }`);
    for (const text of ['Password: required', 'secret: undefined', 'auth: true', 'Each child should have a unique key prop']) {
      expect(redactText(text).text).toBe(text);
    }
  });

  it('masks emails as j***@domain.com', () => {
    expect(redactText('mail jane.doe@example.com now').text).toBe('mail j***@example.com now');
    expect(redactText('ab@example.com').text).toBe('***@example.com');
    expect(redactText('pkg@1.2.3 and @scope/name').text).toBe('pkg@1.2.3 and @scope/name');
  });

  it('masks percent-encoded units that decode to a secret (Q7)', () => {
    expect(redactText('sent jane%40example.com ok').text).toBe(`sent ${R} ok`);
    expect(redactText('body password%3Dhunter2 end').text).toBe(`body ${R} end`);
    expect(redactText('plain %20 spaces%21').text).toBe('plain %20 spaces%21');
  });

  it('masks several secrets in one string', () => {
    const out = redactText('a ghp_' + 'a1B2c3D4e5'.repeat(4) + ' b AKIAIOSFODNN7EXAMPLE c jo@x.org');
    expect(out.count).toBe(3);
    expect(out.text).toBe(`a ${R} b ${R} c ***@x.org`.replace('***@x.org', '***@x.org'));
  });

  it('masks URLs embedded in console text', () => {
    expect(redactText('GET https://api.x.com/v1?token=abc failed').text).toBe(`GET https://api.x.com/v1?token=${R} failed`);
    expect(redactText('open (https://x.com/reset/Zk3jD9aQ2mP1xYvB8nL4)').text).toBe(`open (https://x.com/reset/${R})`);
  });

  it('protects stack frame paths but redacts frame query strings (G13)', () => {
    const sha = 'a'.repeat(0) + '3f9a1c2b4d5e6f708192a3b4c5d6e7f8a9b0c1d2';
    const stack = `Error: x\n    at fn (https://cdn.x.com/${sha}/app.js?token=abc123:10:5)\n    at main.3f9a1c2b4d5e6f708192a3b4c5d6e7f8.js:142:18`;
    const out = redactText(stack, { stack: true }).text;
    expect(out).toContain(sha);
    expect(out).toContain('main.3f9a1c2b4d5e6f708192a3b4c5d6e7f8.js:142:18');
    expect(out).not.toContain('abc123');
  });

  it('is idempotent and counts nothing on a second pass', () => {
    const once = redactText('password=x jo@x.org eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh').text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });

  it('does not count literal mask text', () => {
    expect(redactText(`token=${R} and j***@x.org`).count).toBe(0);
  });
});

describe('redactHeaders', () => {
  it('masks the fixed list case-insensitively and counts each', () => {
    const { headers, count } = redactHeaders({
      Authorization: 'Bearer abc', Cookie: 'a=b', 'Set-Cookie': 'a=b', 'X-API-Key': 'k',
      'x-auth-token': 't', 'Proxy-Authorization': 'Basic x', Accept: 'application/json',
    });
    expect(headers).toEqual({
      Authorization: R, Cookie: R, 'Set-Cookie': R, 'X-API-Key': R, 'x-auth-token': R,
      'Proxy-Authorization': R, Accept: 'application/json',
    });
    expect(count).toBe(6);
  });

  it('masks pattern headers and secrets inside custom headers', () => {
    const { headers } = redactHeaders({
      'x-csrf-token': 'abc', 'x-session-id': 's', 'x-amz-security-token': 't',
      'x-custom': 'mail jane@example.com', 'x-jwt-ish': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh',
    });
    expect(headers['x-csrf-token']).toBe(R);
    expect(headers['x-session-id']).toBe(R);
    expect(headers['x-amz-security-token']).toBe(R);
    expect(headers['x-custom']).toBe('mail j***@example.com');
    expect(headers['x-jwt-ish']).toBe(R);
  });

  it('exempts tracing ids from the long-run rule and sends URL headers through the URL rules', () => {
    const trace = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const { headers } = redactHeaders({
      traceparent: trace,
      'x-request-id': 'K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sFa',
      referer: 'https://x.com/a?token=abc',
    });
    expect(headers.traceparent).toBe(trace);
    expect(headers['x-request-id']).toBe('K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sFa');
    expect(headers.referer).toBe(`https://x.com/a?token=${R}`);
  });

  it('applies the cut forms to values at the 256-character cap', () => {
    const cut = 'x'.repeat(240) + ' eyJhbGciOiJIUzI1NiJ9.eyJz';
    expect(cut.length).toBeGreaterThanOrEqual(256);
    expect(redactHeaders({ 'x-note': cut.slice(0, 256) }).headers['x-note']).toContain(R);
    expect(redactHeaders({ 'x-note': 'short eyJhbGciOi' }).headers['x-note']).toBe('short eyJhbGciOi');
    expect(redactHeaders({ 'x-note': 'short eyJhbGciOi' }, { cut: true }).headers['x-note']).toBe(`short ${R}`);
  });

  it('is idempotent', () => {
    const once = redactHeaders({ authorization: 'x', other: 'jo@x.org' }).headers;
    const twice = redactHeaders(once);
    expect(twice.headers).toEqual(once);
    expect(twice.count).toBe(0);
  });
});

describe('applySpans sanity for the scanner', () => {
  it('JSON spans never overlap after resolution', () => {
    const spans = jsonSpans('{"password":"a","x":{"token":"b"}}');
    expect(applySpans('{"password":"a","x":{"token":"b"}}', spans).count).toBe(2);
  });
});
