import { STYLE_PROPERTIES } from '../core/element-model';
import { FIELD, capText } from '../core/limits';
import type { PickerToWorker } from '../shared/messages';

export type ElementPicked = Extract<PickerToWorker, { type: 'ELEMENT_PICKED' }>;
type Root = Document | ShadowRoot;

const MAX_CLASSES = 2;
const MAX_SHADOW_DEPTH = 16;
export const SHADOW_SEPARATOR = ' >>> ';

/** CSS.escape, written out so it is deterministic and testable outside a browser. */
export function cssEscape(value: string): string {
  const first = value.charCodeAt(0);
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      result += '�';
    } else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (i === 0 && value.length === 1 && code === 0x2d) {
      result += `\\${value.charAt(i)}`;
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      result += value.charAt(i);
    } else {
      result += `\\${value.charAt(i)}`;
    }
  }
  return result;
}

function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === 11 && 'host' in node;
}

function isUnique(selector: string, root: ParentNode, target: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === target;
  } catch {
    return false;
  }
}

function siblingsOfSameType(node: Element): Element[] {
  const parent = node.parentNode as ParentNode | null;
  if (!parent) return [node];
  return Array.from(parent.children).filter(
    (sibling) => sibling.localName === node.localName && sibling.namespaceURI === node.namespaceURI,
  );
}

function segmentFor(node: Element, forceNth: boolean): string {
  let segment = node.localName;
  for (const className of Array.from(node.classList).slice(0, MAX_CLASSES)) {
    segment += `.${cssEscape(className)}`;
  }
  const same = siblingsOfSameType(node);
  if (forceNth || same.length > 1) segment += `:nth-of-type(${same.indexOf(node) + 1})`;
  return segment;
}

/** Always unique within one root: tag and nth-of-type from the top of the tree. */
function fullPath(el: Element): string {
  const segments: string[] = [];
  let node: Element | null = el;
  while (node) {
    segments.unshift(`${node.localName}:nth-of-type(${siblingsOfSameType(node).indexOf(node) + 1})`);
    node = node.parentElement;
  }
  return segments.join(' > ');
}

/** The shortest selector for `el` that is unique inside `root`, built from the element upward. */
function selectorWithin(el: Element, root: Root): string {
  if (el.id) {
    const candidate = `#${cssEscape(el.id)}`;
    if (isUnique(candidate, root, el)) return candidate;
  }
  const segments: string[] = [];
  let node: Element | null = el;
  while (node) {
    segments.unshift(segmentFor(node, false));
    const candidate = segments.join(' > ');
    if (isUnique(candidate, root, el)) return candidate;
    node = node.parentElement;
    if (node?.id) {
      const anchor = `#${cssEscape(node.id)}`;
      if (isUnique(anchor, root, node)) {
        const anchored = [anchor, ...segments].join(' > ');
        if (isUnique(anchored, root, el)) return anchored;
      }
    }
  }
  return fullPath(el);
}

/**
 * Unique selector (spec §4.2). Inside open shadow roots each part is unique in its own root and
 * the parts are joined with ` >>> `, which is a readable marker and not valid CSS.
 */
export function buildSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element = el;
  for (let depth = 0; depth < MAX_SHADOW_DEPTH; depth++) {
    const root = current.getRootNode();
    parts.unshift(selectorWithin(current, root as Root));
    if (!isShadowRoot(root)) break;
    current = root.host;
  }
  return capText(parts.join(SHADOW_SEPARATOR), FIELD.selector).text;
}

export function readStyles(el: Element): Record<string, string> {
  const view = el.ownerDocument.defaultView;
  const styles: Record<string, string> = {};
  if (!view) return styles;
  const computed = view.getComputedStyle(el);
  for (const name of STYLE_PROPERTIES) {
    styles[name] = capText(computed.getPropertyValue(name), FIELD.styleValue).text;
  }
  return styles;
}

/**
 * The element under a point, skipping our overlay and piercing open shadow roots. A closed
 * shadow root or an iframe is not entered: the host or the `<iframe>` is the target.
 */
export function resolveTarget(doc: Document, x: number, y: number, overlay: Element): Element | undefined {
  let target = doc.elementsFromPoint(x, y).find((candidate) => candidate !== overlay);
  for (let depth = 0; target && depth < MAX_SHADOW_DEPTH; depth++) {
    const inner = target.shadowRoot?.elementFromPoint(x, y);
    if (!inner || inner === target) break;
    target = inner;
  }
  return target;
}

/** `tag#id.class  120×40` for the hover label. */
export function describeTarget(el: Element, rect: { width: number; height: number }): string {
  let label = el.localName;
  if (el.id) label += `#${el.id}`;
  const first = el.classList.item(0);
  if (first) label += `.${first}`;
  return capText(`${label}  ${Math.round(rect.width)}×${Math.round(rect.height)}`, 80).text;
}

export interface Described {
  selector: string;
  outerHTML: string;
  outerHTMLTruncated?: true;
  styles: Record<string, string>;
}

/** Everything that does not depend on scroll position. Read at click time. */
export function describeElement(el: Element): Described {
  const html = capText(el.outerHTML, FIELD.outerHTML);
  const described: Described = {
    selector: buildSelector(el),
    outerHTML: html.text,
    styles: readStyles(el),
  };
  if (html.truncated) described.outerHTMLTruncated = true;
  return described;
}

export function buildPayload(
  described: Described,
  rect: { x: number; y: number; width: number; height: number },
  win: Window,
): ElementPicked {
  return {
    type: 'ELEMENT_PICKED',
    element: {
      ...described,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    devicePixelRatio: win.devicePixelRatio,
    pageUrl: capText(win.location.href, FIELD.pageUrl).text,
    pageTitle: capText(win.document.title, FIELD.pageTitle).text,
  };
}
