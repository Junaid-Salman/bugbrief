import { applyCaps, fileStamp, renderCapsule, showsElementPageUrl, type EvictedTally } from '../core/capsule';
import { cyrb53, linkCauses, summarizeCapsule } from '../core/consolidate';
import type { PickedPage } from '../core/element-model';
import { FIELD, capText } from '../core/limits';
import { pageFor, type PageMetadata } from '../core/page-metadata';
import { redactCapsule, sealRedacted, type CapsuleDraft } from '../core/redact/redact';
import { redactUrl } from '../core/redact/redact-url';
import type { ConsoleEntry, ElementSnapshot, NetworkEntry } from '../core/types';
import type { ScreenshotState } from './element';

export const NOTHING_TO_REPORT = 'Nothing to report yet.';

/** What the builder reads. Everything that touches Chrome is injected (F1). */
export interface BuildDeps {
  readBuffer(): {
    console: ConsoleEntry[];
    network: NetworkEntry[];
    pageUrl?: string;
    page?: PageMetadata;
    evicted: { console: EvictedTally; network: EvictedTally };
  };
  readElement(): { snapshot: ElementSnapshot; tabId: number; pickedAt: number; page: PickedPage; screenshot: ScreenshotState } | undefined;
  /** The worker's own user agent (Q11). The page is never asked for it. */
  userAgent(): string;
  now(): Date;
}

export interface BuildInput {
  userNote: string;
  /** Download passes the preview's value so the files and the copied text agree (Q5). */
  capturedAt?: string;
}

export type ScreenshotKind = 'none' | 'pending' | 'captured' | 'clipped' | 'unavailable';

export type BuildResult =
  | {
      ok: true;
      markdown: string;
      redactionCount: number;
      capturedAt: string;
      /** Hash of the Markdown and the screenshot identity (Q20). A staleness check, not a security hash. */
      previewHash: string;
      screenshot: ScreenshotKind;
      /** The PNG for Download. Empty when there is no image. Never sent to the popup. */
      pngDataUrl: string;
    }
  | { ok: false; error: string };

function screenshotKind(state: ScreenshotState | undefined, hasImage: boolean): ScreenshotKind {
  if (!state) return 'none';
  if (state.status === 'pending') return 'pending';
  if (hasImage) return state.status === 'clipped' ? 'clipped' : 'captured';
  return state.status === 'unavailable' ? 'unavailable' : 'none';
}

/**
 * Assembles, redacts, caps, links, summarizes and renders the capsule (D1). Nothing from the
 * buffer or the element is mutated. Pure apart from the injected reads.
 */
export function buildCapsule(deps: BuildDeps, input: BuildInput): BuildResult {
  const buffer = deps.readBuffer();
  const element = deps.readElement();
  const recorded = buffer.console.length > 0 || buffer.network.length > 0 || buffer.pageUrl !== undefined;
  if (!recorded && !element) return { ok: false, error: NOTHING_TO_REPORT };

  const capturedAt = input.capturedAt ?? deps.now().toISOString();
  // The recorded tab supplies the page fields when there is a recording; otherwise the element's page.
  const page = recorded ? pageFor(buffer.page, buffer.pageUrl) : undefined;
  const pageUrl = recorded ? (buffer.pageUrl ?? '') : (element?.page.url ?? '');
  const draft: CapsuleDraft = {
    pageUrl,
    pageTitle: recorded ? (page?.title ?? '') : (element?.page.title ?? ''),
    userAgent: deps.userAgent(),
    capturedAt,
    console: structuredClone(buffer.console),
    network: structuredClone(buffer.network),
  };
  const viewport = recorded ? page?.viewport : element?.page.viewport;
  if (viewport) draft.viewport = { ...viewport };
  if (element) {
    // The flags come from the screenshot status, not from whatever the snapshot already carries.
    const { screenshotClipped: _clipped, screenshotUnavailable: _reason, ...base } = element.snapshot;
    void _clipped;
    void _reason;
    const hasImage = base.screenshotDataUrl !== '';
    const state = element.screenshot;
    draft.element = {
      ...base,
      ...(hasImage && state.status === 'clipped' ? { screenshotClipped: true } : {}),
      ...(state.status === 'unavailable' ? { screenshotUnavailable: state.reason } : {}),
    };
  }
  const note = capText(input.userNote, FIELD.userNote).text;
  if (note.trim() !== '') draft.userNote = note;

  const redacted = redactCapsule(draft);
  const capped = applyCaps(redacted.draft.console, redacted.draft.network);
  const linked = linkCauses(capped.console, capped.network);
  // The summary counts every entry, so it is computed before the caps hide any.
  const summary = summarizeCapsule(redacted.draft.console, redacted.draft.network);
  const capsule = sealRedacted(
    { ...redacted.draft, console: linked, network: capped.network },
    { summary, redactionCount: redacted.redactionCount },
  );

  const pngDataUrl = element?.snapshot.screenshotDataUrl ?? '';
  const kind = screenshotKind(element?.screenshot, pngDataUrl !== '');
  // The element's page URL is redacted here, outside redactCapsule, so its masks are added to the count when the
  // capsule shows that line (BL-011). Same rule as the renderer, on the same redacted operands.
  const elementUrl = element ? redactUrl(element.page.url) : undefined;
  const elementUrlMasks = elementUrl && showsElementPageUrl(elementUrl.text, redacted.draft.pageUrl) ? elementUrl.count : 0;
  const redactionCount = redacted.redactionCount + elementUrlMasks;
  const markdown = renderCapsule(capsule, {
    omitted: capped.omitted,
    evicted: buffer.evicted,
    stamp: fileStamp(capturedAt),
    screenshotPending: kind === 'pending',
    // Shown only when it differs from the capsule's page, and redacted like every other URL.
    ...(elementUrl ? { elementPageUrl: elementUrl.text } : {}),
  });
  const identity = element && pngDataUrl !== '' ? `${element.pickedAt}:${pngDataUrl.length}` : '';
  return {
    ok: true,
    markdown,
    redactionCount,
    capturedAt,
    previewHash: cyrb53(`${markdown}\n${identity}`),
    screenshot: kind,
    pngDataUrl,
  };
}
