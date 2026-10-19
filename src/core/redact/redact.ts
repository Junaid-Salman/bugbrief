/**
 * Public entry of the redaction pipeline. Scope: common secrets (keys, tokens, passwords, cookies,
 * private keys) and emails. It does NOT detect card numbers, phone numbers, national ids, names,
 * addresses or IPs (plan G22, spec §4.4), and it does not touch screenshot pixels (D3).
 */
import { refoldRedacted } from '../consolidate';
import { FIELD } from '../limits';
import { redactBody } from './redact-body';
import { redactHeaders } from './redact-headers';
import { redactHtml, redactSelector } from './redact-html';
import { redactText, textSpans } from './redact-text';
import { urlSpans } from './redact-url';
import { REDACTED, applySpans, type Applied } from './redact-spans';
import type { Capsule, CapsuleSummary, ConsoleEntry, ElementSnapshot, NetworkEntry } from '../types';

export { REDACTED } from './redact-spans';

/** What `redactCapsule` does with each field. `strip` fields are removed after the re-fold. */
export type Mapping =
  | 'url' | 'text' | 'stack' | 'headers' | 'body' | 'html' | 'selector' | 'styles'
  | 'keep' | 'refold' | 'strip' | 'nested';

/** Exhaustive over `keyof T` (optional fields included): a new field without a mapping fails `tsc`. */
export type FieldMap<T> = { [K in keyof T]-?: Mapping };

/** The capsule before P7 adds `summary` and the exact count (Q11). */
export type CapsuleDraft = Omit<Capsule, 'summary' | 'redactionCount'>;

declare const redactedBrand: unique symbol;
/** Output of `redactCapsule`. Derive new objects by spreading it, which keeps the brand (Q23). */
export type RedactedDraft = CapsuleDraft & { readonly [redactedBrand]: true };
export type RedactedCapsule = Capsule & { readonly [redactedBrand]: true };

export const CAPSULE_MAP: FieldMap<CapsuleDraft> = {
  pageUrl: 'url',
  pageTitle: 'text',
  userAgent: 'keep',
  viewport: 'keep',
  capturedAt: 'keep',
  console: 'refold',
  network: 'refold',
  element: 'nested',
  userNote: 'text',
};

export const CONSOLE_MAP: FieldMap<ConsoleEntry> = {
  level: 'keep',
  message: 'text',
  stack: 'stack',
  url: 'url',
  timestamp: 'keep',
  fingerprint: 'refold',
  count: 'refold',
  lastSeen: 'refold',
  variants: 'refold',
  relatedRequest: 'strip',
  pageUrl: 'url',
  rawHashes: 'strip',
  seq: 'strip',
  touched: 'strip',
};

export const NETWORK_MAP: FieldMap<NetworkEntry> = {
  method: 'keep',
  url: 'url',
  status: 'keep',
  errorText: 'text',
  requestHeaders: 'headers',
  requestBody: 'body',
  responseBody: 'body',
  durationMs: 'keep',
  timestamp: 'keep',
  fingerprint: 'refold',
  count: 'refold',
  lastSeen: 'refold',
  variants: 'refold',
  pageUrl: 'url',
  requestBodyTruncated: 'keep',
  responseBodyTruncated: 'keep',
  rawHashes: 'strip',
  seq: 'strip',
  touched: 'strip',
};

export const ELEMENT_MAP: FieldMap<ElementSnapshot> = {
  selector: 'selector',
  outerHTML: 'html',
  outerHTMLTruncated: 'keep',
  styles: 'styles',
  rect: 'keep',
  // D3 (spec §4.4, §8): screenshots are not redacted, redaction does not touch pixels. The P7
  // preview warns the user. Covered by a test named after D3 in tests/redact-review-fixes.test.ts.
  screenshotDataUrl: 'keep',
  // P6 flags: a boolean and a code from a fixed list. Neither can carry page text.
  screenshotClipped: 'keep',
  screenshotUnavailable: 'keep',
};

