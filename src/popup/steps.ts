import { isStale, type CapsuleUi } from './capsule-state';

/** 0 = not started, 1 = the step the user is on, 2 = done. */
export type Rail = 0 | 1 | 2;

export interface StepsView {
  /** The state of the numbered node for Record, Pick and Share. */
  rail: [Rail, Rail, Rail];
  /** An open step shows its controls; a folded one is a single summary row. */
  open: [boolean, boolean, boolean];
}

/**
 * Which of the three steps are open and where the rail stands. Pure and derived only from what the popup already
 * knows, so it adds no state of its own. Done steps fold, so the popup stays inside Chrome's popup height.
 */
export function stepsView(ui: CapsuleUi): StepsView {
  const recording = ui.state.status === 'recording';
  const counts = ui.counts;
  const hasCounts = counts !== undefined && counts.console.unique + counts.network.unique + counts.console.evicted.entries + counts.network.evicted.entries > 0;
  const element = ui.element;
  const hasData = hasCounts || element !== undefined;
  const pending = element?.screenshot === 'pending';

  let rail1: Rail;
  let open1 = true;
  if (recording) rail1 = 1;
  else if (hasCounts) { rail1 = 2; open1 = false; }
  else rail1 = hasData ? 0 : 1;

  let rail2: Rail = 0;
  let open2 = true;
  if (element) {
    if (element.screenshot === 'pending' || element.screenshot === 'unavailable') rail2 = 1;
    else { rail2 = 2; open2 = false; }
  }

  const open3 = hasData || recording;
  let rail3: Rail;
  if (recording || pending || !open3) rail3 = 0;
  else rail3 = ui.preview !== undefined && !isStale(ui) ? 2 : 1;

  return { rail: [rail1, rail2, rail3], open: [open1, open2, open3] };
}
