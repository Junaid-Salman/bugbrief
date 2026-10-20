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

  it('is rendered outside the steps, so a folded step cannot hide it', () => {
    const app = readFileSync(new URL('../src/popup/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('topNotices(');
    expect(app).not.toContain('RESTRICTED_MESSAGE');
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
