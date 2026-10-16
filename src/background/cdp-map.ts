import type { Protocol } from 'devtools-protocol';
import type { RawConsoleEntry, RawNetworkEntry } from '../core/types';

export interface RequestRecord {
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData: boolean;
  wallTimeMs: number;
  monotonicSeconds: number;
}

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

function baseNetworkEntry(request: RequestRecord): RawNetworkEntry {
  const entry: RawNetworkEntry = {
    method: request.method,
    url: request.url,
    status: null,
    requestHeaders: request.headers,
    timestamp: request.wallTimeMs,
  };
  if (request.postData !== undefined) entry.requestBody = request.postData;
  return entry;
}

export function mapResponse(
  event: Protocol.Network.ResponseReceivedEvent,
  request: RequestRecord | undefined,
): RawNetworkEntry | null {
  if (event.response.status < 400) return null;
  const record: RequestRecord = request ?? {
    requestId: event.requestId,
    method: 'GET',
    url: event.response.url,
    headers: {},
    hasPostData: false,
    wallTimeMs: Date.now(),
    monotonicSeconds: event.timestamp,
  };
  const entry = baseNetworkEntry(record);
  entry.status = event.response.status;
  entry.url = event.response.url || record.url;
  entry.durationMs = Math.max(0, Math.round((event.timestamp - record.monotonicSeconds) * 1000));
  return entry;
}

export function mapLoadingFailed(
  event: Protocol.Network.LoadingFailedEvent,
  request: RequestRecord | undefined,
): RawNetworkEntry | null {
  if (event.canceled === true || !request) return null;
  const parts = [event.errorText];
  if (event.blockedReason) parts.push(`blocked: ${event.blockedReason}`);
  if (event.corsErrorStatus) parts.push(`cors: ${event.corsErrorStatus.corsError}`);
  const entry = baseNetworkEntry(request);
  entry.errorText = parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0] ?? '';
  entry.durationMs = Math.max(0, Math.round((event.timestamp - request.monotonicSeconds) * 1000));
  return entry;
}
