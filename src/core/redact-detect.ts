import { isBlank, isFileNameChar, isKeyChar, isSpace } from './redact-chars';
import { jsonSpans } from './redact-json';
import {
  COLON_KEYS,
  STATUS_WORDS,
  classifyRun,
  findTokenSpans,
  isSensitiveKey,
  MIN_RUN,
} from './redact-rules';
import { REDACTED, maskEmail, type Span } from './redact-spans';

export interface DetectOptions {
  /** The field was cut by a cap or a body trim, so the tolerant token forms apply (Q16). */
  cut?: boolean;
  /** Skip the long-run rule (tracing headers, G18). */
  noLongRun?: boolean;
  /** The text is a stack trace: URL paths in frames are protected from the long-run rule. */
  stack?: boolean;
}

// Free-text keys are short; JSON keys (redact-json.ts MAX_JSON_KEY) may be longer. Different on purpose.
const MAX_TEXT_KEY = 64;
const MAX_VALUE = 8192;

/** Key text that ends just before `end`, scanning at most MAX_TEXT_KEY characters left. */
function keyBefore(text: string, end: number): { key: string; start: number } {
  let start = end;
  while (start > 0 && end - start < MAX_TEXT_KEY && isKeyChar(text.charCodeAt(start - 1))) start -= 1;
  return { key: text.slice(start, end), start };
}

function isValueStop(code: number): boolean {
  // whitespace & ; , " ' < > ) }
  return (
    isSpace(code) || code === 38 || code === 59 || code === 44 || code === 34 ||
    code === 39 || code === 60 || code === 62 || code === 41 || code === 125
  );
}

/** Value extent after a `=` or `: `. A quoted value is masked without its quotes. */
function valueExtent(text: string, from: number): { start: number; end: number } | undefined {
  if (from >= text.length) return undefined;
  const first = text.charCodeAt(from);
  if (first === 34 || first === 39) {
    const limit = Math.min(text.length, from + 1 + MAX_VALUE);
    let end = from + 1;
    while (end < limit && text.charCodeAt(end) !== first && text.charCodeAt(end) !== 10) end += 1;
    return end > from + 1 ? { start: from + 1, end } : undefined;
  }
  const limit = Math.min(text.length, from + MAX_VALUE);
  let end = from;
  while (end < limit && !isValueStop(text.charCodeAt(end))) end += 1;
  return end > from ? { start: from, end } : undefined;
}

const MAX_BLANKS = 8;

/** Index after up to MAX_BLANKS spaces or tabs, forward from `from`. */
function skipBlanks(text: string, from: number): number {
  let i = from;
  while (i < text.length && i - from < MAX_BLANKS && isBlank(text.charCodeAt(i))) i += 1;
  return i;
}

/** Index of the first of up to MAX_BLANKS spaces or tabs that end just before `end`. */
function blanksBefore(text: string, end: number): number {
  let i = end;
  while (i > 0 && end - i < MAX_BLANKS && isBlank(text.charCodeAt(i - 1))) i -= 1;
  return i;
}

function isStatusWord(text: string, start: number, end: number): boolean {
  let stop = end;
  while (stop > start && /[.:]/.test(text[stop - 1] ?? '')) stop -= 1;
  return STATUS_WORDS.has(text.slice(start, stop).toLowerCase());
}

/** `key=value` for sensitive keys (Q3), and the strict `key: value` list (Q8, Q26). */
function keyValueSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  while (from < text.length) {
    const eq = text.indexOf('=', from);
    if (eq === -1) break;
    from = eq + 1;
    const next = text.charCodeAt(eq + 1);
    const before = text.charCodeAt(eq - 1);
    if (next === 61 || next === 62) continue; // == or =>
    if (before === 60 || before === 62 || before === 33 || before === 61) continue; // <= >= != ==
    const keyEnd = blanksBefore(text, eq);
    const { key } = keyBefore(text, keyEnd);
    if (!key || !isSensitiveKey(key)) continue;
    const valueStart = skipBlanks(text, eq + 1);
    const value = valueExtent(text, valueStart);
    if (!value) continue; // a value that is exactly the sentinel is dropped by resolveSpans
    // `password = null` in code: spaced forms keep the status-word stop-list.
    const spaced = keyEnd !== eq || valueStart !== eq + 1;
    if (spaced && isStatusWord(text, value.start, value.end)) continue;
    spans.push({ ...value, kind: 'key-value' });
    from = Math.max(from, value.end);
  }

  from = 0;
  while (from < text.length) {
    const colon = text.indexOf(':', from);
    if (colon === -1) break;
    from = colon + 1;
    const after = text.charCodeAt(colon + 1);
    if (after === 47 || after === 58) continue; // `password://` and `password::`
    const keyEnd = blanksBefore(text, colon);
    const { key, start } = keyBefore(text, keyEnd);
    if (!key || !COLON_KEYS.has(key.toLowerCase())) continue;
    if (start > 0 && isKeyChar(text.charCodeAt(start - 1))) continue; // key was cut by the bound
    const value = valueExtent(text, skipBlanks(text, colon + 1));
    if (!value) continue;
    let { end } = value;
    while (end > value.start && /[.:]/.test(text[end - 1] ?? '')) end -= 1;
    if (end === value.start || isStatusWord(text, value.start, end)) continue;
    spans.push({ start: value.start, end, kind: 'colon-value' });
    from = Math.max(from, end);
  }
  return spans;
}

