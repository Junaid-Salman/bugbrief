import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COPY } from '../src/popup/copy';
import { topNotices } from '../src/popup/notices';
import { RESTRICTED_MESSAGE } from '../src/shared/restricted';

describe('topNotices: messages that must stay visible whichever steps are open', () => {
  it('says why recording is blocked on a restricted page', () => {
    expect(topNotices({ restricted: true })).toEqual([{ kind: 'danger', text: RESTRICTED_MESSAGE }]);
  });

  it('is empty on a normal page', () => {
    expect(topNotices({ restricted: false })).toEqual([]);
  });

  it('lists the persistence warning, then the error, then a success notice', () => {
    expect(topNotices({ restricted: true, persistenceOk: false, error: 'Boom.', notice: undefined })).toEqual([
      { kind: 'danger', text: RESTRICTED_MESSAGE },
      { kind: 'danger', text: COPY.persistenceOff },
      { kind: 'danger', text: 'Boom.' },
    ]);
    expect(topNotices({ restricted: false, notice: 'Copied to the clipboard.' })).toEqual([{ kind: 'ok', text: 'Copied to the clipboard.' }]);
  });

  it('shows an error instead of a success notice when both are set', () => {
    expect(topNotices({ restricted: false, error: 'Could not copy.', notice: 'Download started: a.md' })).toEqual([{ kind: 'danger', text: 'Could not copy.' }]);
  });

  it('shows nothing for an empty error, an empty notice and persistence that is fine', () => {
    expect(topNotices({ restricted: false, persistenceOk: true, error: '', notice: '' })).toEqual([]);
    expect(topNotices({ restricted: false, persistenceOk: undefined })).toEqual([]);
  });

  it('never repeats a message', () => {
    const texts = topNotices({ restricted: true, persistenceOk: false, error: 'E', notice: 'N' }).map((notice) => notice.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('is rendered outside the steps, so a folded step cannot hide it', () => {
    const app = readFileSync(new URL('../src/popup/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('topNotices(');
    expect(app).not.toContain('RESTRICTED_MESSAGE');
  });

  it('no longer renders the error, the notice or the persistence warning below the steps (BL-040)', () => {
    const app = readFileSync(new URL('../src/popup/App.tsx', import.meta.url), 'utf8');
    expect(app).not.toContain('>{error}<');
    expect(app).not.toContain('>{notice}<');
    expect(app).not.toContain('{COPY.persistenceOff}</p>');
  });

  it('keeps the notices in the sticky top, with the header, so they stay visible when scrolled (BL-040)', () => {
    const app = readFileSync(new URL('../src/popup/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('class="top"');
    const css = readFileSync(new URL('../src/popup/popup.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.top \{[^}]*position: sticky/);
    expect(css).toContain('.box--ok');
  });

  it('decides to drop a preview from the typed failure code, never from message text (BL-012)', () => {
    const app = readFileSync(new URL('../src/popup/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('dropsPreview(');
    expect(app).not.toContain("includes('Preview')");
  });
});

/** What the store's User Data policy asks of the first-run screen (P10, Q15): name what is read, say it stays on the device, and ask for a specific agreement. */
describe('first-run disclosure', () => {
  const everything = [COPY.explainerReadsTitle, ...COPY.explainerReads, ...COPY.explainerPoints, COPY.agree].join(' ');
  const source = (name: string) => readFileSync(new URL(`../src/popup/${name}`, import.meta.url), 'utf8');

  it('names every kind of data BugBrief reads from the recorded tab', () => {
    const reads = COPY.explainerReads.join(' ').toLowerCase();
    for (const kind of ['page content', 'screenshot', 'addresses (urls)', 'requests and responses', 'console', 'personal data', 'sign-in tokens']) {
      expect(reads, kind).toContain(kind);
    }
  });

  it('says that the data stays on the device and is never sent anywhere', () => {
    const points = COPY.explainerPoints.join(' ');
    expect(points).toContain('stays on your device');
    expect(points).toContain('never sent anywhere');
  });

  it('uses the canonical redaction wording and says the screenshot is not masked', () => {
    const points = COPY.explainerPoints.join(' ');
    expect(points).toContain('BugBrief masks secrets it recognizes, such as tokens, keys, passwords and email addresses.');
    expect(points).toContain('It can miss others');
    expect(points).toContain('the screenshot is not masked');
    expect(points).toContain('read the report before you share it');
  });

  it('uses none of the banned redaction claims', () => {
    expect(everything).not.toMatch(/removes all|removed before anything is shown|redacted before anything is shown|common secrets/i);
  });

  it('asks for an explicit agreement, not a bare "Got it"', () => {
    expect(COPY.agree).toBe('I understand, continue');
    expect(source('Explainer.tsx')).toContain('COPY.agree');
    expect(source('Explainer.tsx')).not.toContain('Got it');
  });

  it('keeps the whole popup behind the agreement until the user clicks it', () => {
    const app = source('App.tsx');
    expect(app.indexOf('if (!explainerSeen)')).toBeGreaterThan(0);
    expect(app.indexOf('if (!explainerSeen)')).toBeLessThan(app.indexOf('const restricted ='));
    expect(app).toContain('chrome.storage.local.set({ [EXPLAINER_KEY]: true })');
  });

  it('still has three points: scope, local storage and redaction', () => {
    expect(COPY.explainerPoints).toHaveLength(3);
  });
});
