import type { BufferCounts, ElementSummary, FailureCode, RecordingState } from '../shared/messages';

export const SCREENSHOT_WARNING = 'Screenshot is not redacted. Check it before sharing.';
export const STALE_NOTE = 'Preview is out of date. Preview again.';

/** What the last Preview returned, plus what the popup knew when it ran. */
export interface PreviewState {
  markdown: string;
  redactionCount: number;
  capturedAt: string;
  previewHash: string;
  screenshot: 'none' | 'pending' | 'captured' | 'clipped' | 'unavailable';
  /** The note the preview was built from. */
  note: string;
  /** `dataSignature` at preview time, to notice a re-pick, Clear or new recording. */
  signature: string;
}

export interface CapsuleUi {
  loaded: boolean;
  busy: boolean;
  state: RecordingState;
  counts: BufferCounts | undefined;
  element: ElementSummary | undefined;
  note: string;
  preview: PreviewState | undefined;
  /** A Download succeeded for the current preview. */
  downloaded: boolean;
}

/** Changes when the data behind a preview changes (a new pick, its screenshot status, new entries). */
export function dataSignature(counts: BufferCounts | undefined, element: ElementSummary | undefined): string {
  return JSON.stringify([
    counts?.console.unique, counts?.console.total, counts?.network.unique, counts?.network.total,
    element?.pickedAt, element?.screenshot, element?.reason,
  ]);
}

export function hasData(ui: Pick<CapsuleUi, 'counts' | 'element'>): boolean {
  const counts = ui.counts;
  const entries = counts ? counts.console.unique + counts.network.unique + counts.console.evicted.entries + counts.network.evicted.entries : 0;
  return entries > 0 || ui.element !== undefined;
}

export function isStale(ui: CapsuleUi): boolean {
  const preview = ui.preview;
  return preview !== undefined && (preview.note !== ui.note || preview.signature !== dataSignature(ui.counts, ui.element));
}

const pending = (ui: CapsuleUi): boolean => ui.element?.screenshot === 'pending';

/** Preview needs a stopped (or never started) recording, something to report, and no pending screenshot (Q1). */
export function canPreview(ui: CapsuleUi): boolean {
  return ui.loaded && !ui.busy && ui.state.status !== 'recording' && hasData(ui) && !pending(ui);
}

/** A stale preview disables Download (Q18); the worker's hash check is only the backstop. */
export function canDownload(ui: CapsuleUi): boolean {
  return ui.preview !== undefined && !isStale(ui) && !ui.downloaded && ui.loaded && !ui.busy && ui.state.status !== 'recording' && !pending(ui);
}

/** Copy of a stale pane would put text on the clipboard that does not match the note, so it is off too. */
export function canCopy(ui: CapsuleUi): boolean {
  return ui.preview !== undefined && !isStale(ui) && !ui.busy;
}

export function showsScreenshotWarning(ui: CapsuleUi): boolean {
  const screenshot = ui.preview?.screenshot;
  return screenshot === 'captured' || screenshot === 'clipped';
}

export function badgeText(count: number): string {
  return `${count} ${count === 1 ? 'value' : 'values'} redacted`;
}

/** The hint under the buttons, in priority order. */
export function previewHint(ui: CapsuleUi): string | undefined {
  if (ui.state.status === 'recording') return 'Stop recording to preview.';
  if (pending(ui)) return 'Waiting for the screenshot…';
  if (!hasData(ui)) return 'Nothing to report yet. Record a bug or pick an element.';
  if (isStale(ui)) return STALE_NOTE;
  return undefined;
}

/** A failed Download means the shown preview is missing or out of date, so it must be dropped (BL-012). */
export function dropsPreview(code: FailureCode | undefined): boolean {
  return code === 'preview-required' || code === 'stale-preview';
}
