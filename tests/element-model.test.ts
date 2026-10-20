import { describe, expect, it } from 'vitest';
import { STYLE_PROPERTIES, sanitizePick } from '../src/core/element-model';
import { FIELD } from '../src/core/limits';

function message(overrides: Record<string, unknown> = {}, element: Record<string, unknown> = {}) {
  return {
    type: 'ELEMENT_PICKED',
    element: {
      selector: '#buy',
      outerHTML: '<button id="buy">Buy</button>',
      styles: { display: 'block', color: 'rgb(0, 0, 0)' },
      rect: { x: 1, y: 2, width: 30, height: 40 },
      ...element,
    },
    viewport: { width: 1280, height: 800 },
    devicePixelRatio: 2,
    pageUrl: 'https://example.com/a',
    pageTitle: 'Shop',
    ...overrides,
  };
}

describe('STYLE_PROPERTIES', () => {
  it('is exactly the 15 spec properties in kebab-case', () => {
    expect([...STYLE_PROPERTIES]).toEqual([
      'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
      'font-family', 'font-size', 'font-weight', 'z-index', 'overflow', 'visibility', 'opacity',
    ]);
  });
});

describe('sanitizePick', () => {
  it('accepts a good message and stores an empty screenshot placeholder', () => {
    const picked = sanitizePick(message());
    expect(picked?.snapshot).toEqual({
      selector: '#buy',
      outerHTML: '<button id="buy">Buy</button>',
      styles: { display: 'block', color: 'rgb(0, 0, 0)' },
      rect: { x: 1, y: 2, width: 30, height: 40 },
      screenshotDataUrl: '',
    });
    expect(picked?.page).toEqual({
      url: 'https://example.com/a',
      title: 'Shop',
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
    });
    expect(picked?.snapshot.outerHTMLTruncated).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['no element', message({ element: undefined })],
    ['no viewport', message({ viewport: undefined })],
    ['a numeric selector', message({}, { selector: 5 })],
    ['an empty selector', message({}, { selector: '' })],
    ['a numeric outerHTML', message({}, { outerHTML: 5 })],
    ['array styles', message({}, { styles: [] })],
    ['a NaN rect', message({}, { rect: { x: NaN, y: 0, width: 1, height: 1 } })],
    ['an Infinity rect', message({}, { rect: { x: 0, y: 0, width: Infinity, height: 1 } })],
    ['a missing rect', message({}, { rect: undefined })],
    ['a non-finite viewport', message({ viewport: { width: Infinity, height: 1 } })],
    ['a zero devicePixelRatio', message({ devicePixelRatio: 0 })],
    ['a string devicePixelRatio', message({ devicePixelRatio: '2' })],
    ['a numeric pageUrl', message({ pageUrl: 1 })],
    ['a numeric pageTitle', message({ pageTitle: 1 })],
  ])('rejects %s', (_label, input) => {
    expect(sanitizePick(input)).toBeUndefined();
  });

  it('caps every string and flags a cut outerHTML', () => {
    const long = (n: number) => 'x'.repeat(n);
    const picked = sanitizePick(
      message(
        { pageUrl: long(5000), pageTitle: long(5000) },
        { selector: long(5000), outerHTML: long(FIELD.outerHTML + 10), styles: { color: long(1000) } },
      ),
    );
    expect(picked?.snapshot.selector).toHaveLength(FIELD.selector);
    expect(picked?.snapshot.outerHTML).toHaveLength(FIELD.outerHTML);
    expect(picked?.snapshot.outerHTMLTruncated).toBe(true);
    expect(picked?.snapshot.styles.color).toHaveLength(FIELD.styleValue);
    expect(picked?.page.url).toHaveLength(FIELD.pageUrl);
    expect(picked?.page.title).toHaveLength(FIELD.pageTitle);
  });

  it('cuts on a code-point boundary', () => {
    const html = 'a'.repeat(FIELD.outerHTML - 1) + '😀';
    const out = sanitizePick(message({}, { outerHTML: html }))?.snapshot.outerHTML ?? '';
    expect(out).toHaveLength(FIELD.outerHTML - 1);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it('keeps the picker flag even when nothing was cut here', () => {
    expect(sanitizePick(message({}, { outerHTMLTruncated: true }))?.snapshot.outerHTMLTruncated).toBe(true);
    expect(sanitizePick(message({}, { outerHTMLTruncated: 'yes' }))?.snapshot.outerHTMLTruncated).toBeUndefined();
  });

  it('drops unknown style keys and non-string style values', () => {
    const picked = sanitizePick(message({}, { styles: { display: 'flex', evil: 'x', color: 5, 'z-index': '3' } }));
    expect(picked?.snapshot.styles).toEqual({ display: 'flex', 'z-index': '3' });
  });

  it('does not copy extra properties from the message', () => {
    const picked = sanitizePick(message({ extra: 'x' }, { extra: 'y' }));
    expect(JSON.stringify(picked)).not.toContain('extra');
  });
});

describe('sanitizePick client size (P6, criterion 12)', () => {
  it('keeps finite positive clientWidth and clientHeight', () => {
    const picked = sanitizePick(message({ clientWidth: 1265, clientHeight: 780 }));
    expect(picked?.page.clientWidth).toBe(1265);
    expect(picked?.page.clientHeight).toBe(780);
  });

  it('works without them, as an old message does', () => {
    const picked = sanitizePick(message());
    expect(picked).toBeDefined();
    expect('clientWidth' in (picked?.page ?? {})).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, '1265', null, {}])('drops %j', (bad) => {
    const picked = sanitizePick(message({ clientWidth: bad, clientHeight: bad }));
    expect(picked).toBeDefined();
    expect('clientWidth' in (picked?.page ?? {})).toBe(false);
    expect('clientHeight' in (picked?.page ?? {})).toBe(false);
  });

  it('never accepts screenshot fields from the picker', () => {
    const picked = sanitizePick(message({}, { screenshotDataUrl: 'data:image/png;base64,AAAA', screenshotClipped: true, screenshotUnavailable: 'too-large' }));
    expect(picked?.snapshot.screenshotDataUrl).toBe('');
    expect(picked?.snapshot.screenshotClipped).toBeUndefined();
    expect(picked?.snapshot.screenshotUnavailable).toBeUndefined();
  });
});
