/**
 * Criteria 2 and 3: the false-positive corpus and the generated positive corpus.
 * Secrets come from a fixed seed (mulberry32). Measured rates are printed so thresholds can be
 * re-tuned at the step-7 checkpoint.
 */
import { describe, expect, it } from 'vitest';
import { redactBody } from '../src/core/redact/redact-body';
import { redactHeaders } from '../src/core/redact/redact-headers';
import { redactText } from '../src/core/redact/redact-text';
import { redactUrl } from '../src/core/redact/redact-url';
import {
  SEED,
  longestSurvivingFragment,
  mulberry32,
  randomSecret,
  randomToken,
  randomUuid,
  type SecretKind,
} from './helpers/secrets';

const SHA40 = '3f9a1c2b4d5e6f708192a3b4c5d6e7f8a9b0c1d2';

const NEGATIVE_TEXT = [
  '?author=bob', '{"author":"Ann"}', 'keyboard', 'monkey', 'design', 'assign', 'signal',
  '/api/v2/organizations/acme/projects/main/settings',
  './components/Checkout2/PaymentForm',
  'my-awesome-blog-post-title-2024-edition',
  'internationalization2ConfigurationManagerFactory',
  '0123456789abcdef0123456789abcdef',
  '123e4567-e89b-12d3-a456-426614174000',
  'at render (main.3f9a1c2b4d5e6f708192a3b4c5d6e7f8.js:142:18)',
  `at f (https://cdn.example.com/build/${SHA40}/app.js:10:5)`,
  '/assets/chunks/vendor-abcdef0123456789abcdef0123456789.js',
  'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  'x-request-id: 8c1f0e2a-0b0a-4d6e-9c1e-0a1b2c3d4e5f',
  '2026-10-19T12:34:56.789Z', '2026-10-19T12:34:56Z',
  "Cannot read properties of undefined (reading 'map')",
  'sk-learn-intro-guide-2024',
  'Password: required', 'secret: undefined', 'Invalid Bearer token',
  'Warning: Each child in a list should have a unique "key" prop.',
  'auth: true', 'window.sessionStorage.getItem', 'Failed to load resource: the server responded with a status of 404',
  '<script src="/a.js" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" crossorigin>',
  'https://example.com/auth/login', 'https://example.com/auth/callback',
  'https://example.com/token/refresh', 'https://example.com/verify/email',
  'https://example.com/confirm/settings', 'https://example.com/auth/google-oauth2-callback',
  'https://example.com/confirm/order-2024-details', 'https://example.com/verify/confirmation-email-sent',
  'https://example.com/static/js/main.3f9a1c2b4d5e6f708192a3b4c5d6e7f8.chunk.js',
  'https://fonts.example.com/s/inter-v12-latin-regular-0123456789abcdef.woff2',
  'GET /users/123e4567-e89b-12d3-a456-426614174000/orders 200 OK',
];

describe('negative corpus (criterion 2)', () => {
  it.each(NEGATIVE_TEXT)('leaves %s untouched in console text', (input) => {
    expect(redactText(input, { stack: input.startsWith('at ') }).text).toBe(input);
  });

  it.each(NEGATIVE_TEXT.filter((t) => /^(https?:|\/|\.\/|\?)/.test(t)))('leaves %s untouched as a URL field', (input) => {
    expect(redactUrl(input).text).toBe(input);
  });

  it('leaves tracing headers untouched', () => {
    const headers = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-request-id': '8c1f0e2a0b0a4d6e9c1e0a1b2c3d4e5f8c1f0e2a',
      etag: 'W/"33a64df551425fcc55e4d42a148795d9f25f89d4"',
    };
    expect(redactHeaders(headers).headers).toEqual(headers);
  });

  it('keeps dashed UUID paths visible: 0 of 2 000 seeded paths masked', () => {
    const rng = mulberry32(SEED);
    let masked = 0;
    for (let i = 0; i < 2000; i++) {
      const id = randomUuid(rng);
      const paths = [
        `https://api.example.com/users/${id}`,
        `https://api.example.com/api/v2/orders/${id}/items/${randomUuid(rng)}`,
        `https://api.example.com/a-b-${id}`,
      ];
      for (const url of paths) if (redactUrl(url).count > 0 || redactText(url).count > 0) masked += 1;
    }
    console.log(`dashed UUID paths masked: ${masked} of ${2000 * 3}`);
    expect(masked).toBe(0);
  });

  it('masks the accepted over-masking class on purpose', () => {
    expect(redactText('{"key":"cart"}').count).toBe(1);
    expect(redactBody('{"auth":true,"sortKey":"name"}').count).toBe(2);
    expect(redactText('id 0123456789abcdef0123456789abcdef'.replace('0123456789abcdef0123456789abcdef', '9f86d081884c7d659a2feaa0c55ad015')).count).toBe(1);
    expect(redactText('digest 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae').count).toBe(1);
    expect(redactText('/token/RefreshTokenHandlerService').count).toBe(0 + redactUrl('/token/RefreshTokenHandlerService').count);
  });
});

