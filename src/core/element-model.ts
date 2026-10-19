import { FIELD, capText } from './limits';
import type { ElementSnapshot } from './types';

/** The computed styles the picker reads (spec §4.2). Shared with the worker so they cannot drift. */
export const STYLE_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'z-index',
  'overflow',
  'visibility',
  'opacity',
] as const;

const STYLE_SET: ReadonlySet<string> = new Set(STYLE_PROPERTIES);

export interface PickedPage {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
}

export interface PickedElement {
  /** `screenshotDataUrl` is an empty string until P6 captures it. */
  snapshot: ElementSnapshot;
  page: PickedPage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readRect(value: unknown): ElementSnapshot['rect'] | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return undefined;
  return { x, y, width, height };
}

/**
 * Validates an ELEMENT_PICKED message. Everything in it comes from the page's DOM, so it is
 * untrusted: wrong types reject the whole message, strings are capped on a code-point boundary,
 * and unknown style keys are dropped. Returns undefined when the message is unusable.
 */
export function sanitizePick(raw: unknown): PickedElement | undefined {
  if (!isRecord(raw) || !isRecord(raw.element) || !isRecord(raw.viewport)) return undefined;
  const { element, viewport } = raw;
  const { selector, outerHTML, styles } = element;
  if (typeof selector !== 'string' || selector.length === 0) return undefined;
  if (typeof outerHTML !== 'string' || !isRecord(styles)) return undefined;
  if (typeof raw.pageUrl !== 'string' || typeof raw.pageTitle !== 'string') return undefined;
  if (!finite(viewport.width) || !finite(viewport.height)) return undefined;
  if (!finite(raw.devicePixelRatio) || raw.devicePixelRatio <= 0) return undefined;
  const rect = readRect(element.rect);
  if (!rect) return undefined;

  const html = capText(outerHTML, FIELD.outerHTML);
  const cleanStyles: Record<string, string> = {};
  for (const [name, value] of Object.entries(styles)) {
    if (STYLE_SET.has(name) && typeof value === 'string') {
      cleanStyles[name] = capText(value, FIELD.styleValue).text;
    }
  }

  const snapshot: ElementSnapshot = {
    selector: capText(selector, FIELD.selector).text,
    outerHTML: html.text,
    styles: cleanStyles,
    rect,
    screenshotDataUrl: '',
  };
  if (html.truncated || element.outerHTMLTruncated === true) snapshot.outerHTMLTruncated = true;

  return {
    snapshot,
    page: {
      url: capText(raw.pageUrl, FIELD.pageUrl).text,
      title: capText(raw.pageTitle, FIELD.pageTitle).text,
      viewport: { width: viewport.width, height: viewport.height },
      devicePixelRatio: raw.devicePixelRatio,
    },
  };
}
