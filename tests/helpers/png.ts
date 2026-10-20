import { inflateSync } from 'node:zlib';

export interface Png {
  width: number;
  height: number;
  channels: number;
  /** Raw, unfiltered pixel rows: width * channels bytes each. */
  rows: Uint8Array[];
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decodes a non-interlaced 8-bit PNG (what Chrome and ffmpeg write). Enough to read sizes and alpha. */
export function decodePng(data: Uint8Array): Png {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  while (offset < data.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[offset + 16] !== 8 || data[offset + 20] !== 0) throw new Error('Only 8-bit, non-interlaced PNGs are supported.');
      channels = CHANNELS[data[offset + 17]!] ?? 0;
      if (!channels) throw new Error('Unsupported PNG colour type.');
    } else if (type === 'IDAT') parts.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const prev = rows[y - 1];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth : 0;
      line[x] = (line[x]! + add) & 255;
    }
    rows.push(line);
  }
  return { width, height, channels, rows };
}

/** Alpha of one pixel (255 when the image has no alpha channel). */
export function alphaAt(png: Png, x: number, y: number): number {
  return png.channels === 4 ? png.rows[y]![x * 4 + 3]! : png.channels === 2 ? png.rows[y]![x * 2 + 1]! : 255;
}
