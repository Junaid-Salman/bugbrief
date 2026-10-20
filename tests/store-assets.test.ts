/** Store images (P10): sizes the dashboard accepts, and the 128 icon's required transparent padding. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alphaAt, decodePng } from './helpers/png';

const png = (path: string) => decodePng(new Uint8Array(readFileSync(new URL(`../${path}`, import.meta.url))));

describe('manifest icons', () => {
  it('has 16, 48 and 128 px icons of exactly those sizes', () => {
    for (const size of [16, 48, 128]) {
      const image = png(`public/icons/icon-${size}.png`);
      expect([image.width, image.height], `icon-${size}`).toEqual([size, size]);
    }
  });

  it('keeps a 16 px transparent border around the 128 icon, as the store asks', () => {
    const icon = png('public/icons/icon-128.png');
    expect(icon.channels).toBe(4);
    for (let i = 0; i < 128; i++) {
      for (const band of [0, 7, 15]) {
        expect(alphaAt(icon, i, band), `top ${band},${i}`).toBe(0);
        expect(alphaAt(icon, i, 127 - band), `bottom ${band},${i}`).toBe(0);
        expect(alphaAt(icon, band, i), `left ${band},${i}`).toBe(0);
        expect(alphaAt(icon, 127 - band, i), `right ${band},${i}`).toBe(0);
      }
    }
    expect(alphaAt(icon, 64, 64)).toBeGreaterThan(0);
  });
});

describe('store images', () => {
  it('has a 440x280 small promo tile', () => {
    const tile = png('store/assets/promo-small.png');
    expect([tile.width, tile.height]).toEqual([440, 280]);
  });

  it('has screenshots at 1280x800 or 640x400 (skipped until the owner adds them)', () => {
    const dir = new URL('../store/assets/', import.meta.url);
    const shots = existsSync(dir) ? readdirSync(dir).filter((name) => /^shot-\d\.png$/.test(name)) : [];
    expect(shots.length).toBeLessThanOrEqual(5);
    for (const name of shots) {
      const image = png(`store/assets/${name}`);
      expect([`${image.width}x${image.height}`], name).toSatisfy((value: string[]) => ['1280x800', '640x400'].includes(value[0]!));
    }
  });

  it('keeps a tracked copy of the logo', () => {
    expect(existsSync(new URL('../store/assets/logo.png', import.meta.url))).toBe(true);
  });
});
