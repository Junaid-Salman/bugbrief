/**
 * Step 1 and 2: key matching, class-change rate, run scoring, token formats and the span engine.
 *
 * Q2 vendor formats: the shapes (Stripe sk_live_/rk_live_, Slack xox[baprs]-, Google AIza + 35,
 * npm_ + 36, GitLab glpat-, GitHub github_pat_) are the stable, publicly documented ones. They
 * were NOT re-checked with WebFetch in this session; every format has a fake-token test.
 * Formats from the source spec (AKIA, gh[pousr]_) are kept as written.
 *
 * Phase 4.1 (Q28), checked 2026-10-19 against https://docs.stripe.com/keys : Stripe documents
 * pk_/rk_/sk_ with test and live modes, so sk_test_ and rk_test_ are added (pk_ is public by design).
 * NOT verified against official docs, so dropped per the plan: OpenAI sk-proj-, Anthropic sk-ant-
 * (only third-party pages found, platform.claude.com/docs/en/api/overview does not state the
 * prefix, platform.openai.com returned 403) and SendGrid SG. (the SendGrid page gives no format).
 * Long keys of those kinds are still caught by the long-run rule.
 */
import { describe, expect, it } from 'vitest';
import {
  TOKEN_FORMATS,
  TOKEN_MIN_TOTAL,
  classChangeRate,
  classifyRun,
  findTokenSpans,
  isSensitiveKey,
  splitKey,
} from '../src/core/redact/redact-rules';
import { applySpans, resolveSpans } from '../src/core/redact/redact-spans';

