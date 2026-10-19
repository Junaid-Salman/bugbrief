/**
 * Criterion 9 (steps 1 to 7): every function that uses a regex or scanner is linear on adversarial
 * input. 3 discarded warm-up runs, then the median of 7, at 50 KB and 200 KB. The ratio must stay
 * under 8 (a quadratic scan gives about 16, a linear one about 4), plus a wall-clock bound of 1 s
 * at 200 KB. The explicit 30 000 ms timeout is needed because Vitest's default is 5 s.
 */
import { describe, expect, it } from 'vitest';
import { redactBody } from '../src/core/redact-body';
import { redactHeaders } from '../src/core/redact-headers';
import { redactHtml, redactSelector } from '../src/core/redact-html';
import { redactCapsule, type CapsuleDraft } from '../src/core/redact';
import { toConsoleEntry, toNetworkEntry } from '../src/core/consolidate';
import { FIELD } from '../src/core/limits';
import { SEED, mulberry32, randomSecret } from './helpers/secrets';
import { redactText } from '../src/core/redact-text';
import { redactUrl } from '../src/core/redact-url';

const KB = 1024;
const WARMUPS = 3;
const RUNS = 7;
const RATIO_LIMIT = 8;
const WALL_LIMIT_MS = 1000;

const ADVERSARIAL: Record<string, string> = {
  'runs of a': 'a',
  'runs of =': '=',
  'runs of @': '@',
  'runs of &': '&',
  'runs of {': '{',
  'runs of [': '[',
  'runs of eyJ': 'eyJ',
  'runs of cookie: null': 'cookie: null ',
  'runs of cookie: true': 'cookie: true ',
  'runs of Cookie:a': 'Cookie:a ',
  'runs of "Cookie: ': '"Cookie: ',
  'runs of \\"Cookie: ': '\\"Cookie: ',
  "runs of 'Authorization: ": "'Authorization: ",
  'runs of a%zz': 'a%zz',
  'runs of %': '%',
  'runs of /%': '/%',
  'lone % in x': `${'x'.repeat(1000)}%`,
  'runs of "': '"',
  'runs of ":': '":',
  'unterminated string': '{"password":"',
  'runs of Bearer ': 'Bearer ',
  'runs of xoxb-': 'xoxb-',
  'runs of ghp_': 'ghp_',
  'dash runs': 'a-',
  'slash runs': 'a/',
  'runs of ://': 'a://',
  'runs of password: ': 'password: ',
  'runs of %41': '%41',
  'runs of %40@': '%40@',
  'runs of ?a=&': '?a=&',
  'runs of <a>': '<a>x</a>',
  'runs of -----BEGIN ': '-----BEGIN ',
  'runs of ;jsessionid=': ';jsessionid=',
  'runs of a.': 'a.',
  'runs of <input value="': '<input type=password value="',
  'runs of <': '<',
  'runs of &#': '&#1',
  'runs of [a=': '[a=',
};

