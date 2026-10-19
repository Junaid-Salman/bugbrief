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