// Header names whose whole value is masked when they appear in free text or bodies (Q27). The name
// may follow a quote (`"Cookie: a=b"`). A JSON key never matches: its closing quote comes before `:`.
const HEADER_LINE = /(?<![\w-])(?:proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token)[ \t]{0,8}:/gi;
const SCHEME = /^(?:Bearer|Basic)[ \t]+/i;

function lineBreakAt(code: number): boolean {
  return code === 10 || code === 13;
}

/** A closing quote ends a JSON string when `,`, `}`, `]`, `:`, a blank or the line end follows. */
function closesString(text: string, quoteEnd: number, lineEnd: number, loose: boolean): boolean {
  if (quoteEnd >= lineEnd) return true;
  const next = text.charCodeAt(quoteEnd);
  if (next === 44 || next === 125 || next === 93 || next === 58 || isBlank(next)) return true;
  return loose && (next === 46 || next === 59 || next === 41); // `.` `;` `)` after an apostrophe
}

type Quote = 'plain' | 'escaped' | 'single' | 'none';

/** End of the header value: the closing quote of the enclosing string, else the end of the line. */
function valueEnd(text: string, from: number, lineEnd: number, quote: Quote): number {
  if (quote === 'none') return lineEnd;
  for (let k = from; k < lineEnd; k++) {
    const code = text.charCodeAt(k);
    if (quote === 'single') {
      if (code === 39 && closesString(text, k + 1, lineEnd, true)) return k;
    } else if (code === 34) {
      const escaped = text.charCodeAt(k - 1) === 92;
      if (quote === 'plain' && !escaped && closesString(text, k + 1, lineEnd, false)) return k;
      if (quote === 'escaped' && escaped && closesString(text, k + 1, lineEnd, false)) return k - 1;
    }
  }
  return lineEnd;
}

/**
 * `Authorization: Token x` and `Cookie: a=b; c=d`: the rest of the line, any scheme (Q27), with no
 * length cap (C2). Inside a quoted string the mask stops at the closing quote (M2): the quote
 * context comes from the parity of unescaped `"` and of `\"` counted from the line start. The line
 * end and the parity are kept per line, so a long line is scanned once and the rule stays linear.
 */
function headerLineSpans(text: string): Span[] {
  const spans: Span[] = [];
  if (!text.includes(':')) return spans;
  HEADER_LINE.lastIndex = 0;
  let lineEnd = -1;
  let counted = 0;
  let plain = 0;
  let escaped = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADER_LINE.exec(text))) {
    const at = match.index;
    if (at >= lineEnd) {
      let begin = at;
      while (begin > 0 && !lineBreakAt(text.charCodeAt(begin - 1))) begin -= 1;
      lineEnd = at;
      while (lineEnd < text.length && !lineBreakAt(text.charCodeAt(lineEnd))) lineEnd += 1;
      counted = begin;
      plain = 0;
      escaped = 0;
    }
    for (; counted < at; counted++) {
      if (text.charCodeAt(counted) !== 34) continue;
      if (text.charCodeAt(counted - 1) === 92) escaped += 1;
      else plain += 1;
    }
    let quote: Quote = 'none';
    if (at > 0 && text.charCodeAt(at - 1) === 39) quote = 'single';
    else if (plain % 2 === 1) quote = 'plain';
    else if (escaped % 2 === 1) quote = 'escaped';

    let start = skipBlanks(text, at + match[0].length);
    let end = valueEnd(text, start, lineEnd, quote);
    while (end > start && isBlank(text.charCodeAt(end - 1))) end -= 1;
    // Bearer and Basic keep the scheme word, as their own rules do.
    const scheme = SCHEME.exec(text.slice(start, Math.min(end, start + 16)));
    if (scheme) start += scheme[0].length;
    HEADER_LINE.lastIndex = Math.max(HEADER_LINE.lastIndex, end);
    if (end <= start || isStatusWord(text, start, end)) continue;
    spans.push({ start, end, kind: 'header-line' });
  }
  return spans;
}

function isLocalChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 37 || code === 43 || code === 45
  );
}

function isDomainChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 45
  );
}

function isUserinfoPassword(text: string, localStart: number): boolean {
  if (text.charCodeAt(localStart - 1) !== 58) return false;
  const scheme = text.lastIndexOf('://', localStart);
  if (scheme === -1 || localStart - scheme > 80) return false;
  return !/[\s/@]/.test(text.slice(scheme + 3, localStart));
}

