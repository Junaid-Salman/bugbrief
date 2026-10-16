import { describe, expect, it } from 'vitest';
import type { Protocol } from 'devtools-protocol';
import {
  formatStack,
  mapConsoleApi,
  mapException,
  mapLoadingFailed,
  mapLogEntry,
  mapResponse,
  trackRequest,
} from '../src/background/cdp-map';

const frame = (functionName: string, url: string, lineNumber: number, columnNumber: number) => ({
  functionName,
  scriptId: '1',
  url,
  lineNumber,
  columnNumber,
});

const requestEvent = (overrides: Partial<Protocol.Network.Request> = {}): Protocol.Network.RequestWillBeSentEvent =>
  ({
    requestId: 'r1',
    loaderId: 'l1',
    documentURL: 'http://localhost:5174/',
    request: {
      url: 'http://localhost:5174/api/orders',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      initialPriority: 'High',
      referrerPolicy: 'no-referrer',
      hasPostData: true,
      postData: '{"item":1}',
      ...overrides,
    },
    timestamp: 100,
    wallTime: 1_760_000_000,
    initiator: { type: 'script' },
    redirectHasExtraInfo: false,
  }) as Protocol.Network.RequestWillBeSentEvent;

describe('formatStack', () => {
  it('converts 0-based positions to 1-based', () => {
    expect(formatStack([frame('OrderList', 'http://x/main.js', 141, 17)])).toBe(
      '    at OrderList (http://x/main.js:142:18)',
    );
  });
  it('labels anonymous frames', () => {
    expect(formatStack([frame('', 'http://x/a.js', 0, 0)])).toBe('    at <anonymous> (http://x/a.js:1:1)');
  });
  it('returns undefined for missing or empty stacks', () => {
    expect(formatStack(undefined)).toBeUndefined();
    expect(formatStack([])).toBeUndefined();
  });
});

describe('mapException', () => {
  it('splits the description into message and stack, preferring callFrames', () => {
    const entry = mapException({
      timestamp: 5,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 1,
        columnNumber: 1,
        url: 'http://x/main.js',
        exception: { type: 'object', description: "TypeError: Cannot read properties of undefined (reading 'map')\n    at a (http://x/main.js:1:1)" },
        stackTrace: { callFrames: [frame('OrderList', 'http://x/main.js', 141, 17)] },
      },
    });
    expect(entry.level).toBe('error');
    expect(entry.message).toBe("TypeError: Cannot read properties of undefined (reading 'map')");
    expect(entry.stack).toBe('    at OrderList (http://x/main.js:142:18)');
    expect(entry.url).toBe('http://x/main.js');
    expect(entry.timestamp).toBe(5);
  });
  it('falls back to text when there is no exception object', () => {
    const entry = mapException({
      timestamp: 1,
      exceptionDetails: { exceptionId: 1, text: 'Uncaught SyntaxError', lineNumber: 0, columnNumber: 0 },
    });
    expect(entry.message).toBe('Uncaught SyntaxError');
    expect(entry.stack).toBeUndefined();
  });
  it('uses the description stack when callFrames are missing', () => {
    const entry = mapException({
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception: { type: 'object', description: 'Error: boom\n    at f (http://x/a.js:2:3)' },
      },
    });
    expect(entry.message).toBe('Error: boom');
    expect(entry.stack).toBe('    at f (http://x/a.js:2:3)');
  });
});

