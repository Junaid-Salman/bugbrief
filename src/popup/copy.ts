import type { BufferCounts } from '../shared/messages';

/** Every label and sentence the popup shows that is not built from data. One place, so the README can be checked against it. */
export const COPY = {
  start: 'Start recording',
  stop: 'Stop recording',
  startOver: 'Start over',
  pick: 'Pick element',
  pickAgain: 'Pick again',
  preview: 'Preview',
  building: 'Building preview…',
  copy: 'Copy',
  download: 'Download',
  clear: 'Clear',
  gotIt: 'Got it',
  live: 'Live',
  recordTitle: 'Record',
  recordedTitle: 'Recorded',
  pickTitle: 'Pick the broken element',
  shareTitle: 'Share with your agent',
  noteLabel: 'What happened? (expected vs actual)',
  notePlaceholder: 'Describe what you expected and what you saw.',
  recordHint: 'Start recording, then reload the page so its errors are captured.',
  recordingHint: 'Reproduce the bug now. Reopen this popup to pick the element.',
  pickHint: 'Optional: point at the broken element to add its HTML and a screenshot.',
  shareLocked: 'Available after you record a bug or pick an element',
  preparing: 'Waiting for the screenshot…',
  previewTitle: 'Capsule preview',
  persistenceOff: 'Persistence is off. Captured data may be lost if the worker restarts.',
  copied: 'Copied to the clipboard.',
} as const;

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The one-line summary of a finished recording, shown in the folded Record step. */
export function recordedSummary(counts: BufferCounts): string {
  return `${plural(counts.console.unique, 'error')} · ${plural(counts.network.unique, 'failed request')}`;
}
