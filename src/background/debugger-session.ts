import type { Protocol } from 'devtools-protocol';
import {
  countsOf,
  getPending,
  insertConsole,
  insertNetwork,
  markedPending,
  setPending,
  takePending,
} from '../core/buffer-model';
import { FIELD, capText } from '../core/limits';
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
import { drain, withTimeout } from './drain';
import { getCurrent, reconcile, setState } from './state';

const PROTOCOL_VERSIONS = ['1.3', '0.1'] as const;
const LOG_PREFIX = '[BugBrief]';
const FETCH_TIMEOUT_MS = 3000;
const DRAIN_TIMEOUT_MS = 2000;

export type FinishReason = 'stop' | 'canceled_by_user' | 'target_closed' | 'tab_removed';

const buffer = createBuffer(chrome.storage.session as unknown as SessionStorageLike, {
  log: (message, detail) => console.warn(`${LOG_PREFIX} buffer: ${message}`, detail),
});

const inFlight = new Set<Promise<unknown>>();
const fetching = new Set<string>();
let draining = false;
let finishing: Promise<RecordingState> | undefined;

// Resolves once buffers are loaded and the stored state is verified, so events that wake the worker are not dropped.
export const ready: Promise<RecordingState> = (async () => {
  await buffer.rehydrate();
  try {
    return await reconcile();
  } catch {
    return { status: 'idle' } as RecordingState;
  }
})();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

async function enableDomains(tabId: number): Promise<void> {
  const target: chrome.debugger.Debuggee = { tabId };
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Log.enable');
  await chrome.debugger.sendCommand(target, 'Page.enable');
  await chrome.debugger.sendCommand(target, 'Network.enable', {
    maxResourceBufferSize: 5_000_000,
    maxTotalBufferSize: 25_000_000,
  });
}

async function seedMainFrame(tabId: number, fallbackUrl: string | undefined): Promise<void> {
  let frameId: string | undefined;
  let url = fallbackUrl;
  try {
    const result = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')) as Protocol.Page.GetFrameTreeResponse;
    frameId = result.frameTree.frame.id;
    url = result.frameTree.frame.url;
  } catch (error) {
    console.warn(`${LOG_PREFIX} could not read the frame tree`, errorMessage(error));
  }
  buffer.mutate((state) => {
    if (frameId) state.mainFrameId = frameId;
    if (url) state.pageUrl = capText(url, FIELD.pageUrl).text;
  });
}

export async function startRecording(tabId: number): Promise<RecordingState> {
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

  await buffer.reset();
  inFlight.clear();
  fetching.clear();
  await seedMainFrame(tabId, tab.url);
  const recording: RecordingState = { status: 'recording', tabId, startedAt: Date.now() };
  await setState(recording);
  console.log(`${LOG_PREFIX} recording started`, { tabId, protocolVersion: version });
  return recording;
}

const PAGE_METADATA_EXPRESSION = `JSON.stringify({
  url: location.href,
  title: document.title,
  userAgent: navigator.userAgent,
  viewport: { width: innerWidth, height: innerHeight }
})`;

async function logPageMetadata(tabId: number): Promise<void> {
  try {
    const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: PAGE_METADATA_EXPRESSION,
      returnByValue: true,
    })) as Protocol.Runtime.EvaluateResponse;
    console.log(`${LOG_PREFIX} page metadata`, result.result.value);
  } catch (error) {
    console.warn(`${LOG_PREFIX} could not read page metadata`, errorMessage(error));
  }
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
  console.log(`${LOG_PREFIX} buffer summary`, {
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
 * The only place a session ends. Idempotent: Stop, banner Cancel and tab close can overlap and
 * share one run. Stop drains in-flight body fetches first. Cancel and tab close skip the drain
 * because the debugger is already gone.
 */
export function finishSession(reason: FinishReason): Promise<RecordingState> {
  if (finishing) return finishing;
  const state = getCurrent();
  if (state.status !== 'recording') return Promise.resolve(state);

  finishing = (async () => {
    try {
      if (reason === 'stop') {
        draining = true;
        await drain(inFlight, DRAIN_TIMEOUT_MS);
        await logPageMetadata(state.tabId);
        await chrome.debugger.detach({ tabId: state.tabId }).catch(() => undefined);
      }
      buffer.mutate((current) => {
        for (const record of markedPending(current)) {
          if (fetching.has(record.requestId)) continue;
          insertNetwork(current, buildHttpErrorEntry(record));
        }
        current.pending = [];
      });
      await buffer.flush();
      const stopped: RecordingState = {
        status: 'stopped',
        tabId: state.tabId,
        startedAt: state.startedAt,
        stoppedAt: Date.now(),
      };
      await setState(stopped);
      console.log(`${LOG_PREFIX} recording stopped`, { tabId: state.tabId, reason });
      await logSummary(reason);
      return stopped;
    } finally {
      draining = false;
      finishing = undefined;
    }
  })();
  return finishing;
}

export async function stopRecording(): Promise<RecordingState> {
  await ready;
  return finishSession('stop');
}

export async function clearBuffers(): Promise<RecordingState> {
  await ready;
  if (getCurrent().status === 'recording') throw new Error('Stop recording before clearing.');
  await buffer.reset();
  const idle: RecordingState = { status: 'idle' };
  await setState(idle);
  return idle;
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
  console.log(`${LOG_PREFIX} ${kind}`, { merged, ...printable });
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
  fetching.add(record.requestId);
  track(
    (async () => {
      const [body, requestBody] = await Promise.all([
        fetchResponseBody(tabId, record, encodedDataLength),
        fetchRequestBody(tabId, record),
      ]);
      fetching.delete(record.requestId);
      if (!buffer.isCurrent(token)) return;
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
  console.log(`${LOG_PREFIX} debugger detached`, { reason });
  await finishSession(reason === 'canceled_by_user' ? 'canceled_by_user' : 'target_closed');
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || state.tabId !== tabId) return;
  await finishSession('tab_removed');
}
