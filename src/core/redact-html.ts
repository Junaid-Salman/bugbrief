import { isHtmlSpace } from './redact-chars';
import { coreSpans, type DetectOptions } from './redact-detect';
import { isSensitiveKey } from './redact-rules';
import { applySpans, shift, type Applied, type Span } from './redact-spans';
import { textSpans } from './redact-text';

interface Attribute {
  name: string; // lowercased
  start: number; // value start (inside the quotes)
  end: number; // value end
  hasValue: boolean;
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const CLOSE_SCRIPT = /<\/script/gi;
const CLOSE_STYLE = /<\/style/gi;
const CLOSE_TEXTAREA = /<\/textarea/gi;

/** HTML entity decoding, for detection only (Q7). */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (_, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name] ?? '';
    const code = dec ? parseInt(dec, 10) : parseInt(hex ?? '0', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function closeIndex(html: string, re: RegExp, from: number): number {
  re.lastIndex = from;
  const match = re.exec(html);
  return match ? match.index : html.length;
}

/** Quote-aware attribute scan: a `>` inside a quoted value does not end the tag. */
function parseTag(html: string, from: number): { attributes: Attribute[]; end: number; closed: boolean } {
  const n = html.length;
  const attributes: Attribute[] = [];
  let pos = from;
  while (pos < n) {
    while (pos < n && (isHtmlSpace(html.charCodeAt(pos)) || html.charCodeAt(pos) === 47)) pos += 1;
    if (pos >= n) break;
    if (html.charCodeAt(pos) === 62) return { attributes, end: pos + 1, closed: true };
    const nameStart = pos;
    while (pos < n) {
      const c = html.charCodeAt(pos);
      if (isHtmlSpace(c) || c === 61 || c === 62 || c === 47) break;
      pos += 1;
    }
    const name = html.slice(nameStart, pos).toLowerCase();
    if (pos === nameStart) {
      pos += 1;
      continue;
    }
    let look = pos;
    while (look < n && isHtmlSpace(html.charCodeAt(look))) look += 1;
    if (html.charCodeAt(look) !== 61) {
      attributes.push({ name, start: pos, end: pos, hasValue: false });
      continue;
    }
    pos = look + 1;
    while (pos < n && isHtmlSpace(html.charCodeAt(pos))) pos += 1;
    const quote = html.charCodeAt(pos);
    if (quote === 34 || quote === 39) {
      const start = pos + 1;
      const close = html.indexOf(html[pos] as string, start);
      const end = close === -1 ? n : close;
      attributes.push({ name, start, end, hasValue: true });
      pos = close === -1 ? n : close + 1;
    } else {
      const start = pos;
      while (pos < n && !isHtmlSpace(html.charCodeAt(pos)) && html.charCodeAt(pos) !== 62) pos += 1;
      attributes.push({ name, start, end: pos, hasValue: true });
    }
  }
  return { attributes, end: n, closed: false };
}

// Standard autocomplete tokens (WHATWG) for fields whose value is a credential or payment detail
// (Q31). They cover `name="card"` and `name="pin"` without adding those words to the key list (Q1).
const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code',
  'current-password', 'new-password',
]);

function hasSensitiveAutocomplete(value: string): boolean {
  return value.toLowerCase().split(/\s+/).some((token) => SENSITIVE_AUTOCOMPLETE.has(token));
}

function tagSpans(html: string, tag: string, attributes: Attribute[], cut: boolean): Span[] {
  const spans: Span[] = [];
  const valueOf = (attribute: Attribute | undefined): string =>
    attribute ? decodeEntities(html.slice(attribute.start, attribute.end)) : '';
  const find = (name: string): Attribute | undefined => attributes.find((a) => a.name === name);
  const mask = (attribute: Attribute | undefined, kind: string): void => {
    if (attribute?.hasValue && attribute.end > attribute.start) {
      spans.push({ start: attribute.start, end: attribute.end, kind });
    }
  };

  if (tag === 'input' || tag === 'textarea') {
    const type = valueOf(find('type')).trim().toLowerCase();
    const sensitiveName = ['name', 'id', 'autocomplete'].some((n) => isSensitiveKey(valueOf(find(n))));
    const sensitiveAutocomplete = hasSensitiveAutocomplete(valueOf(find('autocomplete')));
    if (tag === 'input' && (type === 'password' || type === 'hidden' || sensitiveName || sensitiveAutocomplete)) {
      mask(find('value'), 'input-value');
    }
  }
  if (tag === 'meta') {
    const label = valueOf(find('name')) || valueOf(find('http-equiv'));
    if (isSensitiveKey(label)) mask(find('content'), 'meta-content');
  }
  for (const attribute of attributes) {
    if (attribute.name.startsWith('data-') && isSensitiveKey(attribute.name.slice(5))) {
      mask(attribute, 'data-attribute');
    }
    if (!attribute.hasValue || attribute.end === attribute.start) continue;
    const raw = html.slice(attribute.start, attribute.end);
    const decoded = decodeEntities(raw);
    const rawSpans = shift(textSpans(raw, { cut: cut && attribute.end === html.length }), attribute.start);
    // An entity-encoded value that hides more than the raw text shows is masked as a whole unit (Q7).
    if (decoded !== raw && coreSpans(decoded).length > rawSpans.length) {
      spans.push({ start: attribute.start, end: attribute.end, kind: 'entity-value' });
    } else {
      spans.push(...rawSpans);
    }
  }
  return spans;
}

