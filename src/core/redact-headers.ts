import { FIELD } from './limits';
import { textSpans } from './redact-text';
import { urlSpans } from './redact-url';
import { isSensitiveKey } from './redact-rules';
import { REDACTED, applySpans, isMasked, type Span } from './redact-spans';

/** Spec §4.4's fixed list. `isSensitiveKey` on the name catches `x-csrf-token` and friends. */
const FIXED_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization',
]);
const URL_HEADERS: ReadonlySet<string> = new Set(['referer', 'referrer', 'origin', 'location']);
// Tracing ids look random but are not secrets (G18): exempt from the long-run rule only.
const TRACING = /^(?:traceparent|tracestate|x-request-id|x-correlation-id|x-b3-.*|etag)$/;

export interface RedactedHeaders {
  headers: Record<string, string>;
  count: number;
}

export interface HeaderOptions {
  /** Treat every value as cut. Values at the 256-character cap are always treated as cut. */
  cut?: boolean;
}

export function redactHeaders(
  headers: Record<string, string>,
  options: HeaderOptions = {},
): RedactedHeaders {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (FIXED_HEADERS.has(lower) || isSensitiveKey(name)) {
      if (value.length > 0 && !isMasked(value)) {
        result[name] = REDACTED;
        count += 1;
      } else {
        result[name] = value;
      }
      continue;
    }
    const cut = options.cut === true || value.length >= FIELD.headerValue;
    const spans: Span[] = textSpans(value, { cut, noLongRun: TRACING.test(lower) });
    if (URL_HEADERS.has(lower)) spans.push(...urlSpans(value));
    const applied = applySpans(value, spans);
    result[name] = applied.text;
    count += applied.count;
  }
  return { headers: result, count };
}
