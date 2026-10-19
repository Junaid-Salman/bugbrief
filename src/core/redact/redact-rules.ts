import type { Span } from './redact-spans';

/** Spec §4.4's 12 tokens plus the Q1 additions. Matching is exact on key tokens. */
export const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  'token', 'key', 'apikey', 'secret', 'password', 'passwd', 'auth', 'session', 'sig',
  'signature', 'jwt', 'credential',
  'authorization', 'bearer', 'cookie', 'pwd', 'otp', 'passcode',
  'sid', 'ssn', // Q25. `pass`, `pin` and `code` stay out (Q1).
]);

/** Compound forms, compared with all separators removed. */
export const COMPOUND_KEYS: ReadonlySet<string> = new Set([
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'csrftoken', 'xsrftoken',
  'sessionid', 'sessiontoken', 'secretkey', 'privatekey', 'clientsecret', 'apikey',
]);

/** Words that mark the next path segment as a token (Q6). */
export const SECRET_WORDS: ReadonlySet<string> = new Set([
  'reset', 'verify', 'invite', 'invitation', 'magic', 'token', 'confirm', 'activate',
  'unsubscribe', 'auth', 'password',
]);

/** Q8: `key: value` is masked for these keys unless the value is a status word. */
export const COLON_KEYS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'pwd', 'secret', 'apikey', 'api_key',
  'token', 'credential', 'api-key', // Q26. `auth` stays out: `auth: true` is common prose.
]);
export const STATUS_WORDS: ReadonlySet<string> = new Set([
  'required', 'undefined', 'null', 'true', 'false', 'missing', 'invalid', 'empty',
  'incorrect', 'expired',
]);

// Long-run thresholds (§2.1, §2.6). Re-checked by the corpus tests.
export const MIN_RUN = 32;
export const HEX_RATE = 0.2;
export const BASE64_RATE = 0.35;
export const MAX_EDGE_SEPARATORS = 8;
export const PATH_TOKEN_MIN = 16;
export const PATH_TOKEN_RATE = 0.2;

export function splitKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  if (key.length === 0 || key.length > 128) return false;
  const tokens = splitKey(key);
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) return true;
  return COMPOUND_KEYS.has(tokens.join(''));
}

function charClass(code: number): number {
  if (code >= 48 && code <= 57) return 0; // digit
  if (code >= 97 && code <= 122) return 1; // lower
  if (code >= 65 && code <= 90) return 2; // upper
  return -1;
}

/** Rate of letter/digit/case changes over the alphanumerics only (symbols removed). */
export function classChangeRate(text: string): number {
  let previous = -1;
  let count = 0;
  let changes = 0;
  for (let i = 0; i < text.length; i++) {
    const cls = charClass(text.charCodeAt(i));
    if (cls < 0) continue;
    count += 1;
    if (previous >= 0 && cls !== previous) changes += 1;
    previous = cls;
  }
  return count < 2 ? 0 : changes / (count - 1);
}

function isSeparator(code: number): boolean {
  return code === 47 || code === 45 || code === 95; // / - _
}

function isHexCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

/**
 * Scores a run of the base64 alphabet. The whole run is a candidate, plus windows that start at
 * the run start or just after one of its first or last 8 separators and end at the run end or just
 * before one of those separators. Prefix sums make each candidate O(1), so a run costs one
 * linear pass plus at most 17 x 17 candidates. Returns the longest passing window, if any.
 */
