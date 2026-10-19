import type { PickedElement, PickedPage } from '../core/element-model';
import { redactSelector } from '../core/redact/redact-html';
import type { ElementSnapshot } from '../core/types';
import type { ElementSummary } from '../shared/messages';
import type { SessionStorageLike } from './buffer';
import { log } from './log';

export const ELEMENT_KEY = 'elementSnapshot';
const SUMMARY_SELECTOR_MAX = 60;

/** One picked element, raw like the buffer: it lives in session memory and is redacted by P7. */
export interface StoredElement {
  version: 1;
  tabId: number;
  pickedAt: number;
  page: PickedPage;
  snapshot: ElementSnapshot;
}

function isStored(value: unknown): value is StoredElement {
  if (value === null || typeof value !== 'object') return false;
  const stored = value as Partial<StoredElement>;
  return (
    stored.version === 1 &&
    typeof stored.tabId === 'number' &&
    typeof stored.pickedAt === 'number' &&
    stored.page !== undefined &&
    stored.snapshot !== undefined &&
    typeof stored.snapshot.selector === 'string'
  );
}

export function summarize(stored: StoredElement): ElementSummary {
  const masked = redactSelector(stored.snapshot.selector).text;
  return {
    selector: masked.length > SUMMARY_SELECTOR_MAX ? `${masked.slice(0, SUMMARY_SELECTOR_MAX - 1)}…` : masked,
    tabId: stored.tabId,
    pageUrl: stored.page.url,
    pickedAt: stored.pickedAt,
  };
}

/**
 * Keeps one element snapshot (D4). Memory changes at once; storage writes run one at a time in
 * order, so a late write can never resurrect a cleared snapshot.
 */
export function createElementStore(storage: SessionStorageLike, now: () => number = Date.now) {
  let current: StoredElement | undefined;
  let chain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    chain = chain.then(task).catch((error: unknown) => {
      log.warn('element store write failed', { error: error instanceof Error ? error.message : String(error) });
    });
    return chain;
  }

  return {
    get: (): StoredElement | undefined => current,
    summary: (): ElementSummary | undefined => (current ? summarize(current) : undefined),

    /** Loads the stored snapshot. Never rejects. */
    async rehydrate(): Promise<StoredElement | undefined> {
      try {
        const stored = (await storage.get([ELEMENT_KEY]))[ELEMENT_KEY];
        current = isStored(stored) ? stored : undefined;
      } catch (error) {
        log.warn('element rehydrate failed', { error: error instanceof Error ? error.message : String(error) });
        current = undefined;
      }
      return current;
    },

    /** Replaces any earlier snapshot. `screenshotDataUrl` stays '' until P6 fills it. */
    set(tabId: number, picked: PickedElement): Promise<void> {
      const stored: StoredElement = { version: 1, tabId, pickedAt: now(), page: picked.page, snapshot: picked.snapshot };
      current = stored;
      return enqueue(() => storage.set({ [ELEMENT_KEY]: stored }));
    },

    clear(): Promise<void> {
      current = undefined;
      return enqueue(() => storage.remove([ELEMENT_KEY]));
    },

    /** Resolves when every queued write has finished. */
    flush: (): Promise<void> => chain,
  };
}

export type ElementStore = ReturnType<typeof createElementStore>;

export const elements: ElementStore = createElementStore(chrome.storage.session);
export const elementsReady: Promise<StoredElement | undefined> = elements.rehydrate();
