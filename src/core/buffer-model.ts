import type { PageMetadata } from './page-metadata';
import { sanitizeStoredPage } from './page-metadata';
import { foldConsole, foldNetwork, toConsoleEntry, toNetworkEntry } from './consolidate';
import {
  CONSOLE_CAP,
  FIELD,
  NETWORK_CAP,
  PENDING_CAP,
  PENDING_PERSIST_CAP,
  ROOT_CAUSE_WINDOW,
  TRIMMED_BODY_LIMIT,
  capHeaders,
  capText,
} from './limits';
import type { EvictedTally, BufferCounts } from '../shared/messages';
import type {
  ConsoleEntry,
  NetworkEntry,
  PendingRequest,
  RawConsoleEntry,
  RawNetworkEntry,
} from './types';

export interface BufferState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pending: PendingRequest[];
  nextSeq: number;
  pageUrl?: string;
  /** Read at Start and Stop (P7). Absent until a read succeeds. */
  page?: PageMetadata;
  mainFrameId?: string;
  evicted: { console: EvictedTally; network: EvictedTally };
}

export const KEYS = {
  console: 'buffer.console',
  network: 'buffer.network',
  pending: 'buffer.pending',
  meta: 'buffer.meta',
} as const;

export function emptyState(): BufferState {
  return {
    console: [],
    network: [],
    pending: [],
    nextSeq: 1,
    evicted: {
      console: { entries: 0, occurrences: 0 },
      network: { entries: 0, occurrences: 0 },
    },
  };
}

interface Ordered {
  seq?: number;
  touched?: number;
  count: number;
}

/**
 * Evicts the least recently touched entry outside the root-cause window (the earliest
 * ROOT_CAUSE_WINDOW entries by insertion order). The entry being inserted is exempt.
 */