function build(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function time(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function measure(fn: (input: string) => unknown, input: string): number {
  for (let i = 0; i < WARMUPS; i++) fn(input);
  return median(Array.from({ length: RUNS }, () => time(() => fn(input))));
}

const FUNCTIONS: Record<string, (input: string) => unknown> = {
  redactText: (input) => redactText(input),
  'redactText (cut, stack)': (input) => redactText(input, { cut: true, stack: true }),
  redactBody: (input) => redactBody(input, { cut: true }),
  redactUrl: (input) => redactUrl(input, { cut: true }),
  redactHtml: (input) => redactHtml(input, { cut: true }),
  redactSelector: (input) => redactSelector(input),
  redactHeaders: (input) => redactHeaders({ 'x-custom': input, referer: input }, { cut: true }),
};

describe('redaction is linear on adversarial input', () => {
  for (const [fnName, fn] of Object.entries(FUNCTIONS)) {
    it(
      `${fnName}: ratio under ${RATIO_LIMIT} and under ${WALL_LIMIT_MS} ms at 200 KB`,
      () => {
        const worst: string[] = [];
        for (const [label, unit] of Object.entries(ADVERSARIAL)) {
          const small = measure(fn, build(unit, 50 * KB));
          const large = measure(fn, build(unit, 200 * KB));
          const ratio = large / Math.max(small, 0.05);
          worst.push(`${label}: ${small.toFixed(1)} ms -> ${large.toFixed(1)} ms (x${ratio.toFixed(1)})`);
          // Sub-millisecond scans are timer noise, so the ratio only applies above 5 ms.
          if (large > 5) expect(ratio, `${fnName} / ${label}`).toBeLessThan(RATIO_LIMIT);
          expect(large, `${fnName} / ${label}`).toBeLessThan(WALL_LIMIT_MS);
        }
        console.log(`${fnName}\n  ${worst.join('\n  ')}`);
      },
      30_000,
    );
  }
});

const WORST_CASE_GATE_MS = 10_000;

function filler(rng: () => number, length: number): string {
  const words = ['GET', '/api/v2/users', 'failed', 'Cannot read properties', 'undefined', '{"a":1,', 'item-', 'x_y', 'Checkout2/PaymentForm', '2026-10-19T12:00:00Z'];
  let out = '';
  while (out.length < length) {
    out += rng() < 0.15 ? randomSecret(rng, rng() < 0.5 ? 'hex' : 'base64url') : (words[Math.floor(rng() * words.length)] ?? '');
    out += ' ';
  }
  return out.slice(0, length);
}

describe('capsule-level worst case (criterion 9)', () => {
  it(
    'a capsule at the FIELD caps (about 5.2 MB) redacts under 10 s',
    () => {
      const rng = mulberry32(SEED);
      const consoleEntries = Array.from({ length: 200 }, (_, i) =>
        toConsoleEntry({
          level: 'error',
          message: `${i} ${filler(rng, FIELD.consoleMessage - 8)}`,
          stack: filler(rng, FIELD.consoleStack),
          url: `https://x.com/${filler(rng, FIELD.consoleUrl - 20).replace(/\s/g, '/')}`,
          pageUrl: `https://x.com/${filler(rng, FIELD.pageUrl - 20).replace(/\s/g, '/')}`,
          timestamp: i,
        }),
      );
      const network = Array.from({ length: 50 }, (_, i) =>
        toNetworkEntry({
          method: 'POST',
          url: `https://x.com/${i}/${filler(rng, FIELD.networkUrl - 20).replace(/\s/g, '/')}`,
          pageUrl: `https://x.com/${filler(rng, FIELD.pageUrl - 20).replace(/\s/g, '/')}`,
          status: 500,
          errorText: filler(rng, FIELD.errorText),
          requestHeaders: Object.fromEntries(Array.from({ length: FIELD.maxHeaders }, (_, h) => [`x-h${h}`, filler(rng, FIELD.headerValue)])),
          requestBody: `{"a":"${filler(rng, FIELD.requestBody - 20)}"}`,
          responseBody: `{"b":"${filler(rng, FIELD.responseBody - 20)}","n":${i}}`,
          timestamp: i,
        }),
      );
      const draft: CapsuleDraft = {
        pageUrl: 'https://x.com/', pageTitle: 't', userAgent: 'ua', viewport: { width: 1, height: 1 },
        capturedAt: 'now', console: consoleEntries, network,
        element: { selector: 'div', outerHTML: `<div>${filler(rng, 200_000)}</div>`, styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, screenshotDataUrl: '' },
      };
      const bytes = JSON.stringify(draft).length;
      const start = performance.now();
      const { redactionCount } = redactCapsule(draft);
      const elapsed = performance.now() - start;
      console.log(`capsule worst case: ${(bytes / 1e6).toFixed(1)} MB redacted in ${(elapsed / 1000).toFixed(2)} s, ${redactionCount} masks (gate ${WORST_CASE_GATE_MS / 1000} s, dev-machine target about 5 s)`);
      expect(bytes).toBeGreaterThan(4_000_000);
      expect(elapsed).toBeLessThan(WORST_CASE_GATE_MS);
    },
    30_000,
  );
});