/**
 * `outerHTML` redaction. The service worker has no DOM, so this is a scanner: input, textarea,
 * meta and data-* rules per tag, entity-aware attribute values, and the free-text rules over
 * text nodes, script text and attribute values (Q7, Q10, G19). Only the final segment of the
 * text can carry a cut token, so the tolerant forms apply there alone.
 */
export function htmlSpans(html: string, options: DetectOptions = {}): Span[] {
  const cut = options.cut === true;
  const n = html.length;
  const spans: Span[] = [];
  let textStart = 0;
  let i = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      const text = html.slice(textStart, end);
      spans.push(...shift(textSpans(text, { cut: cut && end === n }), textStart));
    }
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    const closing = html.charCodeAt(lt + 1) === 47;
    const nameStart = lt + (closing ? 2 : 1);
    if (!isNameStart(html.charCodeAt(nameStart))) {
      i = lt + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < n && /[\w:-]/.test(html[nameEnd] as string)) nameEnd += 1;
    const tag = html.slice(nameStart, nameEnd).toLowerCase();
    flushText(lt);
    const parsed = parseTag(html, nameEnd);
    if (!closing) spans.push(...tagSpans(html, tag, parsed.attributes, cut));
    textStart = parsed.end;
    i = parsed.end;
    if (closing || !parsed.closed) continue;
    if (tag === 'script' || tag === 'style') {
      i = closeIndex(html, tag === 'script' ? CLOSE_SCRIPT : CLOSE_STYLE, parsed.end);
    } else if (tag === 'textarea') {
      const sensitive = parsed.attributes.some(
        (a) => {
          const value = decodeEntities(html.slice(a.start, a.end));
          if (a.name === 'autocomplete' && hasSensitiveAutocomplete(value)) return true;
          return ['name', 'id', 'autocomplete'].includes(a.name) && isSensitiveKey(value);
        },
      );
      const close = closeIndex(html, CLOSE_TEXTAREA, parsed.end);
      if (sensitive && close > parsed.end) spans.push({ start: parsed.end, end: close, kind: 'textarea' });
      if (sensitive) {
        textStart = close;
        i = close;
      }
    }
  }
  flushText(n);
  return spans;
}

export function redactHtml(html: string, options: DetectOptions = {}): Applied {
  return applySpans(html, htmlSpans(html, options));
}

// `input[value="hunter2"]`, `[data-token='x']`
const ATTRIBUTE_SELECTOR = /\[\s*([\w:-]{1,64})\s*([~|^$*]?=)\s*(?:"([^"\]]{0,512})"|'([^'\]]{0,512})'|([^\]\s"']{1,512}))\s*\]/g;

/** Selector helper: `[value=…]` is always masked, and so are attributes with sensitive names. */
export function redactSelector(selector: string): Applied {
  const spans: Span[] = [];
  if (selector.includes('[')) {
    ATTRIBUTE_SELECTOR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE_SELECTOR.exec(selector))) {
      const name = (match[1] ?? '').toLowerCase();
      const value = match[3] ?? match[4] ?? match[5] ?? '';
      if (value.length === 0) continue;
      const sensitive = name === 'value' || isSensitiveKey(name.startsWith('data-') ? name.slice(5) : name);
      if (!sensitive) continue;
      const end = match.index + match[0].lastIndexOf(value) + value.length;
      spans.push({ start: end - value.length, end, kind: 'selector-attribute' });
    }
  }
  return applySpans(selector, [...spans, ...textSpans(selector)]);
}