describe('mapConsoleApi', () => {
  const call = (type: string, args: Protocol.Runtime.RemoteObject[]) =>
    ({ type, args, executionContextId: 1, timestamp: 7 }) as Protocol.Runtime.ConsoleAPICalledEvent;

  it('keeps error and warning, drops everything else', () => {
    expect(mapConsoleApi(call('error', [{ type: 'string', value: 'x' }]))?.level).toBe('error');
    expect(mapConsoleApi(call('warning', [{ type: 'string', value: 'x' }]))?.level).toBe('warning');
    expect(mapConsoleApi(call('log', [{ type: 'string', value: 'x' }]))).toBeNull();
    expect(mapConsoleApi(call('info', [{ type: 'string', value: 'x' }]))).toBeNull();
  });
  it('joins args using value, description and preview', () => {
    const entry = mapConsoleApi(
      call('error', [
        { type: 'string', value: 'Failed:' },
        { type: 'number', value: 42 },
        { type: 'object', description: 'Error: nope' },
        { type: 'object', preview: { type: 'object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }] } },
      ]),
    );
    expect(entry?.message).toBe('Failed: 42 Error: nope {"a":"1"}');
  });
});

describe('mapLogEntry', () => {
  const log = (level: string, source: string): Protocol.Log.EntryAddedEvent =>
    ({ entry: { source, level, text: 'boom', timestamp: 9, url: 'http://x/' } }) as Protocol.Log.EntryAddedEvent;

  it('keeps non-network errors', () => {
    expect(mapLogEntry(log('error', 'javascript'))?.message).toBe('boom');
  });
  it('drops network-source duplicates', () => {
    expect(mapLogEntry(log('error', 'network'))).toBeNull();
  });
  it('drops warnings and info', () => {
    expect(mapLogEntry(log('warning', 'javascript'))).toBeNull();
    expect(mapLogEntry(log('info', 'javascript'))).toBeNull();
  });
});

describe('network mapping', () => {
  const response = (status: number): Protocol.Network.ResponseReceivedEvent =>
    ({
      requestId: 'r1',
      loaderId: 'l1',
      timestamp: 100.25,
      type: 'Fetch',
      hasExtraInfo: false,
      response: { url: 'http://localhost:5174/api/orders', status, statusText: '', headers: {}, mimeType: 'application/json', charset: '', connectionReused: false, connectionId: 1, encodedDataLength: 0, securityState: 'neutral' },
    }) as Protocol.Network.ResponseReceivedEvent;

  it('tracks the request with wall time and post data', () => {
    const record = trackRequest(requestEvent());
    expect(record.method).toBe('POST');
    expect(record.wallTimeMs).toBe(1_760_000_000_000);
    expect(record.postData).toBe('{"item":1}');
  });
  it('keeps responses with status 400 and above, drops 399', () => {
    const record = trackRequest(requestEvent());
    expect(mapResponse(response(399), record)).toBeNull();
    const kept = mapResponse(response(400), record);
    expect(kept?.status).toBe(400);
    expect(kept?.requestBody).toBe('{"item":1}');
    expect(kept?.durationMs).toBe(250);
  });
  it('maps a failed load with the error text', () => {
    const record = trackRequest(requestEvent());
    const entry = mapLoadingFailed(
      { requestId: 'r1', timestamp: 100.5, type: 'Fetch', errorText: 'net::ERR_CONNECTION_REFUSED' },
      record,
    );
    expect(entry?.status).toBeNull();
    expect(entry?.errorText).toBe('net::ERR_CONNECTION_REFUSED');
  });
  it('appends blocked and CORS reasons', () => {
    const record = trackRequest(requestEvent());
    const entry = mapLoadingFailed(
      {
        requestId: 'r1',
        timestamp: 100.5,
        type: 'Fetch',
        errorText: 'net::ERR_FAILED',
        blockedReason: 'inspector',
        corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: '' },
      },
      record,
    );
    expect(entry?.errorText).toBe('net::ERR_FAILED (blocked: inspector, cors: MissingAllowOriginHeader)');
  });
  it('drops canceled loads and loads with no tracked request', () => {
    const record = trackRequest(requestEvent());
    expect(mapLoadingFailed({ requestId: 'r1', timestamp: 1, type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true }, record)).toBeNull();
    expect(mapLoadingFailed({ requestId: 'r2', timestamp: 1, type: 'Fetch', errorText: 'net::ERR_FAILED' }, undefined)).toBeNull();
  });
});