export function classifyRun(run: string, minLength = MIN_RUN): { start: number; end: number } | null {
  const n = run.length;
  if (n < minLength) return null;
  const cumAlnum = new Int32Array(n + 1);
  const cumLetter = new Int32Array(n + 1);
  const cumDigit = new Int32Array(n + 1);
  const cumNonHex = new Int32Array(n + 1);
  const cumChange = new Int32Array(n + 1);
  const separators: number[] = [];
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const code = run.charCodeAt(i);
    const cls = charClass(code);
    cumAlnum[i + 1] = (cumAlnum[i] ?? 0) + (cls >= 0 ? 1 : 0);
    cumLetter[i + 1] = (cumLetter[i] ?? 0) + (cls >= 1 ? 1 : 0);
    cumDigit[i + 1] = (cumDigit[i] ?? 0) + (cls === 0 ? 1 : 0);
    cumNonHex[i + 1] = (cumNonHex[i] ?? 0) + (isHexCode(code) ? 0 : 1);
    cumChange[i + 1] = (cumChange[i] ?? 0) + (cls >= 0 && previous >= 0 && cls !== previous ? 1 : 0);
    if (cls >= 0) previous = cls;
    if (isSeparator(code)) separators.push(i);
  }
  const at = (array: Int32Array, i: number): number => array[i] ?? 0;

  const passes = (s: number, e: number): boolean => {
    if (e - s < minLength) return false;
    const alnum = at(cumAlnum, e) - at(cumAlnum, s);
    if (alnum < 2) return false;
    let first = s;
    while (first < e && charClass(run.charCodeAt(first)) < 0) first += 1;
    const changes =
      at(cumChange, e) - at(cumChange, s) - (at(cumChange, first + 1) - at(cumChange, first));
    const rate = changes / (alnum - 1);
    if (at(cumNonHex, e) - at(cumNonHex, s) === 0) return rate >= HEX_RATE;
    const letters = at(cumLetter, e) - at(cumLetter, s);
    const digits = at(cumDigit, e) - at(cumDigit, s);
    return letters > 0 && digits > 0 && rate >= BASE64_RATE;
  };

  // Windows start at the run start or after an edge separator (first or last 8) and end at the
  // run end or before an edge separator, so a secret behind many separators is still a candidate.
  const edge = [...separators.slice(0, MAX_EDGE_SEPARATORS), ...separators.slice(-MAX_EDGE_SEPARATORS)];
  const starts = [...new Set([0, ...edge.map((p) => p + 1)])].sort((a, b) => a - b);
  const ends = [...new Set([n, ...edge])].sort((a, b) => b - a);
  let best: { start: number; end: number } | null = null;
  for (const s of starts) {
    if (s >= n) continue;
    for (const e of ends) {
      if (e <= s) continue;
      if (best && e - s <= best.end - best.start) continue;
      if (passes(s, e)) best = { start: s, end: e };
    }
  }
  return best;
}

/** Path-segment rule (Q6, Q12, Q21): the previous segment holds a secret word. */
export function isSecretWordSegment(previous: string): boolean {
  return previous
    .toLowerCase()
    .split(/[-_]/)
    .some((word) => SECRET_WORDS.has(word));
}

export function isPathToken(segment: string): boolean {
  return (
    segment.length >= PATH_TOKEN_MIN &&
    segment.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    classChangeRate(segment) >= PATH_TOKEN_RATE
  );
}

// --- Token formats ---------------------------------------------------------------------------

interface TokenFormat {
  name: string;
  prefix: string; // regex source of a fixed-length prefix
  prefixLen: number;
  body: string; // regex character-class source (without brackets)
  fullMin: number;
  fullMax: number;
  tolerantMin: number; // body length that triggers masking when the text was cut
  hints: string[]; // cheap literal pre-filter
}

const MAX_BODY = 1024;

/**
 * Spec formats (AKIA, gh*_) are kept as written. The rest are the Q2 additions with stable,
 * publicly documented shapes: Stripe, Slack, Google, npm, GitLab, GitHub fine-grained.
 */
