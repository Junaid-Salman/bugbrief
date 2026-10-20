/**
 * P9, Tier A: the proposal's success criteria 3 (zero leaks) and 7 (consolidation) checked on the capsule the real
 * pipeline builds from what the demo page produces. The real extension in Chrome is checked by hand
 * (docs/e2e-checklist.md). Nothing here calls an AI agent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { RawConsoleEntry } from '../src/core/types';
import { buildDemoCapsule, runDemoPage, type DemoCapsuleOptions, type DemoRun } from './helpers/demo-capsule';
import { DEMO_SECRETS } from './helpers/demo-secrets';

let run: DemoRun;
beforeAll(async () => {
  run = await runDemoPage();
}, 30_000);

function capsule(options?: DemoCapsuleOptions) {
  const built = buildDemoCapsule(run, options);
  if (!built.result.ok) throw new Error(built.result.error);
  return { ...built.result, input: JSON.stringify(built.input) };
}

describe('zero leaks (proposal §7.3)', () => {
  it('the inputs really hold every seeded secret, so the check below is not vacuous', () => {
    const { input } = capsule();
    for (const secret of [DEMO_SECRETS.urlToken, DEMO_SECRETS.bearer, DEMO_SECRETS.email, DEMO_SECRETS.csrf]) {
      expect(input, secret).toContain(secret);
    }
  });

  it('none of the seeded secrets reaches the Markdown', () => {
    const { markdown } = capsule();
    for (const secret of [...Object.values(DEMO_SECRETS), 'jane.doe']) expect(markdown, secret).not.toContain(secret);
  });

  it('never renders request headers, so the Authorization header cannot appear (this proves nothing about redaction)', () => {
    const { markdown } = capsule();
    expect(markdown).not.toMatch(/authorization/i);
    expect(markdown).not.toContain('Bearer');
  });

  it('masks the page token, the email (twice) and the form values, and reports a count above zero', () => {
    const { markdown, redactionCount } = capsule();
    expect(markdown).toContain('?token=[REDACTED]');
    expect(markdown).toContain('j***@example.com');
    expect(markdown).toContain('name="csrf" value="[REDACTED]"');
    expect(redactionCount).toBeGreaterThanOrEqual(5);
  });

  it('counts the masks of an element URL on another page too (BL-011)', () => {
    const same = capsule();
    const other = capsule({ elementPageUrl: `${new URL(run.request.url).origin}/cart?token=${DEMO_SECRETS.urlToken}` });
    expect(other.redactionCount).toBe(same.redactionCount + 1);
    expect(other.markdown).not.toContain(DEMO_SECRETS.urlToken);
  });

  it('has no "Failed to load resource" entry and no canceled request (those rules are unit tested in cdp-map)', () => {
    const { markdown } = capsule();
    expect(markdown).not.toContain('Failed to load resource');
    expect(markdown).not.toContain('ERR_ABORTED');
  });
});

describe('consolidation (proposal §7.7)', () => {
  const lookAlike = (line: number): RawConsoleEntry => ({
    level: 'error',
    message: "TypeError: Cannot read properties of undefined (reading 'x')",
    stack: `TypeError: Cannot read properties of undefined (reading 'x')\n    at pick (http://localhost:5174/shop/app.js:${line}:9)`,
    url: 'http://localhost:5174/shop/app.js',
    timestamp: Date.UTC(2026, 9, 20, 10, 15, 40),
    pageUrl: 'http://localhost:5174/',
  });

  const consoleHeadings = (markdown: string) => [...markdown.split('## Failed requests')[0]!.matchAll(/^### \d+\. (.*) \(×(\d+)\)/gm)];

  it('one error fired five times is one entry marked (×5) and flagged as high frequency', () => {
    const { markdown } = capsule({ exceptionCount: 5 });
    const headings = consoleHeadings(markdown).filter((match) => match[1]!.includes("reading 'map'"));
    expect(headings).toHaveLength(1);
    expect(headings[0]![2]).toBe('5');
    expect(markdown).toMatch(/\(×5\) · High frequency/);
  });

  it('look-alike errors at different lines stay separate, and a repeat of one merges', () => {
    const { markdown } = capsule({ extraConsole: [lookAlike(10), lookAlike(20), lookAlike(10)] });
    const separate = consoleHeadings(markdown).filter((match) => match[1]!.includes("reading 'x'"));
    expect(separate.map((match) => match[2]).sort()).toEqual(['1', '2']);
  });

  it('the summary totals equal the sum of the (×N) counts', () => {
    const { markdown } = capsule({ exceptionCount: 5, extraConsole: [lookAlike(10), lookAlike(20), lookAlike(10)] });
    const sumOfErrors = consoleHeadings(markdown).reduce((total, match) => total + Number(match[2]), 0);
    const row = /\| Errors \| (\d+) \| (\d+) \|/.exec(markdown);
    expect(Number(row?.[2])).toBe(sumOfErrors);
    expect(Number(row?.[1])).toBe(consoleHeadings(markdown).length);
    const requests = [...markdown.split('## Failed requests')[1]!.matchAll(/^### \d+\. .* → \d+ \(×(\d+)\)/gm)].reduce((total, match) => total + Number(match[1]), 0);
    expect(Number(/\| Failed requests \| \d+ \| (\d+) \|/.exec(markdown)?.[1])).toBe(requests);
  });

  it('a request failure and its console error are linked', () => {
    const { markdown } = capsule();
    expect(markdown.match(/Likely related to failed request #1\./g)).toHaveLength(1);
  });
});
