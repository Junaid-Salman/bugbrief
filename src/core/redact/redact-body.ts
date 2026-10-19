import type { DetectOptions } from './redact-detect';
import { textSpans } from './redact-text';
import { paramSpans } from './redact-url';
import { applySpans, type Applied, type Span } from './redact-spans';

const FORM_BODY = /^[^\s={}<>\[\]"]{1,128}=[^\s]*$/;

/**
 * Request and response bodies. The JSON scanner is part of the text rules (it runs on any text
 * with `"key":` pairs, so cut, NDJSON, JSONP and XSSI-prefixed bodies work). Form bodies are
 * masked as parameters. Everything is resolved together, so the outermost mask wins.
 */
export function redactBody(text: string, options: DetectOptions = {}): Applied {
  const spans: Span[] = textSpans(text, options);
  const trimmed = text.trim();
  if (FORM_BODY.test(trimmed)) {
    const offset = text.indexOf(trimmed);
    spans.push(...paramSpans(text, offset, offset + trimmed.length));
  }
  return applySpans(text, spans);
}