function evictToCap<T extends Ordered>(entries: T[], cap: number, tally: EvictedTally, exempt: T | undefined): void {
  while (entries.length > cap) {
    const protectedEntries = new Set(
      [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(0, ROOT_CAUSE_WINDOW),
    );
    let victim: T | undefined;
    for (const entry of entries) {
      if (protectedEntries.has(entry) || entry === exempt) continue;
      if (
        victim === undefined ||
        (entry.touched ?? 0) < (victim.touched ?? 0) ||
        ((entry.touched ?? 0) === (victim.touched ?? 0) && (entry.seq ?? 0) < (victim.seq ?? 0))
      ) {
        victim = entry;
      }
    }
    if (victim === undefined) return;
    entries.splice(entries.indexOf(victim), 1);
    tally.entries += 1;
    tally.occurrences += victim.count;
  }
}

function capConsole(raw: RawConsoleEntry): RawConsoleEntry {
  const capped: RawConsoleEntry = { ...raw, message: capText(raw.message, FIELD.consoleMessage).text };
  if (raw.stack !== undefined) capped.stack = capText(raw.stack, FIELD.consoleStack).text;
  if (raw.url !== undefined) capped.url = capText(raw.url, FIELD.consoleUrl).text;
  if (raw.pageUrl !== undefined) capped.pageUrl = capText(raw.pageUrl, FIELD.pageUrl).text;
  return capped;
}

function capNetwork(raw: RawNetworkEntry): RawNetworkEntry {
  const capped: RawNetworkEntry = {
    ...raw,
    url: capText(raw.url, FIELD.networkUrl).text,
    requestHeaders: capHeaders(raw.requestHeaders),
  };
  if (raw.errorText !== undefined) capped.errorText = capText(raw.errorText, FIELD.errorText).text;
  if (raw.pageUrl !== undefined) capped.pageUrl = capText(raw.pageUrl, FIELD.pageUrl).text;
  if (raw.requestBody !== undefined) {
    const body = capText(raw.requestBody, FIELD.requestBody);
    capped.requestBody = body.text;
    if (body.truncated || raw.requestBodyTruncated) capped.requestBodyTruncated = true;
  }
  if (raw.responseBody !== undefined) {
    const body = capText(raw.responseBody, FIELD.responseBody);
    capped.responseBody = body.text;
    if (body.truncated || raw.responseBodyTruncated) capped.responseBodyTruncated = true;
  }
  return capped;
}

export interface Inserted<T> {
  entry: T;
  merged: boolean;
}

export function insertConsole(state: BufferState, raw: RawConsoleEntry): Inserted<ConsoleEntry> {
  const incoming = toConsoleEntry(capConsole(raw));
  const index = state.console.findIndex((entry) => entry.fingerprint === incoming.fingerprint);
  const touched = state.nextSeq++;
  const existing = index >= 0 ? state.console[index] : undefined;
  if (existing) {
    const merged = foldConsole(existing, incoming);
    merged.seq = existing.seq ?? touched;
    merged.touched = touched;
    state.console[index] = merged;
    return { entry: merged, merged: true };
  }
  incoming.seq = touched;
  incoming.touched = touched;
  state.console.push(incoming);
  evictToCap(state.console, CONSOLE_CAP, state.evicted.console, incoming);
  return { entry: incoming, merged: false };
}

export function insertNetwork(state: BufferState, raw: RawNetworkEntry): Inserted<NetworkEntry> {
  const incoming = toNetworkEntry(capNetwork(raw));
  const index = state.network.findIndex((entry) => entry.fingerprint === incoming.fingerprint);
  const touched = state.nextSeq++;
  const existing = index >= 0 ? state.network[index] : undefined;
  if (existing) {
    const merged = foldNetwork(existing, incoming);
    merged.seq = existing.seq ?? touched;
    merged.touched = touched;
    state.network[index] = merged;
    return { entry: merged, merged: true };
  }
  incoming.seq = touched;
  incoming.touched = touched;
  state.network.push(incoming);
  evictToCap(state.network, NETWORK_CAP, state.evicted.network, incoming);
  return { entry: incoming, merged: false };
}

export function setPending(state: BufferState, record: PendingRequest): void {
  const capped: PendingRequest = {
    ...record,
    url: capText(record.url, FIELD.networkUrl).text,
    headers: capHeaders(record.headers),
  };
  if (record.pageUrl !== undefined) capped.pageUrl = capText(record.pageUrl, FIELD.pageUrl).text;
  if (record.postData !== undefined) {
    const body = capText(record.postData, FIELD.requestBody);
    capped.postData = body.text;
    if (body.truncated || record.postDataTruncated) capped.postDataTruncated = true;
  }
  const index = state.pending.findIndex((item) => item.requestId === record.requestId);
  if (index >= 0) {
    state.pending[index] = capped;
    return;
  }
  state.pending.push(capped);
  while (state.pending.length > PENDING_CAP) {
    const drop = state.pending.findIndex((item) => !item.marked);
    state.pending.splice(drop >= 0 ? drop : 0, 1);
  }
}

export function getPending(state: BufferState, requestId: string): PendingRequest | undefined {
  return state.pending.find((item) => item.requestId === requestId);
}

export function takePending(state: BufferState, requestId: string): PendingRequest | undefined {
  const index = state.pending.findIndex((item) => item.requestId === requestId);
  if (index < 0) return undefined;
  return state.pending.splice(index, 1)[0];
}

export function markedPending(state: BufferState): PendingRequest[] {
  return state.pending.filter((item) => item.marked === true);
}

export function countsOf(state: BufferState): BufferCounts {
  const total = (entries: Ordered[]) => entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    console: { unique: state.console.length, total: total(state.console), evicted: { ...state.evicted.console } },
    network: { unique: state.network.length, total: total(state.network), evicted: { ...state.evicted.network } },
  };
}

