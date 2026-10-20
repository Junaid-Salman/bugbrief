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

describe('explainer privacy wording', () => {
  const lines = COPY.explainerPoints;

  it('has the three points', () => expect(lines).toHaveLength(3));

  it('says that screenshots are not redacted', () => {
    expect(lines.join(' ')).toContain('Screenshots are not');
  });

  it('never claims that all secrets are redacted', () => {
    for (const line of lines) expect(line).not.toMatch(/^Secrets are redacted/);
    expect(lines.join(' ')).toContain('Secrets in text are redacted');
  });

  it('keeps the promise that nothing leaves the machine', () => {
    expect(lines.join(' ')).toContain('Nothing leaves your machine');
  });
});
