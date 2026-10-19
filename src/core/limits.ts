export const CONSOLE_CAP = 200;
export const NETWORK_CAP = 50;
export const PENDING_CAP = 100;
export const PENDING_PERSIST_CAP = 50;
export const ROOT_CAUSE_WINDOW = 20;

export const FIELD = {
  consoleMessage: 4096,
  consoleStack: 6144,
  consoleUrl: 2048,
  pageUrl: 2048,
  networkUrl: 2048,
  errorText: 512,
  requestBody: 8192,
  responseBody: 24_576,
  selector: 2048,
  outerHTML: 32_768, // raw cap for the picked element; P7 cuts to 3 KB after redaction
  pageTitle: 512,
  styleValue: 256,
  maxHeaders: 30,
  headerName: 64,
  headerValue: 256,
} as const;

export const SOFT_LIMIT_BYTES = 7 * 1024 * 1024;
export const TRIMMED_BODY_LIMIT = 4096;

export interface Capped {
  text: string;
  truncated: boolean;
}

/** Cuts on a code-point boundary so the result never ends in a lone surrogate. */
export function capText(value: string, limit: number): Capped {
  if (value.length <= limit) return { text: value, truncated: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

export function capHeaders(headers: Record<string, string>): Record<string, string> {
  const capped: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (count === FIELD.maxHeaders) break;
    capped[name.slice(0, FIELD.headerName)] = String(value).slice(0, FIELD.headerValue);
    count += 1;
  }
  return capped;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** True when the JSON text is guaranteed or measured to fit under the soft limit. */
export function fitsSoftLimit(json: string): boolean {
  if (json.length * 3 <= SOFT_LIMIT_BYTES) return true;
  return utf8Bytes(json) <= SOFT_LIMIT_BYTES;
}
