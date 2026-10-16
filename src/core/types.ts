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
  rawHashes?: string[]; // internal: up to 20 raw-message hashes, stripped at export
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
  rawHashes?: string[]; // internal: up to 20 raw hashes, stripped at export
}

export type RawConsoleEntry = Omit<
  ConsoleEntry,
  'fingerprint' | 'count' | 'lastSeen' | 'variants' | 'relatedRequest' | 'rawHashes'
>;

export type RawNetworkEntry = Omit<
  NetworkEntry,
  'fingerprint' | 'count' | 'lastSeen' | 'variants' | 'rawHashes'
>;

export interface ElementSnapshot {
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  screenshotDataUrl: string;
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
  viewport: { width: number; height: number };
  capturedAt: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  element?: ElementSnapshot;
  userNote?: string; // optional "what I expected vs what happened"
  summary: CapsuleSummary;
  redactionCount: number;
}
