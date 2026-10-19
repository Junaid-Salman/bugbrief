/** Step 1: crop geometry, scale choice, clip rule, budget loop (criteria 1, 2, 3, 7). */
import { describe, expect, it } from 'vitest';
import { SCREENSHOT } from '../src/core/limits';
import {
  REASON_MESSAGES,
  SCREENSHOT_REASONS,
  budgetChars,
  computeCrop,
  elementProblem,
  fitToBudget,
  isClipped,
  isScreenshotReason,
  pickScale,
  type Scale,
} from '../src/core/screenshot-model';

const unit: Scale = { x: 1, y: 1, fallback: false };
const at = (scale: number): Scale => ({ x: scale, y: scale, fallback: false });

describe('computeCrop (criterion 1)', () => {
  const bitmap = { width: 1280, height: 800 };

  it('adds padding around a middle element', () => {
    expect(computeCrop({ x: 100, y: 200, width: 300, height: 100 }, unit, bitmap)).toEqual({ sx: 84, sy: 184, sw: 332, sh: 132 });
  });

  it.each([
    ['left', { x: 0, y: 300, width: 100, height: 50 }, { sx: 0, sy: 284, sw: 116, sh: 82 }],
    ['top', { x: 300, y: 0, width: 100, height: 50 }, { sx: 284, sy: 0, sw: 132, sh: 66 }],
    ['right', { x: 1180, y: 300, width: 100, height: 50 }, { sx: 1164, sy: 284, sw: 116, sh: 82 }],
    ['bottom', { x: 300, y: 750, width: 100, height: 50 }, { sx: 284, sy: 734, sw: 132, sh: 66 }],
    ['top-left corner', { x: 0, y: 0, width: 50, height: 50 }, { sx: 0, sy: 0, sw: 66, sh: 66 }],
    ['bottom-right corner', { x: 1230, y: 750, width: 50, height: 50 }, { sx: 1214, sy: 734, sw: 66, sh: 66 }],
  ])('clamps at the %s edge', (_label, rect, expected) => {
    expect(computeCrop(rect, unit, bitmap)).toEqual(expected);
  });

  it('clamps an element larger than the viewport to the bitmap', () => {
    expect(computeCrop({ x: -50, y: -50, width: 2000, height: 2000 }, unit, bitmap)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 800 });
  });

  it('floors the start and ceils the end of a fractional rect', () => {
    expect(computeCrop({ x: 100.6, y: 200.2, width: 10.3, height: 10.3 }, unit, bitmap)).toEqual({ sx: 84, sy: 184, sw: 43, sh: 43 });
  });

  it.each([1, 1.25, 1.5, 2])('scales padding and rect together at %s', (scale) => {
    const crop = computeCrop({ x: 100, y: 100, width: 100, height: 100 }, at(scale), { width: 3000, height: 3000 });
    expect(crop).toEqual({
      sx: Math.floor(84 * scale),
      sy: Math.floor(84 * scale),
      sw: Math.ceil(216 * scale) - Math.floor(84 * scale),
      sh: Math.ceil(216 * scale) - Math.floor(84 * scale),
    });
  });

  it('uses separate x and y scales', () => {
    const crop = computeCrop({ x: 100, y: 100, width: 100, height: 100 }, { x: 2, y: 1, fallback: false }, { width: 3000, height: 3000 });
    expect(crop).toEqual({ sx: 168, sy: 84, sw: 432 - 168, sh: 216 - 84 });
  });

  it('returns undefined when the rect is entirely outside the bitmap', () => {
    expect(computeCrop({ x: 5000, y: 5000, width: 10, height: 10 }, unit, bitmap)).toBeUndefined();
    expect(computeCrop({ x: -500, y: 300, width: 10, height: 10 }, unit, bitmap)).toBeUndefined();
  });
});

