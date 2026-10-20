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

describe('README Testing section and the manual checklist (P9)', () => {
  const checklist = root('docs/e2e-checklist.md');

  it('has a Testing section that links the checklist and says no AI agent is run', () => {
    expect(readme).toContain('## Testing');
    expect(readme).toContain('docs/e2e-checklist.md');
    expect(readme).toContain('Capsule sufficiency (no AI agent run)');
    expect(readme).toContain('No test runs an AI agent');
  });

  it('never claims that an agent passed', () => {
    expect(readme).not.toMatch(/agent (fixed|fixes|passed|passes) the (bugs|demo)/i);
  });

  it('lists every proposal success criterion in the results table, and marks the agent one as indirect', () => {
    for (const label of ['1. A coding agent can fix', '2. Capture completeness', '3. Zero leaks', '4. Signal only', '5. Resilience', '6. Quality gates', '7. Consolidation']) {
      expect(checklist, label).toContain(label);
    }
    expect(checklist).toContain('**Indirect.**');
  });

  it('only uses npm scripts that exist', () => {
    const scripts = (JSON.parse(root('package.json')) as { scripts: Record<string, string> }).scripts;
    const used = [...checklist.matchAll(/npm run ([a-z:]+)/g)].map((match) => match[1] as string);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(scripts[name], `npm run ${name}`).toBeDefined();
  });

  it('names the popup labels it asks you to click', () => {
    for (const label of [COPY.start, COPY.stop, COPY.pick, COPY.preview, COPY.copy, COPY.download, COPY.clear]) expect(checklist, label).toContain(`**${label}**`);
  });

  it('checks for each demo secret by value, so the leak step is mechanical', () => {
    for (const secret of [DEMO_SECRETS.urlToken, DEMO_SECRETS.bearer, DEMO_SECRETS.emailLocal, DEMO_SECRETS.csrf]) expect(checklist, secret).toContain(secret);
  });

  it('does not point at local-only files', () => {
    for (const local of ['BACKLOG.md', 'Plans/', 'Reviews/', 'Project Files/']) expect(checklist, local).not.toContain(local);
  });
});

describe('what the README says about data and redaction (P10, store policy)', () => {
  it('uses the canonical redaction sentence', () => {
    expect(readme).toContain('BugBrief masks secrets it recognizes, such as tokens, keys, passwords and email addresses. It can miss others, and the screenshot is not masked, so read the report before you share it.');
  });

  it('names what is read, says it stays on the device, and carries the Limited Use statement', () => {
    expect(readme).toContain('**What BugBrief reads.**');
    for (const kind of ['page content', 'a screenshot of it', 'the addresses (URLs)', 'requests and responses', 'console messages', 'personal data', 'sign-in tokens', 'never sent anywhere']) {
      expect(readme, kind).toContain(kind);
    }
    expect(readme).toContain('**Limited Use.**');
    expect(readme).toContain('Chrome Web Store User Data Policy, including the Limited Use requirements');
  });

  it('says that keys with no recognizable name or format may not be masked', () => {
    expect(readme).toContain('Keys with no recognizable name or format may not be masked, for example some AI provider keys.');
  });

  it('uses none of the banned redaction claims', () => {
    expect(readme).not.toMatch(/removes all|removed before anything is shown|redacted before anything is shown|common secrets/i);
  });

  it('is not the first-run label the checklist asks you to click: the checklist uses the agreement button', () => {
    expect(root('docs/e2e-checklist.md')).toContain(`**${COPY.agree}**`);
  });
});

