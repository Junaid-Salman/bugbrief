/**
 * Reads from page nodes that cannot be fooled by the page (DOM clobbering).
 *
 * A `<form>` (and the `document`) exposes its named fields as properties that shadow built-ins:
 * with `<input name="id">`, `form.id` is the input, and `form.children`, `form.getAttribute`,
 * `form.getBoundingClientRect` and the rest can be replaced the same way. The picker reads page
 * nodes, so it reads them through the prototype accessors and methods instead. They are looked up
 * on the prototype at call time: in the content script's isolated world the prototypes are the
 * extension's own, so a page cannot replace them. Where a prototype lacks a member (jsdom has no
 * `scrollIntoView` or `elementsFromPoint`) the instance member is the fallback.
 *
 * `picker-dom.ts` and `picker-run.ts` must use only these helpers on page nodes. A test greps both
 * files for direct reads.
 */

type Proto = object;

function read<T>(target: object, proto: Proto, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (descriptor?.get) return descriptor.get.call(target) as T;
  return (target as Record<string, T>)[name] as T;
}

function call<T>(target: object, proto: Proto, name: string, ...args: unknown[]): T {
  const fn = (proto as Record<string, unknown>)[name];
  if (typeof fn === 'function') return (fn as (...a: unknown[]) => T).apply(target, args);
  return ((target as Record<string, unknown>)[name] as (...a: unknown[]) => T)(...args);
}

const ELEMENT = (): Proto => Element.prototype;
const NODE = (): Proto => Node.prototype;
const DOCUMENT = (): Proto => Document.prototype;

export function idOf(el: Element): string {
  return read<string>(el, ELEMENT(), 'id');
}

export function attrOf(el: Element, name: string): string | null {
  return call<string | null>(el, ELEMENT(), 'getAttribute', name);
}

/** Class names from the `class` attribute, which also works for SVG elements. */
export function classNamesOf(el: Element): string[] {
  return (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean);
}

export function localNameOf(el: Element): string {
  return read<string>(el, ELEMENT(), 'localName');
}

export function namespaceOf(el: Element): string | null {
  return read<string | null>(el, ELEMENT(), 'namespaceURI');
}

export function outerHTMLOf(el: Element): string {
  return read<string>(el, ELEMENT(), 'outerHTML');
}

export function shadowRootOf(el: Element): ShadowRoot | null {
  return read<ShadowRoot | null>(el, ELEMENT(), 'shadowRoot');
}

export function parentElementOf(node: Node): Element | null {
  return read<Element | null>(node, NODE(), 'parentElement');
}

export function parentNodeOf(node: Node): ParentNode | null {
  return read<ParentNode | null>(node, NODE(), 'parentNode');
}

export function rootNodeOf(node: Node): Node {
  return call<Node>(node, NODE(), 'getRootNode');
}

export function ownerDocumentOf(node: Node): Document | null {
  return read<Document | null>(node, NODE(), 'ownerDocument');
}

export function nodeTypeOf(node: Node): number {
  return read<number>(node, NODE(), 'nodeType');
}

/** `children` of an element, a document or a shadow root. */
export function childrenOf(parent: ParentNode): Element[] {
  const type = nodeTypeOf(parent as Node);
  const proto = type === 9 ? DOCUMENT() : type === 11 ? DocumentFragment.prototype : ELEMENT();
  return Array.from(read<HTMLCollection>(parent, proto, 'children'));
}

export function querySelectorAllOf(root: ParentNode, selector: string): Element[] {
  const type = nodeTypeOf(root as Node);
  const proto = type === 9 ? DOCUMENT() : type === 11 ? DocumentFragment.prototype : ELEMENT();
  return Array.from(call<NodeListOf<Element>>(root, proto, 'querySelectorAll', selector));
}

export function rectOf(el: Element): DOMRect {
  return call<DOMRect>(el, ELEMENT(), 'getBoundingClientRect');
}

export function scrollIntoViewOf(el: Element, options: ScrollIntoViewOptions): void {
  call<void>(el, ELEMENT(), 'scrollIntoView', options);
}

export function titleOf(doc: Document): string {
  return read<string>(doc, DOCUMENT(), 'title');
}

export function defaultViewOf(doc: Document): Window | null {
  return read<Window | null>(doc, DOCUMENT(), 'defaultView');
}

export function documentElementOf(doc: Document): HTMLElement {
  return read<HTMLElement>(doc, DOCUMENT(), 'documentElement');
}

export function createElementOf<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
  return call<HTMLElementTagNameMap[K]>(doc, DOCUMENT(), 'createElement', tag);
}

export function elementsFromPointOf(doc: Document, x: number, y: number): Element[] {
  return call<Element[]>(doc, DOCUMENT(), 'elementsFromPoint', x, y);
}

export function visibilityStateOf(doc: Document): DocumentVisibilityState {
  return read<DocumentVisibilityState>(doc, DOCUMENT(), 'visibilityState');
}
