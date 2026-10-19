/** Criterion 13: a stored pick feeds P4's redactCapsule, and the truncated flag turns on the tolerant forms. */
import { describe, expect, it } from 'vitest';
import { sanitizePick } from '../src/core/element-model';
import { redactCapsule, type CapsuleDraft } from '../src/core/redact/redact';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

function draftFor(message: Record<string, unknown>): CapsuleDraft {
  const picked = sanitizePick(message);
  if (!picked) throw new Error('fixture rejected');
  return {
    pageUrl: picked.page.url,
    pageTitle: picked.page.title,
    userAgent: 'ua',
    viewport: picked.page.viewport,
    capturedAt: 'now',
    console: [],
    network: [],
    element: picked.snapshot,
  };
}

function message(element: Record<string, unknown>) {
  return {
    type: 'ELEMENT_PICKED',
    element: { rect: { x: 0, y: 0, width: 1, height: 1 }, styles: { 'background-color': 'red' }, ...element },
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 1,
    pageUrl: `https://example.com/p?token=${TOKEN}`,
    pageTitle: `Reset for jane@example.com`,
  };
}

describe('picked element through redactCapsule', () => {
  it('masks secrets in the selector, outerHTML, styles, URL and title', () => {
    const { draft, redactionCount } = redactCapsule(
      draftFor(
        message({
          selector: 'input[value="hunter2"]',
          outerHTML: `<form><input type="password" value="hunter2"><input type="hidden" name="csrf" value="abc123def"><p>${TOKEN}</p></form>`,
          styles: { 'background-color': `url(x?token=${TOKEN})` },
        }),
      ),
    );
    const json = JSON.stringify(draft);
    for (const secret of ['hunter2', 'abc123def', TOKEN, 'jane@example.com']) expect(json).not.toContain(secret);
    expect(draft.element?.selector).toBe('input[value="[REDACTED]"]');
    expect(redactionCount).toBeGreaterThanOrEqual(6);
    expect(draft.element?.screenshotDataUrl).toBe('');
  });

  it('uses the tolerant forms only when the picker cut the HTML', () => {
    const tail = '<p>eyJhbGciOiJIUzI1';
    const whole = redactCapsule(draftFor(message({ selector: 'p', outerHTML: tail }))).draft;
    expect(whole.element?.outerHTML).toBe(tail);
    const cut = redactCapsule(draftFor(message({ selector: 'p', outerHTML: tail, outerHTMLTruncated: true }))).draft;
    expect(cut.element?.outerHTML).toBe('<p>[REDACTED]');
  });

  it('a 32 KB cut inside an attribute value is still masked', () => {
    const html = `<input type="password" value="${'x'.repeat(40_000)}`;
    const picked = draftFor(message({ selector: 'input', outerHTML: html }));
    expect(picked.element?.outerHTMLTruncated).toBe(true);
    const out = redactCapsule(picked).draft.element?.outerHTML ?? '';
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('xxxxxxxxxxxx');
  });
});
