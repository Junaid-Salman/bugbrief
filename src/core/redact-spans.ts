export const REDACTED = '[REDACTED]';

export interface Span {
  start: number;
  end: number; // exclusive
  replacement?: string; // defaults to REDACTED
  kind: string;
}

export interface Applied {
  text: string;
  count: number;
}

// A span whose text is already a mask is dropped, which keeps a second pass at zero.
// A masked email is one optional character, `***@` and a dotted host. Nothing else counts as masked.
const ALREADY_MASKED = /^(?:\[REDACTED\]|[^\s@*]?\*\*\*@[A-Za-z0-9.-]+\.[A-Za-z0-9-]{2,})$/;

export function isMasked(text: string): boolean {
  return ALREADY_MASKED.test(text);
}

export function maskEmail(local: string, domain: string): string {
  return local.length > 2 ? `${local[0]}***@${domain}` : `***@${domain}`;
}

/**
 * Earliest start wins, then the longest, so the outermost mask wins and inner text is never
 * re-scanned. Spans over text that is already masked are dropped.
 */
export function resolveSpans(text: string, spans: Span[]): Span[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let lastEnd = 0;
  for (const span of sorted) {
    if (span.start < lastEnd) continue;
    if (isMasked(text.slice(span.start, span.end))) continue;
    kept.push(span);
    lastEnd = span.end;
  }
  return kept;
}

export function applySpans(text: string, spans: Span[]): Applied {
  const kept = resolveSpans(text, spans);
  if (kept.length === 0) return { text, count: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const span of kept) {
    parts.push(text.slice(cursor, span.start), span.replacement ?? REDACTED);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), count: kept.length };
}

export function shift(spans: Span[], offset: number): Span[] {
  return offset === 0
    ? spans
    : spans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset }));
}
