export interface ConsoleEntry {
  level: 'error' | 'warning';
  message: string;
  stack?: string;
  url?: string;
  timestamp: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  errorText?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  durationMs?: number;
}

export interface ElementSnapshot {
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  screenshotDataUrl: string;
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
  userNote?: string;
  redactionCount: number;
}