describe('splitKey and isSensitiveKey', () => {
  it('splits camelCase, snake_case and kebab-case', () => {
    expect(splitKey('accessToken')).toEqual(['access', 'token']);
    expect(splitKey('APIKey')).toEqual(['api', 'key']);
    expect(splitKey('x-csrf-token')).toEqual(['x', 'csrf', 'token']);
    expect(splitKey('user_password')).toEqual(['user', 'password']);
  });

  it.each([
    'token', 'key', 'apikey', 'apiKey', 'api_key', 'secret', 'password', 'passwd', 'auth', 'session',
    'sig', 'signature', 'jwt', 'credential', 'authorization', 'bearer', 'cookie', 'pwd', 'otp',
    'passcode', 'accessToken', 'refresh_token', 'idToken', 'csrftoken', 'XSRF-TOKEN', 'sessionId',
    'sessionid', 'secretKey', 'privateKey', 'clientSecret', 'x-amz-security-token', 'user[password]',
    'X-API-Key',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'author', 'keyboard', 'monkey', 'design', 'assign', 'signal', 'code', 'pass', 'pin', 'name',
    'email', 'traceparent', 'x-request-id', 'authority', 'tokenizer', 'passage', 'keys', '',
  ])('leaves %s alone', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('accepts the over-masking class on purpose', () => {
    for (const key of ['sortKey', 'cacheKey', 'primaryKey', 'keyCode', 'idempotencyKey', 'auth']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });
});

describe('classChangeRate', () => {
  it('ignores symbols and measures letter/digit/case changes', () => {
    expect(classChangeRate('aaaa')).toBe(0);
    expect(classChangeRate('aBaB')).toBe(1);
    expect(classChangeRate('a-B-a-B')).toBe(1);
    expect(classChangeRate('a')).toBe(0);
  });

  it('separates paths and slugs from secrets', () => {
    expect(classChangeRate('api-v2-organizations-list')).toBeLessThan(0.2);
    expect(classChangeRate('my-awesome-blog-post-title-2024-edition')).toBeLessThan(0.2);
    expect(classChangeRate('0123456789abcdef0123456789abcdef')).toBeLessThan(0.2);
    expect(classChangeRate('K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sFa')).toBeGreaterThan(0.35);
  });
});

describe('classifyRun', () => {
  it('masks random-looking hex and base64 runs', () => {
    expect(classifyRun('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).not.toBeNull();
    expect(classifyRun('K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sFa')).toEqual({ start: 0, end: 32 });
  });

  it('skips paths, slugs, sequential hex and short runs', () => {
    expect(classifyRun('0123456789abcdef0123456789abcdef')).toBeNull();
    expect(classifyRun('/api/v2/organizations/acme/projects/main/settings')).toBeNull();
    expect(classifyRun('my-awesome-blog-post-title-2024-edition')).toBeNull();
    expect(classifyRun('K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sF')).toBeNull();
  });

  it('finds a secret embedded behind separators', () => {
    const secret = 'K7gP2xQ9mZ4vB1nL8cR5tY3wH6jD0sFa9';
    const run = `api/v2/users/${secret}`;
    const hit = classifyRun(run);
    expect(hit && run.slice(hit.start, hit.end).includes(secret)).toBe(true);
    const trailing = classifyRun(`${secret}-v2`);
    expect(trailing && `${secret}-v2`.slice(trailing.start, trailing.end).includes(secret)).toBe(true);
  });
});

/**
 * Vendor-shaped fake tokens are assembled at runtime. A literal such as a Stripe key in source
 * trips GitHub push protection even when it is a documented example.
 */
const fake = (prefix: string, body: string): string => prefix + body;

describe('token formats', () => {
  const samples: Record<string, string> = {
    'aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
    'github-token': `ghp_${'a1B2c3D4e5'.repeat(4)}`,
    'github-pat': `github_pat_${'A1b2C3d4E5'.repeat(3)}`,
    'stripe-key': fake('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'),
    'stripe-test-secret': fake('sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'),
    'stripe-test-restricted': fake('rk_test_', '51H8abcDEFghiJKLmnoPQRstu'),
    'slack-token': fake('xoxb-', '1234567890-abcdefghij'),
    'google-api-key': `AIza${'Sy-abcdefghijklmnopqrstuvwxyz012345'.slice(0, 35)}`,
    'npm-token': `npm_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'.slice(0, 36)}`,
    'gitlab-token': fake('glpat-', 'abcdefghijklmnopqrst'),
  };

  for (const [name, token] of Object.entries(samples)) {
    it(`masks a complete ${name} token`, () => {
      const out = applySpans(`value ${token} end`, findTokenSpans(`value ${token} end`, false));
      expect(out.text).toBe('value [REDACTED] end');
      expect(out.count).toBe(1);
    });
  }

  it('masks JWTs (complete), Bearer and Basic values, and PEM blocks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    expect(applySpans(`t=${jwt}`, findTokenSpans(`t=${jwt}`, false)).text).toBe('t=[REDACTED]');
    const bearer = 'Authorization: Bearer abc123DEF456ghi789JKL';
    expect(applySpans(bearer, findTokenSpans(bearer, false)).text).toBe('Authorization: Bearer [REDACTED]');
    const basic = 'Basic dXNlcjpwYXNzd29yZDEyMw==';
    expect(applySpans(basic, findTokenSpans(basic, false)).text).toBe('Basic [REDACTED]');
    const pem = 'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nafter';
    expect(applySpans(pem, findTokenSpans(pem, false)).text).toBe('key:\n[REDACTED]\nafter');
    const cutPem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg';
    expect(applySpans(cutPem, findTokenSpans(cutPem, false)).text).toBe('[REDACTED]');
  });

  it('does not mask prose that mentions Bearer or Basic', () => {
    for (const text of ['Invalid Bearer token', 'Basic authentication is required', 'Bearer tokens expire']) {
      expect(applySpans(text, findTokenSpans(text, false)).text).toBe(text);
    }
    // With `cut`, only a Bearer word at the very end of the text is treated as a cut token.
    expect(applySpans('Invalid Bearer token in header', findTokenSpans('Invalid Bearer token in header', true)).count).toBe(0);
    expect(applySpans('Invalid Bearer token', findTokenSpans('Invalid Bearer token', true)).count).toBe(1);
  });

  it('keeps every tolerant minimum total length at 11 or less (criterion 4b)', () => {
    for (const total of Object.values(TOKEN_MIN_TOTAL)) expect(total).toBeLessThanOrEqual(11);
    // eslint-disable-next-line no-console
    console.log('tolerant minimum total lengths:', JSON.stringify(TOKEN_MIN_TOTAL));
  });

  it('leaves no secret-bearing prefix of 12 or more characters when a token is cut at every length', () => {
    const full: Record<string, string> = {
      ...samples,
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      bearer: 'Bearer abc123DEF456ghi789JKL012mno',
    };
    for (const [name, token] of Object.entries(full)) {
      for (let length = 1; length <= token.length; length++) {
        const text = `x ${token.slice(0, length)}`;
        const out = applySpans(text, findTokenSpans(text, true)).text;
        const unmasked = out.replace('x ', '').split('[REDACTED]')[0] ?? '';
        expect(unmasked.length, `${name} cut at ${length}: ${out}`).toBeLessThan(12);
      }
    }
  });

  it('applies the tolerant forms only when the field was cut', () => {
    const text = 'token eyJhbGciOiJ';
    expect(applySpans(text, findTokenSpans(text, false)).count).toBe(0);
    expect(applySpans(text, findTokenSpans(text, true)).text).toBe('token [REDACTED]');
    // Anchored to the end of the text.
    const mid = 'Invalid Bearer token, retrying later';
    expect(applySpans(mid, findTokenSpans(mid, true)).count).toBe(0);
  });

  it('has a fake-token test for every format', () => {
    for (const format of TOKEN_FORMATS) {
      if (format.fullMax > 0) expect(samples[format.name], format.name).toBeDefined();
    }
  });
});

describe('span engine', () => {
  it('keeps the outermost span and counts it once', () => {
    const text = 'abcdefghij';
    const out = applySpans(text, [
      { start: 2, end: 4, kind: 'inner' },
      { start: 1, end: 8, kind: 'outer' },
      { start: 3, end: 9, kind: 'overlap' },
    ]);
    expect(out).toEqual({ text: 'a[REDACTED]ij', count: 1 });
  });

  it('drops spans over text that is already masked', () => {
    const text = 'x [REDACTED] j***@mail.com';
    expect(resolveSpans(text, [{ start: 2, end: 12, kind: 'a' }, { start: 13, end: 26, kind: 'b' }])).toEqual([]);
  });

  it('applies replacements and handles surrogate pairs', () => {
    const text = '😀 secret 😀';
    const start = text.indexOf('secret');
    expect(applySpans(text, [{ start, end: start + 6, kind: 'x' }]).text).toBe('😀 [REDACTED] 😀');
    expect(applySpans(text, [{ start, end: start + 6, replacement: '***', kind: 'x' }]).text).toBe('😀 *** 😀');
  });

  it('returns the input untouched when there is nothing to do', () => {
    expect(applySpans('plain', [])).toEqual({ text: 'plain', count: 0 });
  });
});