const KINDS: SecretKind[] = ['hex', 'base64', 'base64url', 'aws'];
const SAMPLES = 2000;
const PER_TEMPLATE = 572; // 7 templates x 572 = 4 004 samples per bucket (>= 2 000)

function masked(secret: string, output: string): boolean {
  return !output.includes(secret) && longestSurvivingFragment(secret, output) < 12;
}

describe('positive corpus (criterion 3)', () => {
  for (const kind of KINDS) {
    it(`masks at least 99.5% of random ${kind} secrets`, () => {
      const rng = mulberry32(SEED + KINDS.indexOf(kind));
      let hits = 0;
      let exact32Total = 0;
      let exact32Hits = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const secret = randomSecret(rng, kind);
        if (masked(secret, redactText(`value ${secret} end`).text)) hits += 1;
      }
      if (kind !== 'aws') {
        for (let i = 0; i < SAMPLES; i++) {
          const secret = randomSecret(rng, kind, 32);
          exact32Total += 1;
          if (masked(secret, redactText(`value ${secret} end`).text)) exact32Hits += 1;
        }
      }
      const rate = (hits / SAMPLES) * 100;
      console.log(
        `${kind}: ${rate.toFixed(2)}% masked of ${SAMPLES}` +
          (exact32Total ? `; exactly 32 characters: ${((exact32Hits / exact32Total) * 100).toFixed(2)}%` : ''),
      );
      expect(rate).toBeGreaterThanOrEqual(99.5);
    });
  }

  const TEMPLATES: Array<[string, (s: string) => string]> = [
    ['api path', (s) => `GET /api/v2/users/${s}`],
    ['dash prefix', (s) => `a-b-${s}`],
    ['underscore prefix', (s) => `x_${s}`],
    ['dash suffix', (s) => `${s}-v2`],
    ['underscore suffix', (s) => `${s}_final`],
    ['slash suffix', (s) => `${s}/v2`],
    ['nine separators', (s) => `a-b-c-d-e-f-g-h-i-${s}`],
  ];

  for (const [label, lo, hi, gate] of [
    ['40 to 64 characters', 40, 64, 99.5],
    ['32 to 39 characters', 32, 39, 99],
  ] as const) {
    for (const kind of ['hex', 'base64', 'base64url'] as const) {
      it(`masks embedded ${kind} secrets of ${label} at ${gate}% or better`, () => {
        const rng = mulberry32(SEED + 100 + lo + KINDS.indexOf(kind));
        const lines: string[] = [];
        let hits = 0;
        let total = 0;
        for (const [name, wrap] of TEMPLATES) {
          let templateHits = 0;
          for (let i = 0; i < PER_TEMPLATE; i++) {
            const length = lo + Math.floor(rng() * (hi - lo + 1));
            const secret = randomSecret(rng, kind, length);
            total += 1;
            if (masked(secret, redactText(wrap(secret)).text)) {
              hits += 1;
              templateHits += 1;
            }
          }
          lines.push(`${name} ${templateHits}/${PER_TEMPLATE}`);
        }
        const rate = (hits / total) * 100;
        console.log(`embedded ${kind} ${label}: ${rate.toFixed(2)}% of ${total} (${lines.join(', ')})`);
        expect(rate).toBeGreaterThanOrEqual(gate);
      });
    }
  }

  it('masks 16 to 31 character path tokens after a secret word at 99% or better', () => {
    const rng = mulberry32(SEED + 900);
    for (const kind of ['hex', 'base64url'] as const) {
      let hits = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const length = 16 + Math.floor(rng() * 16);
        const token = randomToken(rng, kind, length);
        const word = ['reset', 'invite', 'verify', 'reset-password', 'accept-invitation'][i % 5];
        const url = `https://example.com/${word}/${token}`;
        if (!redactUrl(url).text.includes(token)) hits += 1;
      }
      const rate = (hits / SAMPLES) * 100;
      console.log(`path token ${kind} (16 to 31): ${rate.toFixed(2)}%`);
      expect(rate).toBeGreaterThanOrEqual(99);
    }
    const noDigit = redactUrl('https://example.com/reset/AbCdEfGhIjKlMnOpQrSt');
    expect(noDigit.text).toBe('https://example.com/reset/[REDACTED]');
  });

  it('masks dashless UUIDs, AWS secret keys and JWTs', () => {
    expect(redactText('id 123e4567e89b12d3a456426614174000').count).toBe(1);
    expect(redactText('aws_secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').count).toBe(1);
    expect(redactText('/reset/' + randomToken(mulberry32(1), 'base64url', 43)).count).toBe(1);
  });
});