/** A field counts as cut when it reaches its cap (minus one for `capText`'s surrogate step). */
const CAPS: Readonly<Record<string, number>> = {
  'top.pageUrl': FIELD.pageUrl,
  'console.message': FIELD.consoleMessage,
  'console.stack': FIELD.consoleStack,
  'console.url': FIELD.consoleUrl,
  'console.pageUrl': FIELD.pageUrl,
  'network.url': FIELD.networkUrl,
  'network.pageUrl': FIELD.pageUrl,
  'network.errorText': FIELD.errorText,
};
const TRUNCATED_FLAGS: Readonly<Record<string, string>> = {
  requestBody: 'requestBodyTruncated',
  responseBody: 'responseBodyTruncated',
  outerHTML: 'outerHTMLTruncated',
};

interface Counter {
  count: number;
}

function isCut(scope: string, key: string, value: string, record: Record<string, unknown>): boolean {
  const flag = TRUNCATED_FLAGS[key];
  if (flag) return record[flag] === true;
  const cap = CAPS[`${scope}.${key}`];
  return cap !== undefined && value.length >= cap - 1;
}

function redactUrlField(value: string, cut: boolean): Applied {
  return applySpans(value, [...urlSpans(value), ...textSpans(value, { cut })]);
}

// Required text fields (Q33): a missing or null value becomes '' so the re-fold never reads
// undefined. Typed against the entry types, so a renamed field fails tsc. Applied to whole entries
// only: a top-level field that is absent stays absent.
const REQUIRED_TEXT: {
  console: readonly (keyof ConsoleEntry)[];
  network: readonly (keyof NetworkEntry)[];
  element: readonly (keyof ElementSnapshot)[];
} = {
  console: ['message'],
  network: ['url'],
  element: ['selector', 'outerHTML'],
};
const REQUIRED_TOP: readonly (keyof CapsuleDraft)[] = ['pageUrl', 'pageTitle', 'userNote'];
const TEXT_MAPPINGS: ReadonlySet<Mapping> = new Set(['url', 'text', 'stack', 'body', 'html', 'selector']);

function isRequired(scope: string, key: string): boolean {
  if (scope === 'top') return (REQUIRED_TOP as readonly string[]).includes(key);
  const list = (REQUIRED_TEXT as Record<string, readonly string[]>)[scope];
  return list?.includes(key) ?? false;
}

function redactString(value: string, mapping: Mapping, cut: boolean): Applied {
  switch (mapping) {
    case 'url': return redactUrlField(value, cut);
    case 'stack': return redactText(value, { cut, stack: true });
    case 'body': return redactBody(value, { cut });
    case 'html': return redactHtml(value, { cut });
    case 'selector': return redactSelector(value);
    case 'text':
    case 'headers':
    case 'styles':
      return redactText(value, { cut });
    case 'keep':
    case 'refold':
    case 'strip':
    case 'nested':
      return { text: value, count: 0 }; // handled by the callers, never masked as a string
    default: {
      const unreachable: never = mapping; // a new Mapping member fails tsc here
      return unreachable;
    }
  }
}

/** Undefined when the value cannot be serialized (circular): it is then replaced whole. */
function serialize(value: object): string | undefined {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return undefined;
  }
}

