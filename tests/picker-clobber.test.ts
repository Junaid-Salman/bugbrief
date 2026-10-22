// @vitest-environment jsdom
/**
 * Phase 5.1, criterion 17: a page cannot break the picker by naming form fields after DOM
 * properties (DOM clobbering). jsdom has no legacy named getters, so a clobbered property is
 * stubbed as an own property that returns a decoy element, which is what Chrome does for a
 * `<form>` with `<input name="id">`. Verified in real Chrome while planning (plan §7.1.1).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPayload,
  buildSelector,
  describeElement,
  describeTarget,
  readStyles,
  resolveTarget,
} from '../src/content/picker-dom';
import { startPicker, type PickerHandle } from '../src/content/picker-run';
import type { PickerToWorker } from '../src/shared/messages';

const ELEMENT_NAMES = [
  'id', 'classList', 'className', 'localName', 'outerHTML', 'children', 'parentElement', 'parentNode',
  'getAttribute', 'getBoundingClientRect', 'scrollIntoView', 'getRootNode', 'shadowRoot',
  'namespaceURI', 'querySelectorAll', 'ownerDocument',
] as const;
// `tagName` and `nodeType` are clobberable in a browser too, but jsdom's own selector engine
// (nwsapi) reads them from the wrapper, so stubbing them breaks `querySelectorAll` in the test
// itself. The picker does not read `tagName`, and reads `nodeType` through `nodeTypeOf`.

// jsdom's own selector engine reads many wrapper properties while matching (parentNode, localName,
// getAttribute, ...), so clobbering all of them at once breaks `querySelectorAll` inside jsdom (a
// real browser's engine does not use JS properties). This set avoids those. Every name is covered
// on its own in the table test.
const ALL_AT_ONCE = ['id', 'className', 'outerHTML', 'children', 'shadowRoot', 'getBoundingClientRect', 'scrollIntoView'];

let decoy: HTMLInputElement;
let form: HTMLFormElement;
const restore: Array<() => void> = [];

function clobber(target: object, name: string): void {
  Object.defineProperty(target, name, { value: decoy, configurable: true });
  restore.push(() => {
    delete (target as Record<string, unknown>)[name];
  });
}

beforeEach(() => {
  document.body.innerHTML =
    '<form id="edit" class="card wide"><input name="id"><input name="classList"><button id="save" class="btn">Save</button></form>' +
    '<form class="card"><button class="btn">Other</button></form>';
  form = document.getElementById('edit') as HTMLFormElement;
  decoy = document.createElement('input');
  (window as unknown as { __conscribePicker?: unknown }).__conscribePicker = false;
});

afterEach(() => {
  while (restore.length) restore.pop()?.();
  document.body.innerHTML = '';
  delete (Document.prototype as unknown as Record<string, unknown>).elementsFromPoint;
});

describe('a clobbered form does not break selector, label or snapshot', () => {
  it.each(ELEMENT_NAMES)('with %s clobbered on the form', (name) => {
    clobber(form, name);
    const selector = buildSelector(form);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(form);
    // A child of the clobbered form: its parent is the form.
    const save = document.getElementById('save') as Element;
    const childSelector = buildSelector(save);
    expect(document.querySelector(childSelector)).toBe(save);
    expect(typeof describeTarget(form, { width: 10, height: 20 })).toBe('string');
    const described = describeElement(form);
    expect(described.outerHTML.startsWith('<form id="edit"')).toBe(true);
    expect(readStyles(form)).toBeTypeOf('object');
  });

  it('clobbering every name at once still works', () => {
    for (const name of ALL_AT_ONCE) clobber(form, name);
    expect(document.querySelector(buildSelector(form))).toBe(form);
    expect(describeTarget(form, { width: 1, height: 1 })).toContain('#edit.card');
  });

  it('a clobbered shadowRoot on the form does not stop target resolution', () => {
    clobber(form, 'shadowRoot');
    (Document.prototype as unknown as Record<string, unknown>).elementsFromPoint = () => [form];
    expect(resolveTarget(document, 1, 1, document.createElement('div'))).toBe(form);
  });
});

describe('a clobbered document does not break the picker', () => {
  it.each(['title', 'elementsFromPoint', 'createElement', 'documentElement', 'querySelectorAll', 'defaultView'])(
    'with document.%s clobbered',
    (name) => {
      (Document.prototype as unknown as Record<string, unknown>).elementsFromPoint = () => [form];
      document.title = 'Real title';
      clobber(document, name);
      expect(resolveTarget(document, 1, 1, decoy)).toBe(form);
      expect(document.querySelector(buildSelector(form))).toBe(form);
      const payload = buildPayload(describeElement(form), { x: 0, y: 0, width: 1, height: 1 }, window);
      expect(payload.pageTitle).toBe('Real title');
    },
  );

  it('readStyles still returns all 15 styles when document.defaultView is clobbered (Round 2, C1)', () => {
    clobber(document, 'defaultView');
    expect(Object.keys(readStyles(form))).toHaveLength(15);
    expect(() => describeElement(form)).not.toThrow();
  });
});

describe('a full pick on a clobbered form', () => {
  it('sends a valid payload with the real markup and title', async () => {
    const sent: PickerToWorker[] = [];
    (Document.prototype as unknown as Record<string, unknown>).elementsFromPoint = () => [form];
    document.title = 'Edit item';
    for (const name of ALL_AT_ONCE) clobber(form, name);
    for (const name of ['title', 'createElement', 'documentElement', 'defaultView']) clobber(document, name);
    const frames: Array<() => void> = [];
    const handle = startPicker({
      send: (message) => sent.push(message),
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: () => undefined,
      requireTrusted: false,
    }) as PickerHandle;
    expect(handle).toBeDefined();
    // `scrollIntoView` is absent in jsdom's prototype, so the instance fallback is the decoy here.
    // Provide the real one on the prototype the way a browser has it.
    (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => undefined;
    restore.push(() => {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    });
    handle.host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 3, clientY: 4 }));
    for (let i = 0; i < 6; i++) {
      for (const callback of frames.splice(0)) callback();
      await Promise.resolve();
    }
    expect(sent).toHaveLength(1);
    const message = sent[0] as Extract<PickerToWorker, { type: 'ELEMENT_PICKED' }>;
    expect(message.type).toBe('ELEMENT_PICKED');
    expect(document.querySelector(message.element.selector)).toBe(form);
    expect(message.element.outerHTML.startsWith('<form id="edit"')).toBe(true);
    expect(message.pageTitle).toBe('Edit item');
  });
});

describe('the picker files read page nodes only through dom-safe', () => {
  const FORBIDDEN =
    /\.(id|classList|className|localName|outerHTML|children|parentElement|parentNode|shadowRoot|ownerDocument|nodeType|namespaceURI|title|documentElement|defaultView|visibilityState)\b|\.(getAttribute|getBoundingClientRect|scrollIntoView|getRootNode|querySelectorAll|elementsFromPoint|createElement)\(/;
  // Our own overlay nodes and the event/window objects are not page nodes.
  const ALLOWED_LINES = [/FIELD\.outerHTML/, /\bhost\.|\bbox\.|\blabel\.|\bhint\.|\broot\.|\bhandle\./, /win\.document\b(?!\.)/];

  for (const file of ['src/content/picker-dom.ts', 'src/content/picker-run.ts']) {
    it(`${file} has no direct page-property read`, () => {
      const offenders = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .filter(({ line }) => FORBIDDEN.test(line) && !ALLOWED_LINES.some((allowed) => allowed.test(line)))
        .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    });
  }
});
