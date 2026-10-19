import type { PickedElement, PickedPage } from '../core/element-model';
import { redactSelector } from '../core/redact/redact-html';
import { redactUrl } from '../core/redact/redact-url';
import { isScreenshotReason, type ScreenshotReason } from '../core/screenshot-model';
import type { ElementSnapshot } from '../core/types';
import type { ElementSummary } from '../shared/messages';
import type { SessionStorageLike } from './buffer';
import { log } from './log';

export const ELEMENT_KEY = 'elementSnapshot';
/** The PNG lives under its own key so a quota failure loses the image, never the element (F2). */
export const SCREENSHOT_KEY = 'elementScreenshot';
const SUMMARY_SELECTOR_MAX = 60;

export type ScreenshotState =
  | { status: 'pending' }
  | { status: 'captured' }
  | { status: 'clipped' }
  | { status: 'unavailable'; reason: ScreenshotReason };

/** One picked element, raw like the buffer: it lives in session memory and is redacted by P7. */
export interface StoredElement {
  version: 1;
  tabId: number;
  /** Also the pick id: strictly increasing, so an image can be matched to its element. */
  pickedAt: number;
  page: PickedPage;
  snapshot: ElementSnapshot;
  screenshot: ScreenshotState;
}

export interface StoredShot {
  version: 1;
  pickedAt: number;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ShotInput {
  dataUrl: string;
  width: number;
  height: number;
  clipped: boolean;
}

const INTERRUPTED: ScreenshotState = { status: 'unavailable', reason: 'interrupted' };

function readState(value: unknown): ScreenshotState {
  if (value === null || typeof value !== 'object') return INTERRUPTED; // stored before P6
  const state = value as { status?: unknown; reason?: unknown };
  switch (state.status) {
    case 'pending':
    case 'captured':
    case 'clipped':
      return { status: state.status };
    case 'unavailable':
      return isScreenshotReason(state.reason) ? { status: 'unavailable', reason: state.reason } : INTERRUPTED;
    default:
      return INTERRUPTED;
  }
}

function isStored(value: unknown): value is StoredElement {
  if (value === null || typeof value !== 'object') return false;
  const stored = value as Partial<StoredElement>;
  return (
    stored.version === 1 &&
    typeof stored.tabId === 'number' &&
    typeof stored.pickedAt === 'number' &&
    stored.page !== undefined &&
    typeof stored.page.url === 'string' &&
    stored.snapshot !== undefined &&
    typeof stored.snapshot.selector === 'string'
  );
}

function isShot(value: unknown): value is StoredShot {
  if (value === null || typeof value !== 'object') return false;
  const shot = value as Partial<StoredShot>;
  return (
    shot.version === 1 &&
    typeof shot.pickedAt === 'number' &&
    typeof shot.dataUrl === 'string' &&
    shot.dataUrl.startsWith('data:image/png') &&
    typeof shot.width === 'number' &&
    typeof shot.height === 'number'
  );
}

export function summarize(stored: StoredElement): ElementSummary {
  const masked = redactSelector(stored.snapshot.selector).text;
  const summary: ElementSummary = {
    selector: masked.length > SUMMARY_SELECTOR_MAX ? `${masked.slice(0, SUMMARY_SELECTOR_MAX - 1)}…` : masked,
    tabId: stored.tabId,
    pageUrl: redactUrl(stored.page.url).text, // a query string can carry a token
    pickedAt: stored.pickedAt,
    screenshot: stored.screenshot.status,
  };
  if (stored.screenshot.status === 'unavailable') summary.reason = stored.screenshot.reason;
  return summary;
}

/**
 * Keeps one element snapshot (D4) and its screenshot. Memory changes at once; storage writes run
 * one at a time in order, so a late write can never resurrect a cleared snapshot, and an image is
 * only ever kept next to the element it was captured for (`pickedAt` must match).
 */
export function createElementStore(storage: SessionStorageLike, now: () => number = Date.now) {
  let current: StoredElement | undefined;
  let shot: StoredShot | undefined;
  let chain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    chain = chain.then(task).catch((error: unknown) => {
      log.warn('element store write failed', { error: error instanceof Error ? error.message : String(error) });
    });
    return chain;
  }

  function writeElement(): Promise<void> {
    const stored = current;
    return stored ? storage.set({ [ELEMENT_KEY]: stored }) : Promise.resolve();
  }

