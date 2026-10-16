import type { Protocol } from 'devtools-protocol';
import type { PendingRequest, RawConsoleEntry, RawNetworkEntry } from '../core/types';

export type RequestRecord = PendingRequest;

const MAX_FETCHABLE_BODY_BYTES = 2_000_000;
const TEXTUAL_MIME = /^text\/|json|xml|javascript|x-www-form-urlencoded|ndjson|graphql/i;

export function formatStack(callFrames: Protocol.Runtime.CallFrame[] | undefined): string | undefined {
  if (!callFrames || callFrames.length === 0) return undefined;
  return callFrames
    .map((frame) => {
      const fn = frame.functionName || '<anonymous>';
      return `    at ${fn} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`;
    })
    .join('\n');
}

function splitDescription(description: string): { message: string; stack?: string } {
  const index = description.search(/\n\s+at /);
  if (index === -1) return { message: description };
  return { message: description.slice(0, index), stack: description.slice(index + 1) };
}

export function mapException(event: Protocol.Runtime.ExceptionThrownEvent): RawConsoleEntry {
  const details = event.exceptionDetails;
  const description = details.exception?.description;
  const split = description ? splitDescription(description) : { message: details.text };
  const stack = formatStack(details.stackTrace?.callFrames) ?? split.stack;
  const url = details.url ?? details.stackTrace?.callFrames[0]?.url;
  const entry: RawConsoleEntry = {
    level: 'error',
    message: split.message,
    timestamp: event.timestamp,
  };
  if (stack) entry.stack = stack;
  if (url) entry.url = url;
  return entry;
}

function argToString(arg: Protocol.Runtime.RemoteObject): string {
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  if (arg.description !== undefined) return arg.description;
  if (arg.preview?.properties) {
    const object: Record<string, string> = {};
    for (const property of arg.preview.properties) object[property.name] = property.value ?? '';
    return JSON.stringify(object);
  }
  return arg.type;
}

export function mapConsoleApi(event: Protocol.Runtime.ConsoleAPICalledEvent): RawConsoleEntry | null {
  if (event.type !== 'error' && event.type !== 'warning') return null;
  const frames = event.stackTrace?.callFrames;
  const entry: RawConsoleEntry = {
    level: event.type,
    message: event.args.map(argToString).join(' '),
    timestamp: event.timestamp,
  };
  const stack = formatStack(frames);
  if (stack) entry.stack = stack;
  const url = frames?.[0]?.url;
  if (url) entry.url = url;
  return entry;
}

export function mapLogEntry(event: Protocol.Log.EntryAddedEvent): RawConsoleEntry | null {
  const log = event.entry;
  if (log.level !== 'error' || log.source === 'network') return null;
  const entry: RawConsoleEntry = {
    level: 'error',
    message: log.text,
    timestamp: log.timestamp,
  };
  const stack = formatStack(log.stackTrace?.callFrames);
  if (stack) entry.stack = stack;
  if (log.url) entry.url = log.url;
  return entry;
}

export function trackRequest(event: Protocol.Network.RequestWillBeSentEvent): RequestRecord {
  const record: RequestRecord = {
    requestId: event.requestId,
    method: event.request.method,
    url: event.request.url,
    headers: { ...event.request.headers },
    hasPostData: event.request.hasPostData ?? false,
    wallTimeMs: Math.round(event.wallTime * 1000),
    monotonicSeconds: event.timestamp,
  };
  if (event.request.postData !== undefined) record.postData = event.request.postData;
  return record;
}

/** Marks a request that got a 400+ response. Returns null for lower statuses. */
export function markResponse(
  record: PendingRequest | undefined,
  event: Protocol.Network.ResponseReceivedEvent,
): PendingRequest | null {
  if (event.response.status < 400) return null;
  const base: PendingRequest = record ?? {
    requestId: event.requestId,
    method: 'GET',
    url: event.response.url,
    headers: {},
    hasPostData: false,
    wallTimeMs: Date.now(),
    monotonicSeconds: event.timestamp,
  };
  return {
    ...base,
    marked: true,
    status: event.response.status,
    mimeType: event.response.mimeType,
    responseUrl: event.response.url,
    responseMonotonicSeconds: event.timestamp,
  };
}

/** Decides whether to pull a body: text-like types only, skipping very large responses. */
export function shouldFetchBody(mimeType: string | undefined, encodedDataLength?: number): boolean {
  if (encodedDataLength !== undefined && encodedDataLength > MAX_FETCHABLE_BODY_BYTES) return false;
  if (!mimeType) return true;
  return TEXTUAL_MIME.test(mimeType);
}

function failureText(event: Protocol.Network.LoadingFailedEvent): string {
  const parts = [event.errorText];
  if (event.blockedReason) parts.push(`blocked: ${event.blockedReason}`);
  if (event.corsErrorStatus) parts.push(`cors: ${event.corsErrorStatus.corsError}`);
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : (parts[0] ?? '');
}

/** Builds the entry for a marked request. A missing body means it was skipped, failed or unfinished. */
export function buildHttpErrorEntry(
  record: PendingRequest,
  responseBody?: string,
  requestBody?: string,
  errorText?: string,
): RawNetworkEntry {
  const entry: RawNetworkEntry = {
    method: record.method,
    url: record.responseUrl || record.url,
    status: record.status ?? null,
    requestHeaders: record.headers,
    timestamp: record.wallTimeMs,
  };
  const body = requestBody ?? record.postData;
  if (body !== undefined) entry.requestBody = body;
  if (record.postDataTruncated) entry.requestBodyTruncated = true;
  if (responseBody !== undefined) entry.responseBody = responseBody;
  if (errorText) entry.errorText = errorText;
  if (record.pageUrl) entry.pageUrl = record.pageUrl;
  if (record.responseMonotonicSeconds !== undefined) {
    entry.durationMs = Math.max(0, Math.round((record.responseMonotonicSeconds - record.monotonicSeconds) * 1000));
  }
  return entry;
}

function baseNetworkEntry(request: PendingRequest): RawNetworkEntry {
  const entry: RawNetworkEntry = {
    method: request.method,
    url: request.url,
    status: null,
    requestHeaders: request.headers,
    timestamp: request.wallTimeMs,
  };
  if (request.postData !== undefined) entry.requestBody = request.postData;
  if (request.postDataTruncated) entry.requestBodyTruncated = true;
  if (request.pageUrl) entry.pageUrl = request.pageUrl;
  return entry;
}

/**
 * Maps a failed load. A request that already got a 400+ response keeps its status, including
 * when a reload canceled it mid-body. Other canceled loads are dropped.
 */
export function mapLoadingFailed(
  event: Protocol.Network.LoadingFailedEvent,
  request: PendingRequest | undefined,
): RawNetworkEntry | null {
  if (!request) return null;
  if (request.marked) return buildHttpErrorEntry(request, undefined, undefined, failureText(event));
  if (event.canceled === true) return null;
  const entry = baseNetworkEntry(request);
  entry.errorText = failureText(event);
  entry.durationMs = Math.max(0, Math.round((event.timestamp - request.monotonicSeconds) * 1000));
  return entry;
}
