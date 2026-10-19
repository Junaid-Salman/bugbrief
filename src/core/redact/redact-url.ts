import { coreSpans, type DetectOptions } from './redact-detect';
import { isPathToken, isSecretWordSegment, isSensitiveKey } from './redact-rules';
import { applySpans, isMasked, type Applied, type Span } from './redact-spans';

const MAX_DECODE_PASSES = 2;
const DATA_PAYLOAD_MIN = 64;
const JSESSIONID = /;jsessionid=([^;/?#]*)/gi;

function decodeOnce(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    // Malformed input: decode each run of escapes as UTF-8 bytes, so multi-byte characters survive.
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      const bytes = Uint8Array.from(run.match(/%([0-9A-Fa-f]{2})/g) ?? [], (h) => parseInt(h.slice(1), 16));
      return new TextDecoder('utf-8').decode(bytes);
    });
  }
}

/** Percent-decoding for detection only, at most two levels (Q7). */
export function decodeForDetection(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** True when decoding changes the unit and the decoded text holds a secret. */
export function hasEncodedSecret(unit: string): boolean {
  if (!unit.includes('%')) return false;
  const decoded = decodeForDetection(unit);
  return decoded !== unit && coreSpans(decoded).length > 0;
}

/** Spans for the `a=b&c=d` parameters in text[start, end). */
export function paramSpans(text: string, start: number, end: number, base = 0): Span[] {
  const spans: Span[] = [];
  let position = start;
  while (position <= end) {
    let amp = text.indexOf('&', position);
    if (amp === -1 || amp > end) amp = end;
    let paramStart = position;
    if (paramStart < amp && text.startsWith('amp;', paramStart)) paramStart += 4; // &amp;
    const eq = text.indexOf('=', paramStart);
    if (eq !== -1 && eq < amp && amp > eq + 1) {
      const key = decodeForDetection(text.slice(paramStart, eq).replace(/\+/g, ' '));
      const value = text.slice(eq + 1, amp);
      if (!isMasked(value) && (isSensitiveKey(key) || hasEncodedSecret(value))) {
        spans.push({ start: base + eq + 1, end: base + amp, kind: 'query-value' });
      }
    }
    position = amp + 1;
  }
  return spans;
}

/** URL-aware spans for one URL (or URL-like token) at `base` in its host text. */
export function urlSpans(url: string, base = 0): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number, kind: string): void => {
    if (end > start) spans.push({ start: base + start, end: base + end, kind });
  };

  let cursor = 0;
  let hasAuthority = false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]{0,15}):/.exec(url);
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase();
    const rest = url.slice(scheme[0].length);
    if (name === 'data') {
      const payloadStart = scheme[0].length + rest.indexOf(',') + 1;
      if (url.length - payloadStart >= DATA_PAYLOAD_MIN) add(payloadStart, url.length, 'data-url');
      return spans;
    }
    if (name === 'blob') return urlSpans(rest, base + scheme[0].length);
    if (rest.startsWith('//')) {
      hasAuthority = true;
      cursor = scheme[0].length + 2;
    } else if (name === 'mailto' || name === 'javascript' || name === 'about') {
      return spans;
    }
    // Otherwise `host:port/path`: not a scheme, so the whole string is a path.
  } else if (url.startsWith('//')) {
    hasAuthority = true;
    cursor = 2;
  }

  let pathStart = cursor;
  if (hasAuthority) {
    let end = cursor;
    while (end < url.length && url[end] !== '/' && url[end] !== '?' && url[end] !== '#') end += 1;
    const authority = url.slice(cursor, end);
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      const colon = authority.slice(0, at).indexOf(':');
      if (colon >= 0) add(cursor + colon + 1, cursor + at, 'userinfo');
    }
    pathStart = end;
  }

  const question = url.indexOf('?', pathStart);
  const hash = url.indexOf('#', pathStart);
  const pathEnd = Math.min(question === -1 ? url.length : question, hash === -1 ? url.length : hash);
  const queryInUrl = question !== -1 && (hash === -1 || question < hash);

  const path = url.slice(pathStart, pathEnd);
  JSESSIONID.lastIndex = 0;
  let session: RegExpExecArray | null;
  while ((session = JSESSIONID.exec(path))) {
    add(pathStart + session.index + 12, pathStart + session.index + session[0].length, 'jsessionid');
  }
  let offset = 0;
  let previous = '';
  for (const segment of path.split('/')) {
    const clean = segment.split(';')[0] ?? '';
    if (isSecretWordSegment(previous) && isPathToken(clean)) {
      add(pathStart + offset, pathStart + offset + clean.length, 'path-token');
    }
    previous = clean;
    offset += segment.length + 1;
  }

  if (queryInUrl) {
    spans.push(...paramSpans(url, question + 1, hash === -1 ? url.length : hash, base));
  }
  if (hash !== -1) {
    // `#access_token=…` or `#/route?token=…`
    const fragmentStart = hash + 1;
    if (url[fragmentStart] === '/' || url[fragmentStart] === '!') {
      const route = url.indexOf('?', fragmentStart);
      if (route !== -1) spans.push(...paramSpans(url, route + 1, url.length, base));
    } else if (url.indexOf('=', fragmentStart) !== -1) {
      spans.push(...paramSpans(url, fragmentStart, url.length, base));
    }
  }
  return spans;
}

/** Redacts a URL field: URL-aware rules plus every plain-text rule. */
export function redactUrl(url: string, options: DetectOptions = {}): Applied {
  return applySpans(url, [...urlSpans(url), ...coreSpans(url, options)]);
}
