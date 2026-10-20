import type { ScreenshotReason } from './screenshot-model';

export interface ConsoleEntry {
  level: 'error' | 'warning';
  message: string;
  stack?: string;
  url?: string;
  timestamp: number; // first occurrence
  fingerprint: string;
  count: number; // occurrences merged into this entry
  lastSeen: number;
  variants: number; // distinct raw messages merged (1 = identical text)
  relatedRequest?: number; // 1-based index into Capsule.network, set at build time
  pageUrl?: string; // main-frame URL when the entry was first recorded
  rawHashes?: string[]; // internal: up to 20 raw-message hashes, stripped at export
  seq?: number; // internal: insertion order of the first occurrence
  touched?: number; // internal: insertion counter of the latest insert or fold
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null; // null when loadingFailed
  errorText?: string; // e.g. net::ERR_CONNECTION_REFUSED
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string; // truncated, redacted
  durationMs?: number;
  timestamp: number; // first occurrence
  fingerprint: string;
  count: number;
  lastSeen: number;
  variants: number;
  pageUrl?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  rawHashes?: string[]; // internal: up to 20 raw hashes, stripped at export
  seq?: number;
  touched?: number;
}

export type RawConsoleEntry = Omit<
  ConsoleEntry,
  'fingerprint' | 'count' | 'lastSeen' | 'variants' | 'relatedRequest' | 'rawHashes' | 'seq' | 'touched'
>;

export type RawNetworkEntry = Omit<
  NetworkEntry,
  'fingerprint' | 'count' | 'lastSeen' | 'variants' | 'rawHashes' | 'seq' | 'touched'
>;

export interface PendingRequest {
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  postDataTruncated?: boolean;
  hasPostData: boolean;
  wallTimeMs: number;
  monotonicSeconds: number;
  pageUrl?: string;
  marked?: boolean; // response with status >= 400 received
  status?: number;
  mimeType?: string;
  responseUrl?: string;
  responseMonotonicSeconds?: number;
}

export interface ElementSnapshot {
  selector: string;
  outerHTML: string;
  outerHTMLTruncated?: boolean; // set by the picker when it cut outerHTML; enables the tolerant redaction forms
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  screenshotDataUrl: string;
  screenshotClipped?: boolean; // P6: the element rect was not fully inside the viewport
  screenshotUnavailable?: ScreenshotReason; // P6: why screenshotDataUrl is empty
}

export interface CapsuleSummary {
  uniqueErrors: number;
  totalErrors: number;
  uniqueWarnings: number;
  totalWarnings: number;
  uniqueRequests: number;
  totalRequests: number;
}

export interface Capsule {
  pageUrl: string;
  pageTitle: string;
  userAgent: string;
  viewport?: { width: number; height: number }; // P7: absent when the page size could not be read
  capturedAt: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  element?: ElementSnapshot;
  userNote?: string; // optional "what I expected vs what happened"
  summary: CapsuleSummary;
  redactionCount: number;
}