describe('elementProblem', () => {
  const viewport = { width: 1280, height: 800 };
  it('reports no size for a zero, tiny or NaN rect', () => {
    expect(elementProblem({ x: 0, y: 0, width: 0, height: 20 }, viewport)).toBe('no-size');
    expect(elementProblem({ x: 0, y: 0, width: 20, height: 0.5 }, viewport)).toBe('no-size');
    expect(elementProblem({ x: 0, y: 0, width: NaN, height: 20 }, viewport)).toBe('no-size');
  });
  it('reports offscreen when there is no overlap with the viewport', () => {
    expect(elementProblem({ x: 1280, y: 10, width: 20, height: 20 }, viewport)).toBe('offscreen');
    expect(elementProblem({ x: 10, y: 800, width: 20, height: 20 }, viewport)).toBe('offscreen');
    expect(elementProblem({ x: -30, y: 10, width: 30, height: 20 }, viewport)).toBe('offscreen');
    expect(elementProblem({ x: 10, y: -30, width: 20, height: 30 }, viewport)).toBe('offscreen');
  });
  it('accepts partly visible and fully visible elements', () => {
    expect(elementProblem({ x: -10, y: 10, width: 30, height: 20 }, viewport)).toBeUndefined();
    expect(elementProblem({ x: 10, y: 10, width: 30, height: 20 }, viewport)).toBeUndefined();
  });
});

describe('pickScale (criterion 2)', () => {
  it('uses innerWidth when the bitmap includes the scrollbar', () => {
    const scale = pickScale({ width: 2560, height: 1600 }, { width: 1280, height: 800, clientWidth: 1265, clientHeight: 800, devicePixelRatio: 2 });
    expect(scale).toEqual({ x: 2, y: 2, fallback: false });
  });

  it('uses clientWidth when the bitmap excludes the scrollbar', () => {
    const scale = pickScale({ width: 2530, height: 1600 }, { width: 1280, height: 800, clientWidth: 1265, clientHeight: 800, devicePixelRatio: 2 });
    expect(scale.x).toBeCloseTo(2530 / 1265, 10);
    expect(scale.y).toBe(2);
    expect(scale.fallback).toBe(false);
  });

  it('chooses each axis on its own', () => {
    const scale = pickScale({ width: 1265, height: 785 }, { width: 1280, height: 800, clientWidth: 1265, clientHeight: 785, devicePixelRatio: 1 });
    expect(scale).toEqual({ x: 1, y: 1, fallback: false });
  });

  it('works without a client size', () => {
    expect(pickScale({ width: 1920, height: 1200 }, { width: 1280, height: 800, devicePixelRatio: 1.5 })).toEqual({ x: 1.5, y: 1.5, fallback: false });
  });

  it('follows browser zoom through devicePixelRatio', () => {
    // 150% zoom on a 1x display: 1280 device px show 853.33 CSS px.
    const scale = pickScale({ width: 1280, height: 800 }, { width: 853.333, height: 533.333, devicePixelRatio: 1.5 });
    expect(scale.x).toBeCloseTo(1.5, 3);
    expect(scale.fallback).toBe(false);
  });

  it('falls back to the spec formula when neither candidate is within 2%', () => {
    const scale = pickScale({ width: 1000, height: 800 }, { width: 1280, height: 800, clientWidth: 1265, devicePixelRatio: 2 });
    expect(scale.fallback).toBe(true);
    expect(scale.x).toBeCloseTo(1000 / 1280, 10);
  });

  it('ignores a bad client size', () => {
    for (const clientWidth of [0, -5, NaN, Infinity]) {
      const scale = pickScale({ width: 1280, height: 800 }, { width: 1280, height: 800, clientWidth, devicePixelRatio: 1 });
      expect(scale).toEqual({ x: 1, y: 1, fallback: false });
    }
  });
});

describe('isClipped (criterion 3)', () => {
  const viewport = { width: 1280, height: 800 };
  it('is false for an element fully inside, including one that fits exactly', () => {
    expect(isClipped({ x: 10, y: 10, width: 100, height: 100 }, viewport)).toBe(false);
    expect(isClipped({ x: 0, y: 0, width: 1280, height: 800 }, viewport)).toBe(false);
  });
  it('is true when any edge leaves the viewport', () => {
    expect(isClipped({ x: -5, y: 10, width: 100, height: 100 }, viewport)).toBe(true);
    expect(isClipped({ x: 10, y: -5, width: 100, height: 100 }, viewport)).toBe(true);
    expect(isClipped({ x: 1200, y: 10, width: 100, height: 100 }, viewport)).toBe(true);
    expect(isClipped({ x: 10, y: 760, width: 100, height: 100 }, viewport)).toBe(true);
  });
  it('is not set by padding alone (an element touching the edge)', () => {
    expect(isClipped({ x: 0, y: 0, width: 100, height: 100 }, viewport)).toBe(false);
  });
  it('allows half a pixel of rounding', () => {
    expect(isClipped({ x: -0.4, y: 0, width: 100, height: 100 }, viewport)).toBe(false);
    expect(isClipped({ x: -0.6, y: 0, width: 100, height: 100 }, viewport)).toBe(true);
  });
});

