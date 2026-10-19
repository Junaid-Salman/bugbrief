import type { ConsoleEntry, NetworkEntry, RawConsoleEntry, RawNetworkEntry } from './types';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
const BIG_NUMBER = /\b\d{5,}\b/g;
const URL_QUERY = /(https?:\/\/[^\s'")?#]+)\?[^\s'")#]*(?:#[^\s'")]*)?/g;
const FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;

const MAX_RAW_HASHES = 20;
const TOP_FRAMES = 3;
const BODY_SIGNATURE_LENGTH = 120;

export function normalizeMessage(message: string): string {
  return message
    .replace(URL_QUERY, '$1')
    .replace(UUID, '<uuid>')
    .replace(ISO_TS, '<ts>')
    .replace(LONG_HEX, '<hex>')
    .replace(BIG_NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeFile(file: string): string {
  return file.replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, '');
}

export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^[0-9a-f]{12,}$/i.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');
}

export function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

function filePathKey(url: string | undefined): string {
  if (!url) return '';
  const parsed = parseUrl(url);
  const path = parsed ? parsed.pathname : url.split(/[?#]/)[0] ?? '';
  const segments = path.split('/');
  segments[segments.length - 1] = normalizeFile(lastSegment(path));
  return segments.join('/');
}

export function topFrameKeys(stack: string | undefined): string[] {
  if (!stack) return [];
  const keys: string[] = [];
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const fn = match[1] ?? '<anonymous>';
    const file = normalizeFile(lastSegment((match[2] ?? '').split(/[?#]/)[0] ?? ''));
    keys.push(`${fn}@${file}:${match[3]}:${match[4]}`);
    if (keys.length === TOP_FRAMES) break;
  }
  return keys;
}

export function consoleFingerprint(entry: RawConsoleEntry): string {
  const key = [
    entry.level,
    normalizeMessage(entry.message),
    topFrameKeys(entry.stack).join(';'),
    filePathKey(entry.url),
  ].join('|');
  return cyrb53(key);
}

export function networkFingerprint(entry: RawNetworkEntry): string {
  const parsed = parseUrl(entry.url);
  const path = normalizePath(parsed ? parsed.pathname : entry.url.split(/[?#]/)[0] ?? '');
  const outcome = entry.status !== null ? String(entry.status) : (entry.errorText ?? 'ERR');
  const bodySignature = normalizeMessage(entry.responseBody ?? '').slice(0, BODY_SIGNATURE_LENGTH);
  return cyrb53([entry.method.toUpperCase(), path, outcome, bodySignature].join('|'));
}

function consoleRawHash(entry: RawConsoleEntry): string {
  return cyrb53(`${entry.level}\n${entry.message}\n${entry.stack ?? ''}`, 1);
}

function networkRawHash(entry: RawNetworkEntry): string {
  return cyrb53(
    `${entry.url}\n${entry.errorText ?? ''}\n${entry.requestBody ?? ''}\n${entry.responseBody ?? ''}`,
    1,
  );
}

export function toConsoleEntry(raw: RawConsoleEntry): ConsoleEntry {
  return {
    ...raw,
    fingerprint: consoleFingerprint(raw),
    count: 1,
    lastSeen: raw.timestamp,
    variants: 1,
    rawHashes: [consoleRawHash(raw)],
  };
}

export function toNetworkEntry(raw: RawNetworkEntry): NetworkEntry {
  return {
    ...raw,
    fingerprint: networkFingerprint(raw),
    count: 1,
    lastSeen: raw.timestamp,
    variants: 1,
    rawHashes: [networkRawHash(raw)],
  };
}

function unionHashes(a: string[] | undefined, b: string[] | undefined): string[] {
  const merged = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return [...merged].slice(0, MAX_RAW_HASHES);
}

interface Foldable {
  timestamp: number;
  lastSeen: number;
  count: number;
  variants: number;
  rawHashes?: string[];
}

function fold<T extends Foldable>(existing: T, incoming: T): T {
  const [first, later] = existing.timestamp <= incoming.timestamp ? [existing, incoming] : [incoming, existing];
  const rawHashes = unionHashes(first.rawHashes, later.rawHashes);
  return {
    ...first,
    count: first.count + later.count,
    lastSeen: Math.max(first.lastSeen, later.lastSeen),
    rawHashes,
    variants: Math.min(MAX_RAW_HASHES, Math.max(first.variants, later.variants, rawHashes.length)),
  };
}

export function foldConsole(existing: ConsoleEntry, incoming: ConsoleEntry): ConsoleEntry {
  return fold(existing, incoming);
}

export function foldNetwork(existing: NetworkEntry, incoming: NetworkEntry): NetworkEntry {
  return fold(existing, incoming);
}

type Internal = { rawHashes?: string[]; seq?: number; touched?: number; relatedRequest?: number };

const INTERNAL_KEYS: readonly (keyof Internal)[] = ['rawHashes', 'seq', 'touched', 'relatedRequest'];

/**
 * The only place the internal-field list lives. Keeps everything else, including
 * `requestHeaders`, and drops `relatedRequest` too: its index is stale after a fold.
 */
export function stripInternal<T extends Internal>(entry: T): Omit<T, keyof Internal> {
  const rest: Record<string, unknown> = { ...entry };
  for (const key of INTERNAL_KEYS) delete rest[key];
  return rest as Omit<T, keyof Internal>;
}

function refold<T extends Foldable & { fingerprint: string }>(
  entries: T[],
  fingerprintOf: (entry: T) => string,
  foldPair: (existing: T, incoming: T) => T,
): T[] {
  const buckets = new Map<string, T>();
  for (const entry of entries) {
    // `fold` spreads the first entry, so the fingerprint is recomputed before bucketing.
    const next = { ...entry, fingerprint: fingerprintOf(entry) };
    const existing = buckets.get(next.fingerprint);
    buckets.set(next.fingerprint, existing ? foldPair(existing, next) : next);
  }
  // Array.prototype.sort is stable, so equal timestamps keep input order.
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Spec §4.5: after redaction, entries that differ only by a secret have the same fingerprint
 * and merge. Internal fields are stripped after the fold, because `variants` is computed from
 * the raw hashes. Linking and summaries stay in P7.
 */
export function refoldRedacted(
  consoleEntries: ConsoleEntry[],
  network: NetworkEntry[],
): { console: ConsoleEntry[]; network: NetworkEntry[] } {
  return {
    console: refold(consoleEntries, consoleFingerprint, foldConsole).map(stripInternal),
    network: refold(network, networkFingerprint, foldNetwork).map(stripInternal),
  };
}
