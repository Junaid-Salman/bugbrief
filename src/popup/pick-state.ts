import { REASON_MESSAGES } from '../core/screenshot-model';
import type { ElementSummary, RecordingState } from '../shared/messages';

export interface PickInput {
  loaded: boolean;
  busy: boolean;
  restricted: boolean;
  tabId: number | undefined;
  state: RecordingState;
}

/** While recording, only the recorded tab can be picked (Q2). Otherwise any normal tab. */
export function canPick({ loaded, busy, restricted, tabId, state }: PickInput): boolean {
  if (!loaded || busy || restricted || tabId === undefined) return false;
  return state.status !== 'recording' || state.tabId === tabId;
}

export function pickLabel(element: ElementSummary | undefined): string {
  return element ? 'Pick again' : 'Pick element';
}

/** Clear shows when there is anything to clear and no recording is running. */
export function showClear(state: RecordingState, hasBufferData: boolean, element: ElementSummary | undefined): boolean {
  return state.status !== 'recording' && (hasBufferData || element !== undefined);
}

export function elementNote(element: ElementSummary, currentTabId: number | undefined): string {
  const base = `Element selected: ${element.selector}`;
  return currentTabId !== undefined && element.tabId !== currentTabId ? `${base} (picked on another tab)` : base;
}

/** One line about the screenshot (criterion 11). */
export function screenshotNote(element: ElementSummary): string {
  switch (element.screenshot) {
    case 'pending':
      return 'Taking screenshot…';
    case 'captured':
      return 'Screenshot captured';
    case 'clipped':
      return 'Screenshot captured (clipped to the viewport)';
    case 'unavailable':
      return `No screenshot: ${REASON_MESSAGES[element.reason ?? 'capture-failed']}`;
  }
}

export const POLL_INTERVAL_MS = 1000;
export const POLL_MAX_ATTEMPTS = 20;

/**
 * While a screenshot is pending, asks for the state again every second, at most 20 times (Q6, Q13).
 * `poll` returns the latest element summary. Returns a function that stops the loop.
 */
export function pollWhilePending(poll: () => Promise<ElementSummary | undefined>): () => void {
  let attempts = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    timer = setTimeout(async () => {
      attempts += 1;
      let next: ElementSummary | undefined;
      try {
        next = await poll();
      } catch {
        next = undefined; // a transient failure counts as an attempt
      }
      if (stopped) return;
      if (attempts < POLL_MAX_ATTEMPTS && (next === undefined || next.screenshot === 'pending')) schedule();
    }, POLL_INTERVAL_MS);
  }

  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
