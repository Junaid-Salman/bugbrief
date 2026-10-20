import type { Protocol } from 'devtools-protocol';
import {
  type BufferState,
  countsOf,
  getPending,
  insertConsole,
  insertNetwork,
  markedPending,
  setPending,
  takePending,
} from '../core/buffer-model';
import { FIELD, capText } from '../core/limits';
import { PAGE_METADATA_EXPRESSION, mergePageMetadata, sanitizePageMetadata } from '../core/page-metadata';
import type { NetworkEntry, PendingRequest, RawConsoleEntry } from '../core/types';
import type { BufferCounts, RecordingState } from '../shared/messages';
import { isRestrictedAttachError, isRestrictedUrl, RESTRICTED_MESSAGE } from '../shared/restricted';
import { createBuffer, type SessionStorageLike } from './buffer';
import {
  buildHttpErrorEntry,
  mapConsoleApi,
  mapException,
  mapLoadingFailed,
  mapLogEntry,
  markResponse,
  shouldFetchBody,
  trackRequest,
} from './cdp-map';
import { drain, TimeoutError, withTimeout } from './drain';
import { debugEnabled, log } from './log';
import { getCurrent, reconcile, setSessionLostHandler, setState } from './state';
import {
  DETACH_TIMEOUT_MS,
  DRAIN_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  FINISH_BUDGET_MS,
  METADATA_TIMEOUT_MS,
  START_STEP_TIMEOUT_MS,
} from './timeouts';

const PROTOCOL_VERSIONS = ['1.3', '0.1'] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FinishReason = 'stop' | 'canceled_by_user' | 'target_closed' | 'tab_removed';

const buffer = createBuffer(chrome.storage.session as unknown as SessionStorageLike, {
  log: (message, detail) => log.warn(`buffer: ${message}`, { error: errorMessage(detail) }),
});

const inFlight = new Set<Promise<unknown>>();
// One token per body fetch that is running. Finishing a session marks it abandoned, so a fetch
// that outlives the drain can no longer insert an entry after the session has stopped.
interface FetchToken {
  abandoned: boolean;
}
const fetching = new Map<string, FetchToken>();
let draining = false;
let finishing: Promise<RecordingState> | undefined;

// A session found dead (for example after a worker restart) still owns marked pending requests.
// Insert them without a body and save, exactly as a normal finish would.
setSessionLostHandler(async () => {
  insertUnfinishedMarked();
  await buffer.flush();
  log.info('session lost, pending requests finalized');
});

// Resolves once buffers are loaded and the stored state is verified, so events that wake the worker are not dropped.
export const ready: Promise<RecordingState> = (async () => {
  await buffer.rehydrate();
  try {
    return await reconcile();
  } catch {
    return { status: 'idle' } as RecordingState;
  }
})();


async function attachWithFallback(tabId: number): Promise<string> {
  const target: chrome.debugger.Debuggee = { tabId };
  let lastError: unknown;
  for (const version of PROTOCOL_VERSIONS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chrome.debugger.attach(target, version);
        return version;
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        if (/already attached/i.test(message) && attempt === 0) {
          // A stale session from a worker that died while attached. Detach, then retry once.
          await chrome.debugger.detach(target).catch(() => undefined);
          continue;
        }
        if (/version|protocol/i.test(message)) break;
        throw wrapAttachError(error);
      }
    }
  }
  throw wrapAttachError(lastError);
}

function wrapAttachError(error: unknown): Error {
  const message = errorMessage(error);
  if (isRestrictedAttachError(message)) return new Error(RESTRICTED_MESSAGE);
  if (/already attached/i.test(message)) {
    return new Error(`${message} Disable other debugging extensions on this tab and try again.`);
  }
  return new Error(message);
}

function sendBounded(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), START_STEP_TIMEOUT_MS).catch((error: unknown) => {
    if (error instanceof TimeoutError) throw new Error(`${method} timed out`);
    throw error;
  });
}

async function enableDomains(tabId: number): Promise<void> {
  await sendBounded(tabId, 'Runtime.enable');
  await sendBounded(tabId, 'Log.enable');
  await sendBounded(tabId, 'Page.enable');
  await sendBounded(tabId, 'Network.enable', {
    maxResourceBufferSize: 5_000_000,
    maxTotalBufferSize: 25_000_000,
  });
}

async function seedMainFrame(tabId: number, fallbackUrl: string | undefined): Promise<void> {
  let frameId: string | undefined;
  let url = fallbackUrl;
  try {
    const result = (await sendBounded(tabId, 'Page.getFrameTree')) as Protocol.Page.GetFrameTreeResponse;
    frameId = result.frameTree.frame.id;
    url = result.frameTree.frame.url;
  } catch (error) {
    log.warn('could not read the frame tree', { error: errorMessage(error) });
  }
  buffer.mutate((state) => {
    if (frameId) state.mainFrameId = frameId;
    if (url) state.pageUrl = capText(url, FIELD.pageUrl).text;
  });
}

