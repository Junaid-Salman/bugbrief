/**
 * Criterion 1: the file the worker injects is one self-contained classic script. A `?script`
 * import would build an ES module behind an async loader, and a second Pick would start nothing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let out = '';
let manifest: { web_accessible_resources?: Array<{ matches: string[]; resources: string[] }> } = {};
let workerFiles: string[] = [];

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'conscribe-build-'));
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true },
  });
  manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  workerFiles = readdirSync(join(out, 'assets')).filter((name) => name.startsWith('index.ts-'));
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

function injectedPath(): string {
  const source = workerFiles.map((name) => readFileSync(join(out, 'assets', name), 'utf8')).join('\n');
  // The minifier hoists the path into a constant, so match the literal and the call separately.
  expect(/executeScript\(\{[\s\S]{0,120}?files:\[/.test(source), 'the worker must call executeScript with a files array').toBe(true);
  const match = /["'`](src\/content\/picker[^"'`]*\.js)["'`]/.exec(source);
  expect(match !== null, 'the worker must name the picker file').toBe(true);
  return match?.[1] ?? '';
}

describe('picker build output', () => {
  it('injects a single file that exists', () => {
    const file = injectedPath();
    expect(() => readFileSync(join(out, file), 'utf8')).not.toThrow();
  });

  it('is a self-contained classic script with no module loader', () => {
    const code = readFileSync(join(out, injectedPath()), 'utf8');
    expect(/\bimport\s*[{*("'`]/.test(code), 'no import statement or dynamic import').toBe(false);
    expect(/\bfrom\s*["'`]\.\.?\//.test(code), 'no relative module import').toBe(false);
    expect(code.includes('getURL'), 'no loader').toBe(false);
    expect(/\bexport\b\s*[{*d]/.test(code), 'no exports').toBe(false);
    // The shared style list is inlined, which proves imports were bundled in.
    expect(code.includes('background-color')).toBe(true);
  }, 30_000);

  it('ships no web_accessible_resources, so websites cannot detect the extension by fetching the picker (Q4)', () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