  return {
    get: (): StoredElement | undefined => current,
    summary: (): ElementSummary | undefined => (current ? summarize(current) : undefined),

    /** The element for P7, with the image and the flags filled in. `''` means no image. */
    snapshot(): ElementSnapshot | undefined {
      if (!current) return undefined;
      const merged: ElementSnapshot = { ...current.snapshot };
      const state = current.screenshot;
      if ((state.status === 'captured' || state.status === 'clipped') && shot && shot.pickedAt === current.pickedAt) {
        merged.screenshotDataUrl = shot.dataUrl;
        if (state.status === 'clipped') merged.screenshotClipped = true;
      } else if (state.status === 'unavailable') {
        merged.screenshotUnavailable = state.reason;
      } else if (state.status !== 'pending') {
        merged.screenshotUnavailable = 'interrupted'; // a status without its image
      }
      return merged;
    },

    /** Loads the stored element and image. Never rejects. */
    async rehydrate(): Promise<StoredElement | undefined> {
      try {
        const stored = await storage.get([ELEMENT_KEY, SCREENSHOT_KEY]);
        const element = stored[ELEMENT_KEY];
        const image = stored[SCREENSHOT_KEY];
        if (!isStored(element)) {
          current = undefined;
          shot = undefined;
          return undefined;
        }
        const state = readState((element as { screenshot?: unknown }).screenshot);
        current = { ...element, screenshot: state };
        shot = isShot(image) && image.pickedAt === element.pickedAt ? image : undefined;
        const hasImage = shot !== undefined;
        // A pending status means the worker died mid-capture. An image status needs its image.
        if (state.status === 'pending' || ((state.status === 'captured' || state.status === 'clipped') && !hasImage)) {
          current = { ...current, screenshot: INTERRUPTED };
          shot = undefined;
          void enqueue(writeElement);
        }
      } catch (error) {
        log.warn('element rehydrate failed', { error: error instanceof Error ? error.message : String(error) });
        current = undefined;
        shot = undefined;
      }
      return current;
    },

    /**
     * Replaces any earlier snapshot and drops its image first, in the same serialized task, so an
     * old image is never paired with a new element. The status starts as `pending`.
     */
    set(tabId: number, picked: PickedElement): Promise<void> {
      const previous = current?.pickedAt ?? 0;
      const stored: StoredElement = {
        version: 1,
        tabId,
        pickedAt: Math.max(now(), previous + 1),
        page: picked.page,
        snapshot: picked.snapshot,
        screenshot: { status: 'pending' },
      };
      current = stored;
      shot = undefined;
      return enqueue(async () => {
        try {
          await storage.remove([SCREENSHOT_KEY]);
        } catch (error) {
          // The pickedAt match keeps a leftover image from being used, so go on and store the element.
          log.warn('old screenshot not removed', { error: error instanceof Error ? error.message : String(error) });
        }
        await storage.set({ [ELEMENT_KEY]: stored });
      });
    },

    /**
     * Stores the image for the pick `pickedAt`. Returns false (and stores nothing) when that pick
     * is no longer the current one. The image is written before the status, so a worker that dies
     * in between leaves `pending`, which rehydrate turns into `interrupted`.
     */
    setScreenshot(pickedAt: number, input: ShotInput): boolean {
      if (current?.pickedAt !== pickedAt) return false;
      const image: StoredShot = { version: 1, pickedAt, dataUrl: input.dataUrl, width: input.width, height: input.height };
      const status: ScreenshotState = { status: input.clipped ? 'clipped' : 'captured' };
      current = { ...current, screenshot: status };
      shot = image;
      void enqueue(async () => {
        try {
          await storage.set({ [SCREENSHOT_KEY]: image });
        } catch (error) {
          log.warn('screenshot not stored', { error: error instanceof Error ? error.message : String(error) });
          if (current?.pickedAt === pickedAt) {
            current = { ...current, screenshot: { status: 'unavailable', reason: 'capture-failed' } };
            shot = undefined;
            await writeElement();
          }
          return;
        }
        if (current?.pickedAt === pickedAt) await writeElement();
      });
      return true;
    },

    /** Records why there is no image for the pick `pickedAt`. Returns false for a stale pick. */
    markUnavailable(pickedAt: number, reason: ScreenshotReason): boolean {
      if (current?.pickedAt !== pickedAt) return false;
      current = { ...current, screenshot: { status: 'unavailable', reason } };
      shot = undefined;
      void enqueue(writeElement);
      return true;
    },

    clear(): Promise<void> {
      current = undefined;
      shot = undefined;
      return enqueue(() => storage.remove([ELEMENT_KEY, SCREENSHOT_KEY]));
    },

    /** Resolves when every queued write has finished. */
    flush: (): Promise<void> => chain,
  };
}

export type ElementStore = ReturnType<typeof createElementStore>;

export const elements: ElementStore = createElementStore(chrome.storage.session);
export const elementsReady: Promise<StoredElement | undefined> = elements.rehydrate();