// Start, Stop and Clear run one at a time. finishSession is not locked (it is already idempotent),
// so Cancel and tab-close events never wait here and a locked call can safely finish a session.
let lock: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = lock.then(task, task);
  lock = run.catch(() => undefined);
  return run;
}

async function startRecordingLocked(tabId: number): Promise<RecordingState> {
  await ready;
  const state = await reconcile();
  if (state.status === 'recording') {
    if (state.tabId === tabId) return state;
    await finishSession('stop');
  }

  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MESSAGE);

  const version = await attachWithFallback(tabId);
  try {
    await enableDomains(tabId);
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw new Error(`Could not enable debugging domains: ${errorMessage(error)}`);
  }

  try {
    inFlight.clear();
    fetching.clear();
    // Reset the buffer and set the recording state in the same tick, so no event can fall in a gap.
    const resetting = buffer.reset();
    const recording: RecordingState = { status: 'recording', tabId, startedAt: Date.now() };
    const setting = setState(recording);
    if (tab.url) buffer.mutate((current) => void (current.pageUrl = capText(tab.url as string, FIELD.pageUrl).text));
    await Promise.all([resetting, setting]);
    await seedMainFrame(tabId, tab.url);
    await readPageMetadata(tabId); // never throws; bounded to METADATA_TIMEOUT_MS
    log.info('recording started', { tabId, protocolVersion: version });
    return recording;
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    await setState({ status: 'idle' }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function startRecording(tabId: number): Promise<RecordingState> {
  return runExclusive(() => startRecordingLocked(tabId));
}

/**
 * Reads the page title and viewport and stores them, unless the session ended or restarted while
 * the read was in flight. `withTimeout` does not cancel the underlying command, so a read can
 * resolve after the flush, after Clear or after the next Start: the buffer generation taken
 * before the read is the session token, and a late value is dropped (P7, criterion 9). The read
 * never throws, so it cannot abort Start or delay Stop beyond its own bound.
 */
async function readPageMetadata(tabId: number): Promise<void> {
  const token = buffer.generation();
  // The URL the values are read for. Taken before the read: a navigation while it is in flight must not
  // label the old page's title with the new page's URL (BL-010).
  const forUrl = buffer.getState().pageUrl ?? '';
  let value: unknown;
  try {
    const result = (await withTimeout(
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: PAGE_METADATA_EXPRESSION, returnByValue: true }),
      METADATA_TIMEOUT_MS,
    )) as Protocol.Runtime.EvaluateResponse;
    value = result.exceptionDetails ? undefined : result.result.value;
  } catch (error) {
    log.warn('could not read page metadata', { error: errorMessage(error) });
    return;
  }
  if (!buffer.isCurrent(token)) return;
  buffer.mutate((state) => {
    const next = sanitizePageMetadata(value, forUrl);
    const merged = mergePageMetadata(state.page, next);
    if (merged) state.page = merged;
  });
  log.debug('page metadata', { hasTitle: buffer.getState().page?.title !== '', hasViewport: buffer.getState().page?.viewport !== undefined });
}

