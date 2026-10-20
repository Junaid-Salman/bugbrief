import { FIELD, capText } from './limits';

/** Title and viewport of a recorded page, and the page URL they were read for. */
export interface PageMetadata {
  title: string;
  viewport?: { width: number; height: number };
  /** The buffer's `pageUrl` when the values were read. A navigation makes them stale (Q19). */
  forUrl: string;
}

const MAX_VIEWPORT = 100_000;

/**
 * The expression runs in the page's own world, so everything it returns is page-controlled: the
 * page can redefine `document.title` or `innerWidth`. It returns a plain object (no
 * `JSON.stringify`, which a page can replace) and the result is validated before it is used.
 */
export const PAGE_METADATA_EXPRESSION = '({ title: document.title, width: innerWidth, height: innerHeight })';

function size(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_VIEWPORT ? value : undefined;
}

/**
 * Validates a `Runtime.evaluate` value. The title must be a string (cut to `FIELD.pageTitle`), the
 * viewport two finite positive integers. Anything else is left unset. Returns undefined when
 * nothing usable came back.
 */
export function sanitizePageMetadata(raw: unknown, forUrl: string): PageMetadata | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === 'string' ? capText(value.title, FIELD.pageTitle).text : '';
  const width = size(value.width);
  const height = size(value.height);
  const metadata: PageMetadata = { title, forUrl };
  if (width !== undefined && height !== undefined) metadata.viewport = { width, height };
  return title === '' && !metadata.viewport ? undefined : metadata;
}

/** Re-validates a value read back from storage, which can hold anything. */
export function sanitizeStoredPage(raw: unknown): PageMetadata | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const stored = raw as { title?: unknown; viewport?: { width?: unknown; height?: unknown } | null; forUrl?: unknown };
  if (typeof stored.forUrl !== 'string') return undefined;
  const viewport = stored.viewport !== null && typeof stored.viewport === 'object' ? stored.viewport : {};
  return sanitizePageMetadata({ title: stored.title, width: viewport.width, height: viewport.height }, stored.forUrl);
}

/**
 * Combines an earlier read with a newer one. A newer value wins, except that an empty title (a
 * page that is mid-load) never erases a non-empty one read for the same URL.
 */
export function mergePageMetadata(previous: PageMetadata | undefined, next: PageMetadata | undefined): PageMetadata | undefined {
  if (!next) return previous;
  if (!previous) return next;
  const sameUrl = previous.forUrl === next.forUrl;
  const title = next.title !== '' ? next.title : sameUrl ? previous.title : '';
  const viewport = next.viewport ?? (sameUrl ? previous.viewport : undefined);
  const merged: PageMetadata = { title, forUrl: next.forUrl };
  if (viewport) merged.viewport = viewport;
  return merged;
}

/** The stored metadata, only while it still describes the current page. */
export function pageFor(page: PageMetadata | undefined, pageUrl: string | undefined): PageMetadata | undefined {
  return page && pageUrl !== undefined && page.forUrl === pageUrl ? page : undefined;
}
