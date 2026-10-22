/** P10.1: the product is called Conscribe. No tracked file outside tests/ may still use the old name. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const OLD = ['bug', 'brief'].join('');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.startsWith('tests/') && !/\.(png|jpe?g|gif|ico|webp)$/i.test(file) && file !== 'package-lock.json');

/** Files that may keep the old name: the local-only promo pipeline path in the demo script. */
const ALLOWED = [/^docs\/demo-script\.md$/];

describe('product name', () => {
  it('is not the old name in any tracked text file (case-insensitive)', () => {
    const hits = tracked
      .filter((file) => !ALLOWED.some((pattern) => pattern.test(file)))
      .filter((file) => new RegExp(OLD, 'i').test(readFileSync(new URL(file, root), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('is Conscribe in the manifest, the package and the popup title', () => {
    expect(readFileSync(new URL('manifest.config.ts', root), 'utf8')).toContain("name: 'Conscribe'");
    expect(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).name).toBe('conscribe');
    expect(readFileSync(new URL('src/popup/index.html', root), 'utf8')).toContain('<title>Conscribe</title>');
  });

  it('points package.json at the renamed repository', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    expect(pkg.repository.url).toBe('git+https://github.com/Junaid-Salman/conscribe.git');
    expect(pkg.bugs.url).toBe('https://github.com/Junaid-Salman/conscribe/issues');
  });

  it('names the zip after the product', () => {
    expect(readFileSync(new URL('scripts/package.mjs', root), 'utf8')).toContain('`conscribe-${manifest.version}.zip`');
  });
});