async function logSummary(reason: FinishReason): Promise<void> {
  const current = buffer.getState();
  const titles = (entries: typeof current.console) =>
    entries.map((entry) => `${entry.message.split('\n')[0]?.slice(0, 80)} (×${entry.count})`);
  const consoleTitles = titles(current.console);
  let bytes: number | undefined;
  try {
    bytes = await chrome.storage.session.getBytesInUse();
  } catch {
    bytes = undefined;
  }
  log.debug('buffer summary', {
    reason,
    counts: countsOf(current),
    firstConsole: consoleTitles.slice(0, 5),
    lastConsole: consoleTitles.slice(-5),
    network: current.network.map((entry) => ({
      entry: `${entry.method} ${safePath(entry.url)} ${entry.status ?? entry.errorText ?? 'ERR'} ×${entry.count}`,
      requestBodyLength: entry.requestBody?.length ?? 0,
      requestBodyTruncated: entry.requestBodyTruncated ?? false,
      responseBodyLength: entry.responseBody?.length ?? 0,
      responseBodyTruncated: entry.responseBodyTruncated ?? false,
      pageUrl: entry.pageUrl,
    })),
    pageUrl: current.pageUrl,
    storageBytesInUse: bytes,
    persistenceOk: buffer.persistenceOk(),
  });
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Inserts every marked 400+ response that has no entry yet, without a body, and clears pending.
 * A body fetch still running for one of them is abandoned so it cannot insert a second entry.
 */
function insertUnfinishedMarked(): void {
  buffer.mutate((current) => {
    for (const record of markedPending(current)) {
      const token = fetching.get(record.requestId);
      if (token) token.abandoned = true;
      insertNetwork(current, buildHttpErrorEntry(record));
    }
    current.pending = [];
  });
}

/** Pre-flush phase of Stop. Each step is time-limited, and the caller caps the whole thing. */
async function stopSequence(tabId: number): Promise<void> {
  const drained = await drain(inFlight, DRAIN_TIMEOUT_MS);
  if (!drained) log.warn('drain timed out', { inFlight: inFlight.size });
  // The capsule needs the page title and viewport in every build, so the read is not debug-only.
  await readPageMetadata(tabId);
  await withTimeout(chrome.debugger.detach({ tabId }), DETACH_TIMEOUT_MS).catch(() => undefined);
}

/**
 * The only place a session ends. Idempotent: Stop, banner Cancel and tab close can overlap and
 * share one run. Stop drains in-flight body fetches first. Cancel and tab close skip the drain
 * because the debugger is already gone. Nothing before the flush can block for longer than
 * FINISH_BUDGET_MS, so a frozen tab can never keep a session from reaching "stopped".
 */
export function finishSession(reason: FinishReason): Promise<RecordingState> {
  if (finishing) return finishing;
  const state = getCurrent();
  if (state.status !== 'recording') return Promise.resolve(state);

  const run = async (): Promise<RecordingState> => {
    if (reason === 'stop') {
      draining = true;
      await withTimeout(stopSequence(state.tabId), FINISH_BUDGET_MS).catch((error: unknown) => {
        log.warn('stop sequence did not finish', { error: errorMessage(error) });
      });
      // Safety net if a step above timed out before the detach ran. Detaching twice is harmless.
      void chrome.debugger.detach({ tabId: state.tabId }).catch(() => undefined);
    }
    insertUnfinishedMarked();
    await buffer.flush();
    const stopped: RecordingState = {
      status: 'stopped',
      tabId: state.tabId,
      startedAt: state.startedAt,
      stoppedAt: Date.now(),
    };
    await setState(stopped);
    log.info('recording stopped', { tabId: state.tabId, reason, counts: countsOf(buffer.getState()) });
    if (debugEnabled()) await logSummary(reason);
    return stopped;
  };

  finishing = run().finally(() => {
    draining = false;
    finishing = undefined;
  });
  return finishing;
}

export function stopRecording(): Promise<RecordingState> {
  return runExclusive(async () => {
    await ready;
    return finishSession('stop');
  });
}

export function clearBuffers(): Promise<RecordingState> {
  return runExclusive(async () => {
    await ready;
    if (getCurrent().status === 'recording') throw new Error('Stop recording before clearing.');
    await buffer.reset();
    const idle: RecordingState = { status: 'idle' };
    await setState(idle);
    return idle;
  });
}

export async function getCounts(): Promise<{ counts: BufferCounts; persistenceOk: boolean }> {
  await ready;
  return { counts: countsOf(buffer.getState()), persistenceOk: buffer.persistenceOk() };
}

function recordConsole(raw: RawConsoleEntry | null): void {
  if (!raw) return;
  const pageUrl = buffer.getState().pageUrl;
  const entry = pageUrl ? { ...raw, pageUrl } : raw;
  let result: ReturnType<typeof insertConsole> | undefined;
  buffer.mutate((state) => {
    result = insertConsole(state, entry);
  });
  if (result) logEntry('console', result.entry, result.merged);
}

function logEntry(kind: 'console' | 'network', entry: object, merged: boolean): void {
  const { rawHashes: _rawHashes, requestHeaders: _headers, seq: _seq, touched: _touched, ...printable } = entry as Record<string, unknown>;
  log.debug(kind, { merged, ...printable });
}

async function fetchResponseBody(tabId: number, record: PendingRequest, encodedDataLength: number): Promise<string | undefined> {
  if (!shouldFetchBody(record.mimeType, encodedDataLength)) return undefined;
  try {
    const result = (await withTimeout(
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: record.requestId }),
      FETCH_TIMEOUT_MS,
    )) as Protocol.Network.GetResponseBodyResponse;
    return result.base64Encoded ? undefined : result.body;
  } catch {
    return undefined;
  }
}

async function fetchRequestBody(tabId: number, record: PendingRequest): Promise<string | undefined> {
  if (record.postData !== undefined || !record.hasPostData) return undefined;
  try {
    const result = (await withTimeout(
      chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: record.requestId }),
      FETCH_TIMEOUT_MS,
    )) as Protocol.Network.GetRequestPostDataResponse;
    return result.base64Encoded ? undefined : result.postData;
  } catch {
    return undefined;
  }
}

