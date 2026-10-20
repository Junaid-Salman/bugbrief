import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { badgeText } from '../src/popup/capsule-state';
import { COPY } from '../src/popup/copy';
import { DEMO_SECRETS } from './helpers/demo-secrets';

const root = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const readme = root('README.md');

describe('README names the controls the popup really has', () => {
  it.each([COPY.start, COPY.stop, COPY.pick, COPY.preview, COPY.copy, COPY.download, COPY.clear])('mentions the %s label', (label) => {
    expect(readme).toContain(`**${label}**`);
  });

  it('says that the screenshot is not redacted, as the explainer does', () => {
    expect(readme).toContain('**The screenshot is not redacted.**');
  });

  it('shows the redaction count in the words the popup uses', () => {
    expect(readme).toContain(badgeText(7));
  });
});

describe('README commands and links', () => {
  it('only uses npm scripts that exist', () => {
    const scripts = (JSON.parse(root('package.json')) as { scripts: Record<string, string> }).scripts;
    const used = [...readme.matchAll(/npm run ([a-z:]+)/g)].map((match) => match[1] as string);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(scripts[name], `npm run ${name}`).toBeDefined();
  });

  it('links the demo with the seeded page token', () => {
    expect(readme).toContain(`token=${DEMO_SECRETS.urlToken}`);
  });

  it('lists every permission in the manifest', () => {
    const manifest = readFileSync(new URL('../manifest.config.ts', import.meta.url), 'utf8');
    const permissions = /permissions:\s*\[([^\]]+)\]/.exec(manifest)?.[1]?.match(/'([a-zA-Z]+)'/g) ?? [];
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) expect(readme).toContain(`\`${permission.replaceAll("'", '')}\``);
  });
});

describe('license', () => {
  it('is MIT with the owner as the copyright holder, in the file and in package.json', () => {
    expect(root('LICENSE')).toContain('Copyright (c) 2026 Junaid Salman');
    const pkg = JSON.parse(root('package.json')) as { license: string; private: boolean };
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBe(true);
  });
});
