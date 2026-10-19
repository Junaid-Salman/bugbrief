import type { PickedPage } from '../core/element-model';
import { FIELD, SCREENSHOT, capText } from '../core/limits';
import {
  budgetChars,
  computeCrop,
  elementProblem,
  fitToBudget,
  isClipped,
  pickScale,
  type Crop,
  type Rect,
  type ScreenshotReason,
} from '../core/screenshot-model';
import type { ElementStore } from './element';
import { log } from './log';

export interface TabInfo {
  active: boolean;
  windowId: number;
  /** Absent once `activeTab` is gone, which is what a navigation does (Q4). */
  url?: string;
}

export interface Bitmap {
  width: number;
  height: number;
  close(): void;
}

/** Everything that touches Chrome, the clock or a canvas, so the pipeline can be tested. */
export interface CaptureDeps {
  getTab(tabId: number): Promise<TabInfo | undefined>;
  capture(windowId: number): Promise<string>;
  decode(dataUrl: string): Promise<Bitmap>;
  /** Draws `crop` of `bitmap` at `width x height` and returns the PNG data URL. */
  encode(bitmap: Bitmap, crop: Crop, width: number, height: number): Promise<string>;
  storageBytesInUse(): Promise<number>;
  storageQuota(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CaptureRequest {
  tabId: number;
  rect: Rect;
  page: PickedPage;
}

export type CaptureResult =
  | { ok: true; dataUrl: string; width: number; height: number; clipped: boolean }
  | { ok: false; reason: ScreenshotReason };

const QUOTA_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds[^.]*quota/i;

/** Chrome error text can contain the page URL, so it is scrubbed before it is logged. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/"[^"]*"/g, '"…"')
    .slice(0, 120);
}

export function createCapturer(deps: CaptureDeps) {
  let lastCallAt: number | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  async function waitForSlot(): Promise<void> {
    if (lastCallAt === undefined) return;
    const wait = lastCallAt + SCREENSHOT.minGapMs - deps.now();
    if (wait > 0) await deps.sleep(wait);
  }

  /** captureVisibleTab, spaced from the previous call, retried on Chrome's per-second quota. */
  async function captureWithRetry(windowId: number): Promise<string | ScreenshotReason> {
    for (let attempt = 0; ; attempt++) {
      await waitForSlot();
      lastCallAt = deps.now();
      try {
        return await deps.capture(windowId);
      } catch (error) {
        if (!QUOTA_ERROR.test(error instanceof Error ? error.message : String(error))) {
          log.warn('capture failed', { error: safeMessage(error) });
          return 'capture-failed';
        }
        if (attempt >= SCREENSHOT.maxRetries) return 'rate-limited';
        await deps.sleep(SCREENSHOT.retryDelayMs);
      }
    }
  }

  /** Same tab, still in front, same page. Used before and after the capture. */
  async function tabProblem(tabId: number, pageUrl: string): Promise<{ reason: ScreenshotReason } | { windowId: number }> {
    let tab: TabInfo | undefined;
    try {
      tab = await deps.getTab(tabId);
    } catch {
      tab = undefined;
    }
    if (!tab || !tab.active) return { reason: 'tab-not-active' };
    // No URL means the activeTab grant is gone, which only a navigation or leaving the page does.
    if (tab.url === undefined || capText(tab.url, FIELD.pageUrl).text !== pageUrl) return { reason: 'page-changed' };
    return { windowId: tab.windowId };
  }

  async function run(request: CaptureRequest): Promise<CaptureResult> {
    const { rect, page } = request;
    const viewport = {
      width: page.viewport.width,
      height: page.viewport.height,
      clientWidth: page.clientWidth,
      clientHeight: page.clientHeight,
      devicePixelRatio: page.devicePixelRatio,
    };
    const problem = elementProblem(rect, viewport);
    if (problem) return { ok: false, reason: problem };

    const before = await tabProblem(request.tabId, page.url);
    if ('reason' in before) return { ok: false, reason: before.reason };

    const captured = await captureWithRetry(before.windowId);
    if (!captured.startsWith('data:')) return { ok: false, reason: captured as ScreenshotReason };

    // A tab switch or navigation during the capture means the image may not be the picked page.
    const after = await tabProblem(request.tabId, page.url);
    if ('reason' in after) return { ok: false, reason: after.reason };

    let bitmap: Bitmap;
    try {
      bitmap = await deps.decode(captured);
    } catch (error) {
      log.warn('decode failed', { error: safeMessage(error) });
      return { ok: false, reason: 'capture-failed' };
    }
    try {
      const scale = pickScale(bitmap, viewport);
      if (scale.fallback) log.info('screenshot scale fallback', {});
      const crop = computeCrop(rect, scale, bitmap);
      if (!crop) return { ok: false, reason: 'offscreen' };

      let inUse = 0;
      try {
        inUse = await deps.storageBytesInUse();
      } catch {
        // Unknown usage: the fixed cap still applies.
      }
      const budget = budgetChars(deps.storageQuota(), inUse);
      const fit = await fitToBudget((w, h) => deps.encode(bitmap, crop, w, h), { width: crop.sw, height: crop.sh }, budget);
      if (!fit.ok) return { ok: false, reason: fit.reason };
      return { ok: true, dataUrl: fit.dataUrl, width: fit.width, height: fit.height, clipped: isClipped(rect, viewport) };
    } catch (error) {
      log.warn('encode failed', { error: safeMessage(error) });
      return { ok: false, reason: 'capture-failed' };
    } finally {
      bitmap.close();
    }
  }

  return {
    /** Captures one pick. Calls run one at a time, so spacing and memory use stay bounded. */
    capture(request: CaptureRequest): Promise<CaptureResult> {
      const result = chain.then(() => run(request));
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

export type Capturer = ReturnType<typeof createCapturer>;

/**
 * Captures the element that was just stored and records the outcome. A result for a pick that is
 * no longer current is dropped by the store (Clear, a newer pick, a restart). Never throws.
 */
export async function captureForPick(capturer: Capturer, store: ElementStore): Promise<void> {
  const stored = store.get();
  if (!stored) return;
  const { pickedAt } = stored;
  const started = Date.now();
  try {
    const result = await capturer.capture({ tabId: stored.tabId, rect: stored.snapshot.rect, page: stored.page });
    if (result.ok) {
      const kept = store.setScreenshot(pickedAt, {
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
        clipped: result.clipped,
      });
      if (kept) {
        log.info('screenshot stored', { clipped: result.clipped, ms: Date.now() - started });
        log.debug('screenshot size', { width: result.width, height: result.height, chars: result.dataUrl.length });
      }
    } else if (store.markUnavailable(pickedAt, result.reason)) {
      log.info('screenshot unavailable', { reason: result.reason });
    }
  } catch (error) {
    log.warn('screenshot failed', { error: safeMessage(error) });
    store.markUnavailable(pickedAt, 'capture-failed');
  }
}

// --- Chrome and canvas adapters (covered by the manual checks; jsdom has no OffscreenCanvas) ---

const FALLBACK_QUOTA = 10_485_760;

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export function createChromeDeps(): CaptureDeps {
  return {
    async getTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const info: TabInfo = { active: tab.active, windowId: tab.windowId };
        if (tab.url !== undefined) info.url = tab.url;
        return info;
      } catch {
        return undefined; // the tab is gone
      }
    },
    capture: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    async decode(dataUrl) {
      const blob = await (await fetch(dataUrl)).blob();
      return createImageBitmap(blob);
    },
    async encode(bitmap, crop, width, height) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap as ImageBitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
      return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
    },
    storageBytesInUse: () => chrome.storage.session.getBytesInUse(null),
    storageQuota() {
      const quota = (chrome.storage.session as { QUOTA_BYTES?: unknown }).QUOTA_BYTES;
      return typeof quota === 'number' && Number.isFinite(quota) ? quota : FALLBACK_QUOTA;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

let shared: Capturer | undefined;

/** The one capturer the worker uses, created on first use so importing this file touches no API. */
export function sharedCapturer(): Capturer {
  shared ??= createCapturer(createChromeDeps());
  return shared;
}
