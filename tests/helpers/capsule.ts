import { toConsoleEntry, toNetworkEntry } from '../../src/core/consolidate';
import { redactCapsule, sealRedacted, type CapsuleDraft, type RedactedCapsule } from '../../src/core/redact/redact';
import type { CapsuleSummary, ConsoleEntry, NetworkEntry } from '../../src/core/types';

export const t = (h: number, m: number, s: number): number => Date.UTC(2026, 9, 16, h, m, s);

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export function consoleEntry(patch: Partial<ConsoleEntry> & { message: string }): ConsoleEntry {
  const raw = toConsoleEntry({ level: 'error', timestamp: t(17, 41, 58), ...patch });
  return { ...raw, ...patch, lastSeen: patch.lastSeen ?? raw.lastSeen };
}

export function networkEntry(patch: Partial<NetworkEntry> & { url: string }): NetworkEntry {
  const raw = toNetworkEntry({ method: 'POST', status: 500, requestHeaders: {}, timestamp: t(17, 41, 57), ...patch });
  return { ...raw, ...patch, lastSeen: patch.lastSeen ?? raw.lastSeen };
}

export function summaryOf(entries: ConsoleEntry[], network: NetworkEntry[]): CapsuleSummary {
  const sum = (items: Array<{ count: number }>) => items.reduce((total, item) => total + item.count, 0);
  const errors = entries.filter((e) => e.level === 'error');
  const warnings = entries.filter((e) => e.level !== 'error');
  return {
    uniqueErrors: errors.length, totalErrors: sum(errors),
    uniqueWarnings: warnings.length, totalWarnings: sum(warnings),
    uniqueRequests: network.length, totalRequests: sum(network),
  };
}

export const BASE: CapsuleDraft = {
  pageUrl: 'http://localhost:5174/',
  pageTitle: 'Orders | Demo Shop',
  userAgent: UA,
  viewport: { width: 1440, height: 900 },
  capturedAt: '2026-10-16T17:42:10.120Z',
  console: [],
  network: [],
};

/** Runs a draft through the real redaction, then applies links the way P7 does (spread, then seal). */
export function sealed(
  patch: Partial<CapsuleDraft> = {},
  options: { related?: Record<number, number>; summary?: CapsuleSummary } = {},
): RedactedCapsule {
  const draft: CapsuleDraft = { ...BASE, ...patch };
  const result = redactCapsule(draft);
  const linked = result.draft.console.map((entry, index) =>
    options.related?.[index] !== undefined ? { ...entry, relatedRequest: options.related[index] } : entry,
  );
  return sealRedacted(
    { ...result.draft, console: linked },
    { summary: options.summary ?? summaryOf(result.draft.console, result.draft.network), redactionCount: result.redactionCount },
  );
}
