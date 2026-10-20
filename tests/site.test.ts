/** D9: the privacy policy served by Vercel. It must say what the code does, make no outside requests and carry the store's required statements. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const policy = read('site/privacy.html');
const text = policy.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('site/privacy.html', () => {
  it('has an effective date and a changes clause', () => {
    expect(text).toMatch(/Effective date: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain('Changes to this policy');
  });

  it('names every kind of data BugBrief reads', () => {
    for (const kind of ['page content', 'a screenshot of that element', 'the addresses (URLs)', 'requests and responses', 'console errors and messages', 'personal data', 'sign-in tokens', 'form values', 'authentication information']) {
      expect(text, kind).toContain(kind);
    }
  });

  it('says where the data lives, when it goes, and that nothing leaves the device', () => {
    expect(text).toContain('chrome.storage.session');
    expect(text).toContain('chrome.storage.local');
    expect(text).toContain('Clear');
    expect(text).toContain('never sent anywhere');
    expect(text).toContain('no analytics or tracking');
    expect(text).toContain('loads no remote code');
  });

  it('carries the Limited Use disclosure', () => {
    expect(text).toContain('Chrome Web Store User Data Policy');
    expect(text).toContain('including the Limited Use requirements');
    expect(text).toContain('not used for advertising');
  });

  it('is honest about redaction and the screenshot, with the canonical sentence', () => {
    expect(text).toContain('BugBrief masks secrets it recognizes, such as tokens, keys, passwords and email addresses');
    expect(text).toContain('The screenshot is not masked at all');
    expect(text).toContain('some AI provider keys');
    expect(text).not.toMatch(/removes all|removed before anything is shown|redacted before anything is shown|common secrets|collects no data|no data (is )?collected/i);
  });

  it('lists the five permissions the manifest declares', () => {
    const manifest = read('manifest.config.ts');
    const declared = /permissions:\s*\[([^\]]+)\]/.exec(manifest)?.[1]?.match(/'([a-zA-Z]+)'/g)?.map((value) => value.replaceAll("'", '')) ?? [];
    expect(declared.length).toBe(5);
    for (const permission of declared) expect(policy, permission).toContain(`<code>${permission}</code>`);
  });

  it('mentions children and gives a contact that is the GitHub issues page', () => {
    expect(text).toContain('not directed at children');
    expect(policy).toContain('href="https://github.com/Junaid-Salman/bugbrief/issues"');
  });

  it('loads nothing from another host: no script, stylesheet link, image, font, import or frame', () => {
    expect(policy).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<video|<audio|@import|url\(|@font-face/i);
  });

  it('is a complete page: language, viewport, title', () => {
    expect(policy).toContain('<html lang="en">');
    expect(policy).toContain('name="viewport"');
    expect(policy).toContain('<title>BugBrief Privacy Policy</title>');
  });
});

describe('site/vercel.json', () => {
  it('turns on clean URLs, so /privacy serves privacy.html', () => {
    expect(JSON.parse(read('site/vercel.json'))).toEqual({ cleanUrls: true });
  });
});

describe('store/ documents', () => {
  const store = (name: string): string => read(`store/${name}`);

  it('uses the manifest description as the summary, within the store limit', () => {
    const description = /description:\s*'([^']+)'/.exec(read('manifest.config.ts').replace(/\s+/g, ' '))?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(132);
    expect(store('listing.md')).toContain(description);
  });

  it('uses the canonical redaction sentence and none of the banned claims', () => {
    expect(store('listing.md')).toContain('BugBrief masks secrets it recognizes, such as tokens, keys, passwords and email addresses.');
    for (const name of ['listing.md', 'justifications.md', 'data-usage.md', 'test-instructions.md']) {
      expect(store(name), name).not.toMatch(/removes all|removed before anything is shown|common secrets|collects no data/i);
    }
  });

  it('justifies every permission the manifest declares and none it does not', () => {
    const manifest = read('manifest.config.ts');
    const declared = /permissions:\s*\[([^\]]+)\]/.exec(manifest)?.[1]?.match(/'([a-zA-Z]+)'/g)?.map((value) => value.replaceAll("'", '')) ?? [];
    const rows = [...store('justifications.md').matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual([...declared].sort());
    expect(store('justifications.md')).toContain('Remote code');
  });

  it('discloses the data types and does not claim that no data is handled', () => {
    const usage = store('data-usage.md');
    for (const kind of ['Website content', 'Web browsing activity', 'Authentication information', 'Form data', 'Personally identifiable information']) {
      expect(usage, kind).toContain(`- [x] ${kind}`);
    }
    expect(usage.match(/- \[x\] I do not/g)).toHaveLength(3);
  });

  it('keeps the reviewer steps on any page and mentions the Chrome banner', () => {
    const steps = store('test-instructions.md');
    expect(steps).toContain("fetch('/missing-' + Date.now()); console.error('reviewer test')");
    expect(steps).toContain('started debugging this browser');
    expect(steps).toContain('I understand, continue');
  });
});

describe('privacy policy URL', () => {
  it('is the deployed address in the data-usage answers', () => {
    expect(read('store/data-usage.md')).toContain('https://bugbrief-bice.vercel.app/privacy');
    expect(read('store/data-usage.md')).not.toContain('<vercel-project>');
  });
});
