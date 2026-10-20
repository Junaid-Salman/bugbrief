// @vitest-environment jsdom
/**
 * Step 3: selector builder, targeting, styles and payload. jsdom has no layout, no CSS.escape and
 * no elementsFromPoint, so those are stubbed or written out; the manual Chrome checks cover them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { STYLE_PROPERTIES } from '../src/core/element-model';
import { FIELD } from '../src/core/limits';
import {
  SHADOW_SEPARATOR,
  buildPayload,
  buildSelector,
  cssEscape,
  describeElement,
  describeTarget,
  readStyles,
  resolveTarget,
} from '../src/content/picker-dom';
import { SEED, mulberry32 } from './helpers/secrets';

afterEach(() => {
  document.body.innerHTML = '';
});

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function assertUnique(el: Element): string {
  const selector = buildSelector(el);
  const found = document.querySelectorAll(selector);
  expect(found.length, selector).toBe(1);
  expect(found[0], selector).toBe(el);
  return selector;
}

describe('cssEscape', () => {
  it.each([
    ['plain', 'plain'],
    ['a:b', 'a\\:b'],
    ['a.b', 'a\\.b'],
    ['1x', '\\31 x'],
    ['-1x', '-\\31 x'],
    ['-', '\\-'],
    ['a b', 'a\\ b'],
    ['\u0001x', '\\1 x'],
    ['x\u0000', 'x�'],
    ['café', 'café'],
    ['[x]', '\\[x\\]'],
    ['a_b-c', 'a_b-c'],
  ])('escapes %j', (input, expected) => {
    expect(cssEscape(input)).toBe(expected);
  });

  it('produces selectors the engine accepts for odd ids', () => {
    for (const id of ['a:b', '1x', 'a.b', 'x y', '#h', 'q"r', "q'r", 'café', '-']) {
      html('<div></div>');
      $('div').id = id;
      expect(document.querySelectorAll(`#${cssEscape(id)}`).length, id).toBe(1);
    }
  });
});

describe('buildSelector', () => {
  it('uses a unique id', () => {
    html('<div><button id="buy">Buy</button></div>');
    expect(assertUnique($('button'))).toBe('#buy');
  });

  it('escapes ids that need it', () => {
    html('<div><button id="a:b">Buy</button></div>');
    expect(assertUnique($('button'))).toBe('#a\\:b');
  });

  it('skips a duplicate id and builds a path', () => {
    html('<main><p id="dup">a</p><section><p id="dup">b</p></section></main>');
    const second = document.querySelectorAll('p')[1] as Element;
    const selector = assertUnique(second);
    expect(selector).not.toContain('#dup');
  });

  it('uses tag and classes, and nth-of-type only when same-tag siblings exist', () => {
    html('<ul class="list"><li class="item">a</li><li class="item">b</li></ul><p class="note">n</p>');
    expect(assertUnique($('p'))).toBe('p.note');
    const items = document.querySelectorAll('li');
    expect(assertUnique(items[1] as Element)).toBe('li.item:nth-of-type(2)');
  });

  it('keeps at most two classes and escapes special ones', () => {
    html('<div class="a b c d"><span class="x:y 1z">t</span><span>u</span></div>');
    const span = $('span.x\\:y');
    const selector = assertUnique(span);
    expect(selector).toContain('x\\:y');
    expect(selector).toContain('\\31 z');
    html('<div class="a b c d"></div>');
    expect(buildSelector($('div'))).toBe('div.a.b');
  });

  it('anchors on the nearest ancestor with a unique id', () => {
    html('<div id="a"><p><b>x</b></p></div><div id="c"><p><b>y</b></p></div>');
    const second = document.querySelectorAll('b')[1] as Element;
    expect(assertUnique(second)).toBe('#c > p > b');
  });

  it('handles html, body and deep nesting', () => {
    assertUnique(document.documentElement);
    assertUnique(document.body);
    html('<div><div><div><div><div><p>deep</p></div></div></div></div></div>');
    assertUnique($('p'));
  });

  it('handles SVG children', () => {
    html('<svg><g><path d="M0 0"></path><path d="M1 1"></path></g></svg>');
    for (const path of Array.from(document.querySelectorAll('path'))) assertUnique(path);
  });

  it('caps the selector length', () => {
    html(`<div id="${'x'.repeat(5000)}"></div>`);
    expect(buildSelector($('div')).length).toBeLessThanOrEqual(FIELD.selector);
  });

  it('joins shadow roots with >>> and each part is unique in its own root', () => {
    html('<div id="host"></div><div id="other"></div>');
    const host = $('#host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<section><button class="go">a</button><button class="go">b</button></section>';
    const target = root.querySelectorAll('button')[1] as Element;
    const selector = buildSelector(target);
    expect(selector).toBe(`#host${SHADOW_SEPARATOR}button.go:nth-of-type(2)`);
    const [outer, inner] = selector.split(SHADOW_SEPARATOR) as [string, string];
    expect(document.querySelector(outer)).toBe(host);
    expect(root.querySelectorAll(inner)).toHaveLength(1);
    expect(root.querySelector(inner)).toBe(target);
  });

  it('handles two nested shadow roots', () => {
    html('<div id="outer"></div>');
    const outerRoot = $('#outer').attachShadow({ mode: 'open' });
    outerRoot.innerHTML = '<div class="mid"></div>';
    const innerRoot = (outerRoot.querySelector('.mid') as Element).attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<i id="leaf">x</i>';
    const selector = buildSelector(innerRoot.querySelector('#leaf') as Element);
    expect(selector.split(SHADOW_SEPARATOR)).toHaveLength(3);
    expect(selector.endsWith('#leaf')).toBe(true);
  });

  it('is unique for every node of 200 seeded random trees', () => {
    const rng = mulberry32(SEED);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
    const tags = ['div', 'span', 'li', 'p', 'section', 'button'] as const;
    const classes = ['a', 'b', 'c', 'x:y', '1z', 'card'] as const;
    const ids = ['', '', '', 'i1', 'i2', 'dup', 'a:b', '9x'] as const;
    for (let tree = 0; tree < 200; tree++) {
      document.body.innerHTML = '';
      const nodes: Element[] = [];
      const budget = 5 + Math.floor(rng() * 56);
      const grow = (parent: Element, depth: number): void => {
        const children = 1 + Math.floor(rng() * 4);
        for (let i = 0; i < children && nodes.length < budget; i++) {
          const el = document.createElement(pick(tags));
          const classCount = Math.floor(rng() * 4);
          for (let c = 0; c < classCount; c++) el.classList.add(pick(classes));
          const id = pick(ids);
          if (id) el.id = id;
          parent.appendChild(el);
          nodes.push(el);
          if (depth < 4) grow(el, depth + 1);
        }
      };
      grow(document.body, 0);
      for (const el of nodes) {
        const selector = buildSelector(el);
        const found = document.querySelectorAll(selector);
        expect(found.length === 1 && found[0] === el, `tree ${tree}: ${selector}`).toBe(true);
      }
    }
  }, 30_000); // CPU-bound: about 6 000 selectors, each checked with querySelectorAll
});

describe('readStyles', () => {
  it('returns exactly the 15 spec properties, kebab-case', () => {
    html('<p style="color: red; z-index: 3; opacity: 0.5">x</p>');
    const styles = readStyles($('p'));
    expect(Object.keys(styles)).toEqual([...STYLE_PROPERTIES]);
    expect(styles.color).toBe('rgb(255, 0, 0)'); // jsdom normalizes named colors
    expect(styles['z-index']).toBe('3');
    expect(styles.opacity).toBe('0.5');
  });

  it('caps long values', () => {
    html(`<p style="font-family: ${'x'.repeat(1000)}">x</p>`);
    expect(readStyles($('p'))['font-family']?.length).toBeLessThanOrEqual(FIELD.styleValue);
  });
});

describe('resolveTarget', () => {
  function stackAt(elements: Element[]): void {
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => elements;
  }

  it('skips the overlay and returns the next element', () => {
    html('<div id="overlay"></div><button id="b"></button><body-x></body-x>');
    stackAt([$('#overlay'), $('#b'), document.body]);
    expect(resolveTarget(document, 5, 5, $('#overlay'))).toBe($('#b'));
  });

  it('returns undefined when only the overlay is under the point', () => {
    html('<div id="overlay"></div>');
    stackAt([$('#overlay')]);
    expect(resolveTarget(document, 5, 5, $('#overlay'))).toBeUndefined();
  });

  it('pierces open shadow roots until the target stops changing', () => {
    html('<div id="overlay"></div><div id="host"></div>');
    const outerRoot = $('#host').attachShadow({ mode: 'open' });
    outerRoot.innerHTML = '<div id="mid"></div>';
    const mid = outerRoot.querySelector('#mid') as Element;
    const innerRoot = mid.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<b id="leaf"></b>';
    const leaf = innerRoot.querySelector('#leaf') as Element;
    (outerRoot as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => mid;
    (innerRoot as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => leaf;
    stackAt([$('#overlay'), $('#host')]);
    expect(resolveTarget(document, 1, 1, $('#overlay'))).toBe(leaf);
  });

  it('selects the host of a closed shadow root and the iframe element', () => {
    html('<div id="overlay"></div><div id="closed"></div><iframe id="frame"></iframe>');
    $('#closed').attachShadow({ mode: 'closed' });
    stackAt([$('#overlay'), $('#closed')]);
    expect(resolveTarget(document, 1, 1, $('#overlay'))).toBe($('#closed'));
    stackAt([$('#overlay'), $('#frame')]);
    expect(resolveTarget(document, 1, 1, $('#overlay'))).toBe($('#frame'));
  });
});

describe('describeTarget and describeElement', () => {
  it('labels with tag, id, first class and size', () => {
    html('<button id="buy" class="btn primary">Buy</button>');
    expect(describeTarget($('button'), { width: 120.4, height: 39.6 })).toBe('button#buy.btn  120×40');
  });

  it('caps outerHTML on a code-point boundary and sets the flag only when cut', () => {
    html('<p id="small">x</p>');
    expect(describeElement($('p')).outerHTMLTruncated).toBeUndefined();
    html('<p id="big"></p>');
    $('p').textContent = 'a'.repeat(FIELD.outerHTML - 20) + '😀'.repeat(30);
    const described = describeElement($('p'));
    expect(described.outerHTML.length).toBeLessThanOrEqual(FIELD.outerHTML);
    expect(described.outerHTML.length).toBeGreaterThanOrEqual(FIELD.outerHTML - 1);
    expect(described.outerHTMLTruncated).toBe(true);
    const last = described.outerHTML.charCodeAt(described.outerHTML.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe('buildPayload', () => {
  it('carries rect, viewport, devicePixelRatio, url and title', () => {
    html('<p id="p">x</p>');
    document.title = 'My page';
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
    const payload = buildPayload(describeElement($('p')), { x: 1, y: 2, width: 3, height: 4 }, window);
    expect(payload.type).toBe('ELEMENT_PICKED');
    expect(payload.element.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(payload.element.selector).toBe('#p');
    expect(payload.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(payload.devicePixelRatio).toBe(1.5);
    expect(payload.pageUrl).toBe(window.location.href);
    expect(payload.pageTitle).toBe('My page');
    expect(Object.keys(payload).sort()).toEqual(['devicePixelRatio', 'element', 'pageTitle', 'pageUrl', 'type', 'viewport']);
  });

  it('adds clientWidth and clientHeight when the page reports a viewport without scrollbars (P6)', () => {
    html('<p id="p">x</p>');
    // dom-safe reads the prototype getters (a page cannot fake them), so the prototype is stubbed.
    const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'clientWidth', { get: () => 1265, configurable: true });
    Object.defineProperty(Element.prototype, 'clientHeight', { get: () => 780, configurable: true });
    try {
      const payload = buildPayload(describeElement($('p')), { x: 0, y: 0, width: 1, height: 1 }, window);
      expect(payload.clientWidth).toBe(1265);
      expect(payload.clientHeight).toBe(780);
    } finally {
      if (width) Object.defineProperty(Element.prototype, 'clientWidth', width);
      if (height) Object.defineProperty(Element.prototype, 'clientHeight', height);
    }
  });

  it('is not fooled by a page that clobbers clientWidth on documentElement', () => {
    html('<p id="p">x</p>');
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 99999, configurable: true });
    try {
      const payload = buildPayload(describeElement($('p')), { x: 0, y: 0, width: 1, height: 1 }, window);
      expect(payload.clientWidth).not.toBe(99999);
    } finally {
      delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it('leaves the client size out when it is 0, as in an environment without layout', () => {
    html('<p id="p">x</p>');
    const payload = buildPayload(describeElement($('p')), { x: 0, y: 0, width: 1, height: 1 }, window);
    expect('clientWidth' in payload).toBe(false);
    expect('clientHeight' in payload).toBe(false);
  });
});
