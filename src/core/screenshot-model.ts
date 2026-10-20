import { SCREENSHOT } from './limits';

/** Why an element has no screenshot. A fixed list: raw Chrome errors are never stored. */
export const SCREENSHOT_REASONS = [
  'no-size',
  'offscreen',
  'tab-not-active',
  'page-changed',
  'rate-limited',
  'capture-failed',
  'too-large',
  'interrupted',
] as const;

export type ScreenshotReason = (typeof SCREENSHOT_REASONS)[number];

export function isScreenshotReason(value: unknown): value is ScreenshotReason {
  return typeof value === 'string' && (SCREENSHOT_REASONS as readonly string[]).includes(value);
}

/** Plain-language text for the popup. */
export const REASON_MESSAGES: Readonly<Record<ScreenshotReason, string>> = {
  'no-size': 'the element has no size',
  offscreen: 'the element is outside the visible area',
  'tab-not-active': 'the tab was not in front',
  'page-changed': 'the page changed, pick again',
  'rate-limited': 'Chrome limits screenshots, try again in a moment',
  'capture-failed': 'the capture failed',
  'too-large': 'the image is too large to keep',
  interrupted: 'it was interrupted, pick again',
};

export type ScreenshotStatus = 'pending' | 'captured' | 'clipped' | 'unavailable';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewportInfo extends Size {
  /** `documentElement.clientWidth/clientHeight`: the viewport without classic scrollbars. */
  clientWidth?: number;
  clientHeight?: number;
  devicePixelRatio: number;
}

/**
 * True when the element rect itself (without padding) is not fully inside the viewport. Padding
 * clipped at an edge is normal and does not count (plan N1).
 */
export function isClipped(rect: Rect, viewport: Size): boolean {
  const tolerance = SCREENSHOT.clipTolerance;
  return (
    rect.x < -tolerance ||
    rect.y < -tolerance ||
    rect.x + rect.width > viewport.width + tolerance ||
    rect.y + rect.height > viewport.height + tolerance
  );
}

/** Reasons to skip the capture from the geometry alone, before a rate-limited call is spent. */
export function elementProblem(rect: Rect, viewport: Size): 'no-size' | 'offscreen' | undefined {
  if (!(rect.width >= 1) || !(rect.height >= 1)) return 'no-size';
  if (
    rect.x >= viewport.width ||
    rect.y >= viewport.height ||
    rect.x + rect.width <= 0 ||
    rect.y + rect.height <= 0
  ) {
    return 'offscreen';
  }
  return undefined;
}

export interface Scale {
  x: number;
  y: number;
  /** True when neither candidate matched the bitmap, so the spec formula was used. */
  fallback: boolean;
}

function chooseAxis(bitmap: number, inner: number, client: number | undefined, dpr: number): { size: number; fallback: boolean } {
  const candidates = client !== undefined && Number.isFinite(client) && client > 0 && client !== inner ? [inner, client] : [inner];
  let best = candidates[0] as number;
  for (const candidate of candidates) {
    if (Math.abs(candidate * dpr - bitmap) < Math.abs(best * dpr - bitmap)) best = candidate;
  }
  const off = Math.abs(best * dpr - bitmap) / bitmap;
  return off > SCREENSHOT.scaleTolerance ? { size: inner, fallback: true } : { size: best, fallback: false };
}

/**
 * Scale from CSS px to bitmap px, per axis. The spec divides the bitmap by `innerWidth`, but a
 * bitmap that leaves out the page scrollbar would drift. Each axis picks the viewport size
 * (`inner` or `client`) whose `size * devicePixelRatio` is closest to the bitmap, and falls back
 * to `inner` when neither is within 2%.
 */
export function pickScale(bitmap: Size, viewport: ViewportInfo): Scale {
  const x = chooseAxis(bitmap.width, viewport.width, viewport.clientWidth, viewport.devicePixelRatio);
  const y = chooseAxis(bitmap.height, viewport.height, viewport.clientHeight, viewport.devicePixelRatio);
  return { x: bitmap.width / x.size, y: bitmap.height / y.size, fallback: x.fallback || y.fallback };
}

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The source rectangle in bitmap pixels: element plus padding, clamped to the bitmap. */
export function computeCrop(rect: Rect, scale: Scale, bitmap: Size, padding: number = SCREENSHOT.padding): Crop | undefined {
  const sx = Math.max(0, Math.floor((rect.x - padding) * scale.x));
  const sy = Math.max(0, Math.floor((rect.y - padding) * scale.y));
  const ex = Math.min(bitmap.width, Math.ceil((rect.x + rect.width + padding) * scale.x));
  const ey = Math.min(bitmap.height, Math.ceil((rect.y + rect.height + padding) * scale.y));
  const sw = ex - sx;
  const sh = ey - sy;
  if (!(sw >= 1) || !(sh >= 1)) return undefined;
  return { sx, sy, sw, sh };
}

/** Characters the data URL may use: the fixed cap, or the free session space, whichever is less. */
export function budgetChars(quota: number, inUse: number): number {
  return Math.max(0, Math.min(SCREENSHOT.maxDataUrl, quota - inUse - SCREENSHOT.storageMargin));
}

export type Fit =
  | { ok: true; dataUrl: string; width: number; height: number; steps: number }
  | { ok: false; reason: 'too-large' };

/**
 * Encodes the crop, shrinking it by 0.75 per step until the data URL fits the budget. The first
 * attempt is already limited to `maxSidePx`. `encode` draws the crop at the given size and
 * returns the PNG data URL. At most 1 + maxSteps encodes; stops early under `minSidePx`.
 */
export async function fitToBudget(
  encode: (width: number, height: number) => Promise<string>,
  crop: Size,
  budget: number,
): Promise<Fit> {
  if (budget <= 0) return { ok: false, reason: 'too-large' };
  const base = Math.min(1, SCREENSHOT.maxSidePx / Math.max(crop.width, crop.height));
  for (let step = 0; step <= SCREENSHOT.maxSteps; step++) {
    const factor = base * SCREENSHOT.scaleStep ** step;
    const width = Math.max(1, Math.floor(crop.width * factor));
    const height = Math.max(1, Math.floor(crop.height * factor));
    if (step > 0 && Math.max(width, height) < SCREENSHOT.minSidePx) break;
    const dataUrl = await encode(width, height);
    if (dataUrl.length <= budget) return { ok: true, dataUrl, width, height, steps: step };
  }
  return { ok: false, reason: 'too-large' };
}