/** Cuts stored bodies down to `limit` characters, flagging them as truncated. */
export function trimBodies(state: BufferState, limit = TRIMMED_BODY_LIMIT): void {
  for (const entry of state.network) {
    if (entry.responseBody !== undefined && entry.responseBody.length > limit) {
      entry.responseBody = capText(entry.responseBody, limit).text;
      entry.responseBodyTruncated = true;
    }
    if (entry.requestBody !== undefined && entry.requestBody.length > limit) {
      entry.requestBody = capText(entry.requestBody, limit).text;
      entry.requestBodyTruncated = true;
    }
  }
}

/** Last-resort shrink: evicts the least recently touched unprotected entry, network first. */
export function shrinkOne(state: BufferState): boolean {
  for (const [entries, tally] of [
    [state.network, state.evicted.network],
    [state.console, state.evicted.console],
  ] as const) {
    if (entries.length <= ROOT_CAUSE_WINDOW) continue;
    const before = entries.length;
    evictToCap<Ordered & (ConsoleEntry | NetworkEntry)>(
      entries as (ConsoleEntry | NetworkEntry)[],
      before - 1,
      tally,
      undefined,
    );
    if (entries.length < before) return true;
  }
  return false;
}

export function serialize(state: BufferState, includePending: boolean): Record<string, unknown> {
  return {
    [KEYS.console]: state.console,
    [KEYS.network]: state.network,
    [KEYS.pending]: includePending ? markedPending(state).slice(-PENDING_PERSIST_CAP) : [],
    [KEYS.meta]: {
      pageUrl: state.pageUrl,
      page: state.page,
      mainFrameId: state.mainFrameId,
      nextSeq: state.nextSeq,
      evicted: state.evicted,
    },
  };
}

function isEntry(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { fingerprint?: unknown }).fingerprint === 'string' &&
    typeof (value as { count?: unknown }).count === 'number'
  );
}

function isPending(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { requestId?: unknown }).requestId === 'string';
}

function tallyOf(value: unknown): EvictedTally {
  const tally = value as Partial<EvictedTally> | undefined;
  return {
    entries: typeof tally?.entries === 'number' ? tally.entries : 0,
    occurrences: typeof tally?.occurrences === 'number' ? tally.occurrences : 0,
  };
}

/** Builds a state from stored values. Any key with the wrong shape resets to empty. */
export function rehydrateState(stored: Record<string, unknown>): BufferState {
  const state = emptyState();
  const consoleEntries = stored[KEYS.console];
  const networkEntries = stored[KEYS.network];
  const pending = stored[KEYS.pending];
  if (Array.isArray(consoleEntries) && consoleEntries.every(isEntry)) state.console = consoleEntries as ConsoleEntry[];
  if (Array.isArray(networkEntries) && networkEntries.every(isEntry)) state.network = networkEntries as NetworkEntry[];
  if (Array.isArray(pending) && pending.every(isPending)) state.pending = pending as PendingRequest[];
  const meta = stored[KEYS.meta] as
    | { pageUrl?: unknown; page?: unknown; mainFrameId?: unknown; nextSeq?: unknown; evicted?: { console?: unknown; network?: unknown } }
    | undefined;
  if (meta && typeof meta === 'object') {
    if (typeof meta.pageUrl === 'string') state.pageUrl = meta.pageUrl;
    const page = sanitizeStoredPage(meta.page); // absent in data stored by an older build
    if (page) state.page = page;
    if (typeof meta.mainFrameId === 'string') state.mainFrameId = meta.mainFrameId;
    if (typeof meta.nextSeq === 'number') state.nextSeq = meta.nextSeq;
    state.evicted = { console: tallyOf(meta.evicted?.console), network: tallyOf(meta.evicted?.network) };
  }
  const highest = Math.max(0, ...[...state.console, ...state.network].map((entry) => entry.touched ?? entry.seq ?? 0));
  state.nextSeq = Math.max(state.nextSeq, highest + 1);
  return state;
}
