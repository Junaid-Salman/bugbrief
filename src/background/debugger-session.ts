import type { Protocol } from 'devtools-protocol';
import {
  foldConsole,
  foldNetwork,
  toConsoleEntry,
  toNetworkEntry,
} from '../core/consolidate';
import type { ConsoleEntry, NetworkEntry } from '../core/types';
import type { RecordingState } from '../shared/messages';
import { isRestrictedAttachError, isRestrictedUrl, RESTRICTED_MESSAGE } from '../shared/restricted';
import {
  mapConsoleApi,
  mapException,
  mapLoadingFailed,
  mapLogEntry,
  mapResponse,
  trackRequest,
  type RequestRecord,
} from './cdp-map';
import { getCurrent, reconcile, setState } from './state';

const PROTOCOL_VERSIONS = ['1.3', '0.1'] as const;
const LOG_PREFIX = '[BugBrief]';

// P2 keeps these in memory only. P3 moves them into persisted buffers.
const consoleEntries = new Map<string, ConsoleEntry>();
const networkEntries = new Map<string, NetworkEntry>();
const pendingRequests = new Map<string, RequestRecord>();

// Resolves once the stored state is verified, so events that wake the worker are not dropped.
export const ready: Promise<RecordingState> = reconcile().catch(() => ({ status: 'idle' }) as RecordingState);

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
  await chrome.debugger.sendCommand(target, 'Network.enable', {
    maxResourceBufferSize: 5_000_000,
    maxTotalBufferSize: 25_000_000,
  });
}

function resetBuffers(): void {
  consoleEntries.clear();
  networkEntries.clear();
  pendingRequests.clear();
}

export async function startRecording(tabId: number): Promise<RecordingState> {
  await ready;
  const state = await reconcile();
  if (state.status === 'recording') {
    if (state.tabId === tabId) return state;
    await stopRecording();
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

  resetBuffers();
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

export async function stopRecording(): Promise<RecordingState> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording') return state;

  try {
    const result = (await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Runtime.evaluate', {
      expression: PAGE_METADATA_EXPRESSION,
      returnByValue: true,
    })) as Protocol.Runtime.EvaluateResponse;
    console.log(`${LOG_PREFIX} page metadata`, result.result.value);
  } catch (error) {
    console.warn(`${LOG_PREFIX} could not read page metadata`, errorMessage(error));
  }
  await chrome.debugger.detach({ tabId: state.tabId }).catch(() => undefined);
  return markStopped(state);
}

async function markStopped(state: Extract<RecordingState, { status: 'recording' }>): Promise<RecordingState> {
  const stopped: RecordingState = {
    status: 'stopped',
    tabId: state.tabId,
    startedAt: state.startedAt,
    stoppedAt: Date.now(),
  };
  await setState(stopped);
  console.log(`${LOG_PREFIX} recording stopped`, { tabId: state.tabId });
  return stopped;
}

function recordConsole(raw: ReturnType<typeof mapException> | null): void {
  if (!raw) return;
  const incoming = toConsoleEntry(raw);
  const existing = consoleEntries.get(incoming.fingerprint);
  const entry = existing ? foldConsole(existing, incoming) : incoming;
  consoleEntries.set(entry.fingerprint, entry);
  const { rawHashes: _rawHashes, ...printable } = entry;
  console.log(`${LOG_PREFIX} console`, { merged: existing !== undefined, ...printable });
}

function recordNetwork(raw: ReturnType<typeof mapResponse> | null): void {
  if (!raw) return;
  const incoming = toNetworkEntry(raw);
  const existing = networkEntries.get(incoming.fingerprint);
  const entry = existing ? foldNetwork(existing, incoming) : incoming;
  networkEntries.set(entry.fingerprint, entry);
  const { rawHashes: _rawHashes, requestHeaders: _headers, ...printable } = entry;
  console.log(`${LOG_PREFIX} network`, { merged: existing !== undefined, ...printable });
}

export async function handleEvent(
  source: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || source.tabId !== state.tabId || !params) return;

  switch (method) {
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
      pendingRequests.set(record.requestId, record);
      break;
    }
    case 'Network.responseReceived': {
      const event = params as Protocol.Network.ResponseReceivedEvent;
      recordNetwork(mapResponse(event, pendingRequests.get(event.requestId)));
      break;
    }
    case 'Network.loadingFailed': {
      const event = params as Protocol.Network.LoadingFailedEvent;
      recordNetwork(mapLoadingFailed(event, pendingRequests.get(event.requestId)));
      pendingRequests.delete(event.requestId);
      break;
    }
    case 'Network.loadingFinished':
      pendingRequests.delete((params as Protocol.Network.LoadingFinishedEvent).requestId);
      break;
    default:
      break;
  }
}

export async function handleDetach(source: chrome.debugger.Debuggee, reason: string): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || source.tabId !== state.tabId) return;
  console.log(`${LOG_PREFIX} debugger detached`, { reason });
  await markStopped(state);
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await ready;
  const state = getCurrent();
  if (state.status !== 'recording' || state.tabId !== tabId) return;
  await markStopped(state);
}
