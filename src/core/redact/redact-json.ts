import { isSensitiveKey } from './redact-rules';
import { isSpace } from './redact-chars';
import { REDACTED, type Span } from './redact-spans';

const MAX_JSON_KEY = 128;
const MAX_GAP = 64; // whitespace allowed between a key and its colon or value

function decodeKey(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["\\/bfnrt])/g, (_, ch: string) => (ch === 'b' ? '\b' : ch === 'f' ? '\f' : ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch));
}

/** True when the character at `index` is preceded by an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes += 1;
  return slashes % 2 === 1;
}

/** End of a string whose content starts at `start`, or the end of the text when unterminated. */
function stringEnd(text: string, start: number, delim: string): number {
  if (delim === '\\"') {
    const close = text.indexOf('\\"', start);
    return close === -1 ? text.length : close;
  }
  const quote = delim.charCodeAt(0);
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 92) i += 1;
    else if (code === quote) return i;
  }
  return text.length;
}

/** End (exclusive) of the object or array that opens at `start`. Iterative, so depth is free. */
function bracketEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      i = stringEnd(text, i + 1, '"');
    } else if (code === 123 || code === 91) {
      depth += 1;
    } else if (code === 125 || code === 93) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function valueSpan(text: string, from: number, delim: string): Span | undefined {
  let i = from;
  let gap = 0;
  while (i < text.length && isSpace(text.charCodeAt(i)) && gap < MAX_GAP) {
    i += 1;
    gap += 1;
  }
  if (i >= text.length) return undefined; // cut right after the colon: nothing to mask yet
  const quoted = `${delim}${REDACTED}${delim}`;
  if (text.startsWith(delim, i)) {
    const contentStart = i + delim.length;
    const end = stringEnd(text, contentStart, delim);
    return end > contentStart ? { start: contentStart, end, kind: 'json-string' } : undefined;
  }
  const code = text.charCodeAt(i);
  if (code === 123 || code === 91) {
    return { start: i, end: bracketEnd(text, i), replacement: quoted, kind: 'json-container' };
  }
  let end = i;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    if (c === 44 || c === 125 || c === 93 || isSpace(c)) break;
    end += 1;
  }
  if (end === i) return undefined;
  return { start: i, end, replacement: quoted, kind: 'json-literal' };
}

function scan(text: string, delim: string, spans: Span[]): void {
  let from = 0;
  while (from < text.length) {
    const close = text.indexOf(delim, from);
    if (close === -1) return;
    from = close + delim.length;
    // Plain quotes that are escaped belong to the escaped-form scan.
    if (delim !== '\\"' && isEscaped(text, close)) continue;
    let colon = close + delim.length;
    let gap = 0;
    while (colon < text.length && isSpace(text.charCodeAt(colon)) && gap < MAX_GAP) {
      colon += 1;
      gap += 1;
    }
    if (text.charCodeAt(colon) !== 58) continue;
    // Walk back to the opening quote, bounded.
    let open = -1;
    const lowest = Math.max(0, close - MAX_JSON_KEY - delim.length);
    for (let k = close - delim.length; k >= lowest; k--) {
      const c = text.charCodeAt(k);
      if (c === 10) break;
      if (text.startsWith(delim, k) && (delim === '\\"' || !isEscaped(text, k))) {
        open = k;
        break;
      }
    }
    if (open === -1) continue;
    if (!isSensitiveKey(decodeKey(text.slice(open + delim.length, close)))) continue;
    const span = valueSpan(text, colon + 1, delim);
    if (span) {
      spans.push(span);
      from = Math.max(from, span.end);
    }
  }
}

/**
 * Spans for the values of sensitive keys, found in any text that holds `"key":` pairs:
 * complete or cut JSON, NDJSON, JSONP, XSSI-prefixed bodies, a BOM, and double-encoded
 * (`\"key\":\"value\"`) or single-quoted pairs inside free text. Every other byte is kept.
 */
export function jsonSpans(text: string): Span[] {
  if (!text.includes(':')) return [];
  const spans: Span[] = [];
  if (text.includes('"')) scan(text, '"', spans);
  if (text.includes("'")) scan(text, "'", spans);
  if (text.includes('\\"')) scan(text, '\\"', spans);
  return spans;
}