export const TOKEN_FORMATS: readonly TokenFormat[] = [
  { name: 'aws-access-key', prefix: 'A[KS]IA', prefixLen: 4, body: '0-9A-Z', fullMin: 16, fullMax: 16, tolerantMin: 4, hints: ['AKIA', 'ASIA'] },
  { name: 'github-token', prefix: 'gh[pousr]_', prefixLen: 4, body: 'A-Za-z0-9', fullMin: 36, fullMax: MAX_BODY, tolerantMin: 4, hints: ['gh'] },
  { name: 'github-pat', prefix: 'github_pat_', prefixLen: 11, body: 'A-Za-z0-9_', fullMin: 22, fullMax: MAX_BODY, tolerantMin: 0, hints: ['github_pat_'] },
  { name: 'stripe-key', prefix: '[sr]k_(?:live|test)_', prefixLen: 8, body: 'A-Za-z0-9', fullMin: 16, fullMax: MAX_BODY, tolerantMin: 3, hints: ['k_live_', 'k_test_'] },
  { name: 'slack-token', prefix: 'xox[baprs]-', prefixLen: 5, body: 'A-Za-z0-9-', fullMin: 10, fullMax: MAX_BODY, tolerantMin: 4, hints: ['xox'] },
  { name: 'google-api-key', prefix: 'AIza', prefixLen: 4, body: 'A-Za-z0-9_-', fullMin: 35, fullMax: 35, tolerantMin: 4, hints: ['AIza'] },
  { name: 'npm-token', prefix: 'npm_', prefixLen: 4, body: 'A-Za-z0-9', fullMin: 36, fullMax: 36, tolerantMin: 4, hints: ['npm_'] },
  { name: 'gitlab-token', prefix: 'glpat-', prefixLen: 6, body: 'A-Za-z0-9_-', fullMin: 20, fullMax: MAX_BODY, tolerantMin: 4, hints: ['glpat-'] },
  { name: 'jwt-cut', prefix: 'eyJ', prefixLen: 3, body: 'A-Za-z0-9_.-', fullMin: 0, fullMax: 0, tolerantMin: 6, hints: ['eyJ'] },
];

/** Minimum total length at which a cut token is masked. Criterion 4b requires at most 11. */
export const TOKEN_MIN_TOTAL: Readonly<Record<string, number>> = {
  ...Object.fromEntries(TOKEN_FORMATS.map((f) => [f.name, f.prefixLen + f.tolerantMin])),
  'bearer-cut': 'Bearer '.length + 4,
};

const FULL_PATTERNS = TOKEN_FORMATS.filter((f) => f.fullMax > 0).map((format) => ({
  format,
  re: new RegExp(`${format.prefix}[${format.body}]{${format.fullMin},${format.fullMax}}`, 'g'),
}));
const TOLERANT_PATTERNS = TOKEN_FORMATS.map((format) => ({
  format,
  prefix: new RegExp(format.prefix, 'g'),
  bodyChar: new RegExp(`^[${format.body}]$`),
}));

const BEARER = /\bBearer[ \t]{1,8}([A-Za-z0-9._~+/=-]{16,2048})/gi;
const BASIC = /\bBasic[ \t]{1,8}([A-Za-z0-9+/=]{12,2048})/gi;
const BEARER_TAIL_PREFIX = /\bBearer[ \t]{1,8}$/i;
const SECRET_SHAPE = /[A-Z0-9=+/]/;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/y;
const TAIL_WINDOW = 4096;

function pemSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  while (true) {
    const begin = text.indexOf('-----BEGIN ', from);
    if (begin === -1) break;
    PEM_BEGIN.lastIndex = begin;
    const header = PEM_BEGIN.exec(text);
    if (!header) {
      from = begin + 1;
      continue;
    }
    const endMarker = text.indexOf('-----END ', begin + header[0].length);
    let end = text.length;
    if (endMarker !== -1) {
      const close = text.indexOf('-----', endMarker + 9);
      if (close !== -1) end = close + 5;
    }
    spans.push({ start: begin, end, kind: 'pem' });
    from = Math.max(end, begin + 1);
  }
  return spans;
}

