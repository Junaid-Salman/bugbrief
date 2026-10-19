import { coreSpans, type DetectOptions } from './redact-detect';
import { decodeForDetection, urlSpans } from './redact-url';
import { applySpans, type Applied, type Span } from './redact-spans';

// A URL-ish token: an optional scheme, then `/`, after a delimiter or at the start.
const URL_TOKEN = /(?<![^\s"'(\[{=,])(?:[A-Za-z][A-Za-z0-9+.-]{1,15}:)?\/[^\s"'<>()]{1,2048}/g;
// `scheme://user:password@host` outside of a URL-shaped token (for example after a quote).
const USERINFO = /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s/@:]{1,64}:([^\s/@]{1,128})@/g;

function urlTokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  if (!text.includes('/')) return spans;
  URL_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_TOKEN.exec(text))) spans.push(...urlSpans(match[0], match.index));
  if (text.includes('://')) {
    USERINFO.lastIndex = 0;
    while ((match = USERINFO.exec(text))) {
      const password = match[1] ?? '';
      const end = match.index + match[0].length - 1;
      spans.push({ start: end - password.length, end, kind: 'userinfo' });
    }
  }
  return spans;
}

const UNIT_CAP = 2048;

function isUnitStop(code: number): boolean {
  return (
    code <= 32 || code === 34 || code === 39 || code === 60 || code === 62 || code === 0xa0 ||
    code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
}

function isHexCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/**
 * Percent-encoded units that are not URLs: decode (2 levels), test, mask the whole unit (Q7).
 * A unit is the run of non-space, non-quote characters around a `%hh` escape, at most 2048 on each
 * side. The scan finds `%` first and resumes at the end of each unit, so it stays linear (G12).
 */
function encodedTokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = text.indexOf('%');
  let lastEnd = 0;
  while (from !== -1) {
    if (!isHexCode(text.charCodeAt(from + 1)) || !isHexCode(text.charCodeAt(from + 2))) {
      from = text.indexOf('%', from + 1);
      continue;
    }
    let start = from;
    while (start > lastEnd && from - start < UNIT_CAP && !isUnitStop(text.charCodeAt(start - 1))) start -= 1;
    const rightLimit = Math.min(text.length, from + 3 + UNIT_CAP);
    let end = from + 3;
    while (end < rightLimit && !isUnitStop(text.charCodeAt(end))) end += 1;
    const unit = text.slice(start, end);
    if (!unit.startsWith('/') && !unit.includes('://')) { // URLs mask their own values
      const decoded = decodeForDetection(unit);
      if (decoded !== unit && coreSpans(decoded).length > 0) spans.push({ start, end, kind: 'encoded' });
    }
    lastEnd = end;
    from = text.indexOf('%', end);
  }
  return spans;
}

/** All spans for free text: console messages, stacks, notes, titles, `errorText`. */
export function textSpans(text: string, options: DetectOptions = {}): Span[] {
  if (text.length === 0) return [];
  return [
    ...coreSpans(text, options),
    ...urlTokenSpans(text),
    ...encodedTokenSpans(text),
  ];
}

export function redactText(text: string, options: DetectOptions = {}): Applied {
  return applySpans(text, textSpans(text, options));
}