/** Finds `@`, then checks at most 64 characters left and 255 right (no quadratic regex). */
function emailSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf('@', from);
    if (at === -1) break;
    from = at + 1;
    let start = at;
    while (start > 0 && at - start < 64 && isLocalChar(text.charCodeAt(start - 1))) start -= 1;
    if (start === at) continue;
    if (isUserinfoPassword(text, start)) continue; // `scheme://user:password@host` has its own rule
    let end = at + 1;
    while (end < text.length && end - at <= 255 && isDomainChar(text.charCodeAt(end))) end += 1;
    while (end > at + 1 && /[.-]/.test(text[end - 1] ?? '')) end -= 1;
    const domain = text.slice(at + 1, end);
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(domain)) continue;
    spans.push({
      start,
      end,
      replacement: maskEmail(text.slice(start, at), domain),
      kind: 'email',
    });
    from = end;
  }
  return spans;
}

const XML_ELEMENT = /<([A-Za-z_][\w.:-]{0,63})>([^<]{1,2048})<\/\1>/g;

function xmlSpans(text: string): Span[] {
  const spans: Span[] = [];
  if (!text.includes('</')) return spans;
  XML_ELEMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XML_ELEMENT.exec(text))) {
    const tag = match[1] ?? '';
    const value = match[2] ?? '';
    if (!isSensitiveKey(tag) || value.trim() === REDACTED) continue;
    const start = match.index + tag.length + 2;
    spans.push({ start, end: start + value.length, kind: 'xml' });
  }
  return spans;
}

// --- Protected ranges and the long-run rule ----------------------------------------------------

const DASHED_UUID =
  /(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g;
const ASSET_EXTENSION = /\.(?:m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot)(?![A-Za-z0-9])/gi;
const SRI_HASH = /sha(?:256|384|512)-[A-Za-z0-9+/]{20,700}={0,2}/g;
// W3C trace context: version-traceid-spanid-flags. A fixed documented shape, not a secret.
const TRACEPARENT = /(?<![0-9A-Za-z])[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}(?![0-9A-Za-z])/g;
const STACK_URL = /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s?#()]{1,2048}/g;

type Range = [number, number];

/**
 * Ranges the long-run rule must not mask: dashed UUIDs (they split runs, §2.6), static-asset
 * file names, SRI hashes and, in a stack, frame URL paths (G13). Query strings and fragments are
 * never protected.
 */
export function protectedRanges(text: string, stack: boolean): Range[] {
  const ranges: Range[] = [];
  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) ranges.push([match.index, match.index + match[0].length]);
  };
  if (text.includes('-')) collect(DASHED_UUID);
  if (text.includes('sha')) collect(SRI_HASH);
  if (text.includes('-')) collect(TRACEPARENT);
  if (stack && text.includes('://')) collect(STACK_URL);
  ASSET_EXTENSION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSET_EXTENSION.exec(text))) {
    let start = match.index;
    while (start > 0 && match.index - start < 256 && isFileNameChar(text.charCodeAt(start - 1))) start -= 1;
    ranges.push([start, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function isRunChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 43 || code === 47 || code === 95 || code === 45
  );
}

/** Long-run rule: scans runs of the base64 alphabet of 32+ characters (Q5, Q18, Q20). */
export function longRunSpans(text: string, ranges: Range[]): Span[] {
  const spans: Span[] = [];
  let rangeIndex = 0;
  const flush = (start: number, end: number): void => {
    // Up to two trailing `=` padding characters belong to the run.
    let runEnd = end;
    while (runEnd < text.length && runEnd - end < 2 && text.charCodeAt(runEnd) === 61) runEnd += 1;
    if (runEnd - start < MIN_RUN) return;
    const hit = classifyRun(text.slice(start, runEnd));
    if (hit) spans.push({ start: start + hit.start, end: start + hit.end, kind: 'long-run' });
  };
  let i = 0;
  let runStart = -1;
  while (i < text.length) {
    let range = ranges[rangeIndex];
    while (range && range[1] <= i) {
      rangeIndex += 1;
      range = ranges[rangeIndex];
    }
    if (range && i >= range[0]) {
      if (runStart !== -1) flush(runStart, i);
      runStart = -1;
      i = range[1];
      continue;
    }
    if (isRunChar(text.charCodeAt(i))) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      flush(runStart, i);
      runStart = -1;
    }
    i += 1;
  }
  if (runStart !== -1) flush(runStart, text.length);
  return spans;
}

/** Every rule that works on plain text, without URL or percent-encoding handling. */
export function coreSpans(text: string, options: DetectOptions = {}): Span[] {
  if (text.length === 0) return [];
  const spans: Span[] = [
    ...findTokenSpans(text, options.cut === true),
    ...jsonSpans(text),
    ...keyValueSpans(text),
    ...headerLineSpans(text),
    ...xmlSpans(text),
    ...emailSpans(text),
  ];
  if (!options.noLongRun && text.length >= MIN_RUN) {
    spans.push(...longRunSpans(text, protectedRanges(text, options.stack === true)));
  }
  return spans;
}