function track(task: Promise<void>): void {
  const wrapped: Promise<void> = task.catch(() => undefined).finally(() => {
    inFlight.delete(wrapped);
  });
  inFlight.add(wrapped);
}

function finalizeMarked(tabId: number, record: PendingRequest, encodedDataLength: number): void {
  const token = buffer.generation();
  const fetchToken: FetchToken = { abandoned: false };
  fetching.set(record.requestId, fetchToken);
  track(
    (async () => {
      const [body, requestBody] = await Promise.all([
        fetchResponseBody(tabId, record, encodedDataLength),
        fetchRequestBody(tabId, record),
      ]);
      if (fetching.get(record.requestId) === fetchToken) fetching.delete(record.requestId);
      if (fetchToken.abandoned || !buffer.isCurrent(token)) return;
      const raw = buildHttpErrorEntry(record, body, requestBody);
      let result: { entry: NetworkEntry; merged: boolean } | undefined;
      buffer.mutate((state) => {
        takePending(state, record.requestId);
        result = insertNetwork(state, raw);
      });
      if (result) logEntry('network', result.entry, result.merged);
    })(),
  );
}

const DRAIN_METHODS = new Set(['Network.loadingFinished', 'Network.loadingFailed']);

export async function handleEvent(
  source: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || source.tabId !== state.tabId || !params) return;
  if (draining && !DRAIN_METHODS.has(method)) return;

  switch (method) {
    case 'Page.frameNavigated': {
      const frame = (params as Protocol.Page.FrameNavigatedEvent).frame;
      if (frame.parentId) break;
      buffer.mutate((current) => {
        current.mainFrameId = frame.id;
        current.pageUrl = capText(frame.url, FIELD.pageUrl).text;
      });
      break;
    }
    case 'Page.navigatedWithinDocument': {
      const event = params as Protocol.Page.NavigatedWithinDocumentEvent;
      if (event.frameId !== buffer.getState().mainFrameId) break;
      buffer.mutate((current) => {
        current.pageUrl = capText(event.url, FIELD.pageUrl).text;
      });
      break;
    }
    case 'Runtime.exceptionThrown':
      recordConsole(mapException(params as Protocol.Runtime.ExceptionThrownEvent));
      break;
    case 'Runtime.consoleAPICalled':
      recordConsole(mapConsoleApi(params as Protocol.Runtime.ConsoleAPICalledEvent));
      break;
    case 'Log.entryAdded':
      recordConsole(mapLogEntry(params as Protocol.Log.EntryAddedEvent));
      break;
    case 'Network.requestWillBeSent': {
      const record = trackRequest(params as Protocol.Network.RequestWillBeSentEvent);
      const pageUrl = buffer.getState().pageUrl;
      if (pageUrl) record.pageUrl = pageUrl;
      buffer.mutate((current) => setPending(current, record), false);
      break;
    }
    case 'Network.responseReceived': {
      const event = params as Protocol.Network.ResponseReceivedEvent;
      const marked = markResponse(getPending(buffer.getState(), event.requestId), event);
      if (marked) buffer.mutate((current) => setPending(current, marked));
      break;
    }
    case 'Network.loadingFinished': {
      const event = params as Protocol.Network.LoadingFinishedEvent;
      const record = getPending(buffer.getState(), event.requestId);
      if (record?.marked) finalizeMarked(state.tabId, record, event.encodedDataLength);
      else buffer.mutate((current) => void takePending(current, event.requestId), false);
      break;
    }
    case 'Network.loadingFailed': {
      const event = params as Protocol.Network.LoadingFailedEvent;
      const record = getPending(buffer.getState(), event.requestId);
      const raw = mapLoadingFailed(event, record);
      let result: { entry: NetworkEntry; merged: boolean } | undefined;
      buffer.mutate((current) => {
        takePending(current, event.requestId);
        if (raw) result = insertNetwork(current, raw);
      }, raw !== null || record?.marked === true);
      if (result) logEntry('network', result.entry, result.merged);
      break;
    }
    default:
      break;
  }
}

export async function handleDetach(source: chrome.debugger.Debuggee, reason: string): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || source.tabId !== state.tabId) return;
  log.info('debugger detached', { reason });
  await finishSession(reason === 'canceled_by_user' ? 'canceled_by_user' : 'target_closed');
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || state.tabId !== tabId) return;
  await finishSession('tab_removed');
}

/** The live buffer, for building a capsule. Callers must copy what they keep and never mutate it. */
export function getBufferState(): BufferState {
  return buffer.getState();
}

