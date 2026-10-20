import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPackage } from '../scripts/package.mjs';

const manifest = { icons: { 16: 'icons/icon-16.png', 128: 'icons/icon-128.png' } };
const good = ['manifest.json', 'icons/icon-16.png', 'icons/icon-128.png', 'assets/popup.js'];
const text = () => 'const a = 1;';

describe('checkPackage', () => {
  it('accepts a clean package', () => {
    expect(checkPackage(good, manifest, text)).toEqual([]);
  });
  it('flags a missing manifest, a missing icon, source maps and hidden files', () => {
    expect(checkPackage(['icons/icon-16.png'], manifest, text).join(' ')).toMatch(/manifest.json is missing[\s\S]*icon-128/);
    expect(checkPackage([...good, 'assets/a.js.map'], manifest, text)[0]).toMatch(/Source maps/);
    expect(checkPackage([...good, '.DS_Store'], manifest, text)[0]).toMatch(/Hidden/);
  });
  it('flags remote code: script tag, dynamic import, importScripts, custom CSP', () => {
    expect(checkPackage([...good, 'a.html'], manifest, () => '<script src="https://cdn.x/y.js"></script>')[0]).toMatch(/remote/);
    expect(checkPackage(good, manifest, () => 'import("https://x/y.js")').join()).toMatch(/remote/);
    expect(checkPackage(good, manifest, () => 'importScripts("https://x/y.js")').join()).toMatch(/remote/);
    expect(checkPackage(good, { ...manifest, content_security_policy: {} }, text).join()).toMatch(/content_security_policy/);
  });
  it('does not flag plain https strings that are not loaded as code', () => {
    expect(checkPackage(good, manifest, () => 'const url = "https://github.com/Junaid-Salman/bugbrief";')).toEqual([]);
  });
});

describe('versions', () => {
  it('keeps manifest.config.ts and package.json on the same version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const manifest = readFileSync(new URL('../manifest.config.ts', import.meta.url), 'utf8');
    expect(/version:\s*'([^']+)'/.exec(manifest)?.[1]).toBe(pkg.version);
  });
  it('exposes the package and store:check scripts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.package).toBe('node scripts/package.mjs');
    expect(pkg.scripts['store:check']).toBe('node scripts/package.mjs check');
  });
});