/** A token cut by a field cap or body trim runs to the end of the text (Q16, §2.6). */
function tolerantSpans(text: string): Span[] {
  const spans: Span[] = [];
  const length = text.length;
  for (const { format, prefix, bodyChar } of TOLERANT_PATTERNS) {
    if (!format.hints.some((hint) => text.includes(hint))) continue;
    const limit = Math.max(0, length - TAIL_WINDOW);
    let bodyStart = length;
    while (bodyStart > limit && bodyChar.test(text[bodyStart - 1] ?? '')) bodyStart -= 1;
    prefix.lastIndex = Math.max(0, bodyStart - format.prefixLen);
    let match: RegExpExecArray | null;
    while ((match = prefix.exec(text))) {
      const prefixEnd = match.index + match[0].length;
      if (prefixEnd >= bodyStart && length - prefixEnd >= format.tolerantMin) {
        spans.push({ start: match.index, end: length, kind: format.name });
        break;
      }
    }
  }
  // "Bearer" followed by the last word of the text, at least 4 characters.
  let wordStart = length;
  const wordLimit = Math.max(0, length - TAIL_WINDOW);
  while (wordStart > wordLimit && !/\s/.test(text[wordStart - 1] ?? ' ')) wordStart -= 1;
  if (length - wordStart >= 4) {
    const before = text.slice(Math.max(0, wordStart - 16), wordStart);
    if (BEARER_TAIL_PREFIX.test(before)) {
      spans.push({ start: wordStart, end: length, kind: 'bearer-cut' });
    }
  }
  return spans;
}

/** Complete tokens, plus the tolerant forms when `cut` is set. */
export function findTokenSpans(text: string, cut: boolean): Span[] {
  const spans: Span[] = [...pemSpans(text)];
  for (const { format, re } of FULL_PATTERNS) {
    if (!format.hints.some((hint) => text.includes(hint))) continue;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind: format.name });
    }
  }
  if (text.includes('eyJ')) spans.push(...jwtSpans(text));
  if (text.includes('earer') || text.includes('EARER')) {
    spans.push(...groupSpans(text, BEARER, 'bearer'));
  }
  if (text.includes('asic') || text.includes('ASIC')) {
    spans.push(...groupSpans(text, BASIC, 'basic'));
  }
  if (cut) spans.push(...tolerantSpans(text));
  return spans;
}

const JWT_SEGMENT_MAX = 2048;

function isJwtChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 95 || code === 45
  );
}

function segmentEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && end - from < JWT_SEGMENT_MAX && isJwtChar(text.charCodeAt(end))) end += 1;
  return end;
}

/**
 * `eyJ` + 6 or more characters, a dot, 4 or more characters and an optional third segment.
 * A failed start skips to the end of its run, because every later `eyJ` in the run ends at the
 * same place, so the scan stays linear on `eyJeyJeyJ…`.
 */
function jwtSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  while (true) {
    const start = text.indexOf('eyJ', from);
    if (start === -1) break;
    const firstEnd = segmentEnd(text, start + 3);
    if (text.charCodeAt(firstEnd) === 46 && firstEnd - (start + 3) >= 6) {
      const secondEnd = segmentEnd(text, firstEnd + 1);
      if (secondEnd - (firstEnd + 1) >= 4) {
        let end = secondEnd;
        if (text.charCodeAt(secondEnd) === 46) end = segmentEnd(text, secondEnd + 1);
        spans.push({ start, end, kind: 'jwt' });
        from = end;
        continue;
      }
    }
    from = Math.max(start + 3, firstEnd);
  }
  return spans;
}

function groupSpans(text: string, re: RegExp, kind: string): Span[] {
  const spans: Span[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const token = match[1] ?? '';
    if (!SECRET_SHAPE.test(token)) continue;
    const end = match.index + match[0].length;
    spans.push({ start: end - token.length, end, kind });
  }
  return spans;
}