describe('budgetChars', () => {
  it('is the fixed cap when storage is empty', () => {
    expect(budgetChars(10_485_760, 0)).toBe(SCREENSHOT.maxDataUrl);
  });
  it('shrinks with the free space minus the margin', () => {
    expect(budgetChars(10_485_760, 10_485_760 - SCREENSHOT.storageMargin - 1000)).toBe(1000);
  });
  it('is zero when storage is full', () => {
    expect(budgetChars(10_485_760, 10_485_760)).toBe(0);
    expect(budgetChars(1000, 5000)).toBe(0);
  });
});

describe('fitToBudget (criterion 7)', () => {
  // A fake encoder whose size shrinks with area: 1 character per 4 pixels.
  const encoder = () => {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      encode: async (width: number, height: number) => {
        calls.push([width, height]);
        return 'x'.repeat(Math.ceil((width * height) / 4));
      },
    };
  };

  it('fits at once', async () => {
    const { calls, encode } = encoder();
    const fit = await fitToBudget(encode, { width: 400, height: 300 }, 100_000);
    expect(fit).toMatchObject({ ok: true, width: 400, height: 300, steps: 0 });
    expect(calls).toEqual([[400, 300]]);
  });

  it('limits the first attempt to the longest side', async () => {
    const { calls, encode } = encoder();
    await fitToBudget(encode, { width: 6400, height: 3200 }, 10_000_000);
    expect(calls[0]).toEqual([SCREENSHOT.maxSidePx, SCREENSHOT.maxSidePx / 2]);
  });

  it('needs two steps when the first two attempts are too big', async () => {
    const { calls, encode } = encoder();
    // 800x600 = 120 000 chars, 600x450 = 67 500, 450x337 = 37 913
    const fit = await fitToBudget(encode, { width: 800, height: 600 }, 40_000);
    expect(fit).toMatchObject({ ok: true, steps: 2, width: 450, height: 337 });
    expect(calls).toHaveLength(3);
  });

  it('reports too-large when nothing fits, after at most 1 + maxSteps encodes', async () => {
    const { calls, encode } = encoder();
    const fit = await fitToBudget(encode, { width: 3000, height: 3000 }, 10);
    expect(fit).toEqual({ ok: false, reason: 'too-large' });
    expect(calls.length).toBeLessThanOrEqual(1 + SCREENSHOT.maxSteps);
  });

  it('stops shrinking below the minimum side', async () => {
    const { calls, encode } = encoder();
    const fit = await fitToBudget(encode, { width: 30, height: 30 }, 1);
    expect(fit).toEqual({ ok: false, reason: 'too-large' });
    expect(calls).toEqual([[30, 30]]);
  });

  it('does not encode at all with a zero budget (a nearly full storage)', async () => {
    const { calls, encode } = encoder();
    expect(await fitToBudget(encode, { width: 100, height: 100 }, 0)).toEqual({ ok: false, reason: 'too-large' });
    expect(calls).toEqual([]);
  });

  it('a lower budget forces more steps than a higher one', async () => {
    const roomy = await fitToBudget(encoder().encode, { width: 800, height: 600 }, budgetChars(10_485_760, 0));
    const tight = await fitToBudget(encoder().encode, { width: 800, height: 600 }, budgetChars(10_485_760, 10_485_760 - SCREENSHOT.storageMargin - 40_000));
    expect(roomy).toMatchObject({ ok: true, steps: 0 });
    expect(tight).toMatchObject({ ok: true, steps: 2 });
  });
});

describe('reasons', () => {
  it('has a plain-language message for every reason', () => {
    for (const reason of SCREENSHOT_REASONS) expect(REASON_MESSAGES[reason].length).toBeGreaterThan(5);
  });
  it('recognizes only the fixed list', () => {
    expect(isScreenshotReason('too-large')).toBe(true);
    expect(isScreenshotReason('Error: boom')).toBe(false);
    expect(isScreenshotReason(5)).toBe(false);
  });
});