function copy(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

/**
 * Walks one record through its field map. Unmapped keys (only possible with a cast) are treated
 * as free text when they are strings, so an unexpected field cannot carry a secret through.
 */
function redactRecord(
  record: Record<string, unknown>,
  map: Record<string, Mapping>,
  scope: string,
  counter: Counter,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const mapping = map[key] ?? 'text';
    if (TEXT_MAPPINGS.has(mapping) && (value === null || ['number', 'boolean', 'bigint'].includes(typeof value))) {
      // Bad capture data (M1): null is '' when required and dropped when optional, the rest is
      // stringified and then redacted like any other text.
      if (value === null) {
        if (isRequired(scope, key)) out[key] = '';
        continue;
      }
      const applied = redactString(String(value), mapping, false);
      counter.count += applied.count;
      out[key] = applied.text;
      continue;
    }
    if (mapping === 'keep' || mapping === 'refold' || mapping === 'strip') {
      out[key] = copy(value);
    } else if (mapping === 'headers' && value !== null && typeof value === 'object') {
      const result = redactHeaders(value as Record<string, string>);
      counter.count += result.count;
      out[key] = result.headers;
    } else if (mapping === 'styles' && value !== null && typeof value === 'object') {
      const styles: Record<string, string> = {};
      for (const [name, styleValue] of Object.entries(value as Record<string, string>)) {
        const applied = redactText(String(styleValue));
        counter.count += applied.count;
        styles[name] = applied.text;
      }
      out[key] = styles;
    } else if (typeof value === 'string') {
      const applied = redactString(value, mapping, isCut(scope, key, value, record));
      counter.count += applied.count;
      out[key] = applied.text;
    } else if (value !== null && typeof value === 'object') {
      // Bad capture data: an object where a string is expected (Q29). Serialize it and redact the
      // text, so the key rules still apply. The result is the string the type promised.
      const text = serialize(value);
      if (text === undefined) {
        counter.count += 1;
        out[key] = REDACTED;
      } else {
        const applied = redactString(text, mapping === 'body' ? 'body' : 'text', false);
        counter.count += applied.count;
        out[key] = applied.text;
      }
    } else {
      out[key] = copy(value);
    }
  }
  const required = (REQUIRED_TEXT as Record<string, readonly string[]>)[scope] ?? [];
  for (const key of required) if (!(key in out)) out[key] = '';
  return out;
}

export interface RedactResult {
  draft: RedactedDraft;
  /** Masks applied by this call (Q13). Later caps in P7 can drop masked text. */
  redactionCount: number;
}

/**
 * Masks every text field, re-folds entries that now collide and strips internal fields.
 * `summary`, `relatedRequest` and the output caps stay in P7. The input is not mutated.
 */
export function redactCapsule(draft: CapsuleDraft): RedactResult {
  const counter: Counter = { count: 0 };
  const out: Record<string, unknown> = {};
  let consoleEntries: ConsoleEntry[] = [];
  let network: NetworkEntry[] = [];
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue;
    const mapping = (CAPSULE_MAP as Record<string, Mapping>)[key] ?? 'text';
    if (key === 'console') {
      consoleEntries = (value as ConsoleEntry[]).map(
        (entry) => redactRecord(entry as unknown as Record<string, unknown>, CONSOLE_MAP, 'console', counter) as unknown as ConsoleEntry,
      );
    } else if (key === 'network') {
      network = (value as NetworkEntry[]).map(
        (entry) => redactRecord(entry as unknown as Record<string, unknown>, NETWORK_MAP, 'network', counter) as unknown as NetworkEntry,
      );
    } else if (mapping === 'nested') {
      out[key] = redactRecord(value as Record<string, unknown>, ELEMENT_MAP, 'element', counter);
    } else {
      Object.assign(out, redactRecord({ [key]: value }, CAPSULE_MAP, 'top', counter));
    }
  }
  const folded = refoldRedacted(consoleEntries, network);
  out.console = folded.console;
  out.network = folded.network;
  return { draft: out as unknown as RedactedDraft, redactionCount: counter.count };
}

/** The only way to produce a `RedactedCapsule`: P7 supplies the fields it owns. */
export function sealRedacted(
  draft: RedactedDraft,
  extra: { summary: CapsuleSummary; redactionCount: number },
): RedactedCapsule {
  if (!Number.isInteger(extra.redactionCount) || extra.redactionCount < 0) {
    throw new RangeError('redactionCount must be a non-negative integer');
  }
  return { ...draft, ...extra } as RedactedCapsule;
}
