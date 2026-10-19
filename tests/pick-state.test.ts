import { describe, expect, it } from 'vitest';
import { canPick, elementNote, pickLabel, showClear } from '../src/popup/pick-state';
import type { ElementSummary, RecordingState } from '../src/shared/messages';

const idle: RecordingState = { status: 'idle' };
const recording = (tabId: number): RecordingState => ({ status: 'recording', tabId, startedAt: 1 });
const stopped: RecordingState = { status: 'stopped', tabId: 3, startedAt: 1, stoppedAt: 2 };
const base = { loaded: true, busy: false, restricted: false, tabId: 3, state: idle };
const element: ElementSummary = { selector: '#buy', tabId: 3, pageUrl: 'https://example.com/', pickedAt: 1 };

describe('canPick (criterion 12, Q2)', () => {
  it('is enabled on a normal tab', () => {
    expect(canPick(base)).toBe(true);
    expect(canPick({ ...base, state: stopped })).toBe(true);
  });
  it.each([
    ['not loaded', { loaded: false }],
    ['busy', { busy: true }],
    ['restricted', { restricted: true }],
    ['no tab id', { tabId: undefined }],
  ])('is disabled when %s', (_label, patch) => {
    expect(canPick({ ...base, ...patch })).toBe(false);
  });
  it('while recording, allows only the recorded tab', () => {
    expect(canPick({ ...base, state: recording(3) })).toBe(true);
    expect(canPick({ ...base, state: recording(9) })).toBe(false);
  });
});

describe('labels and notes', () => {
  it('relabels the button after a pick', () => {
    expect(pickLabel(undefined)).toBe('Pick element');
    expect(pickLabel(element)).toBe('Pick again');
  });
  it('shows Clear for data or an element, never while recording', () => {
    expect(showClear(idle, false, undefined)).toBe(false);
    expect(showClear(idle, true, undefined)).toBe(true);
    expect(showClear(stopped, false, element)).toBe(true);
    expect(showClear(recording(3), true, element)).toBe(false);
  });
  it('notes an element picked on another tab', () => {
    expect(elementNote(element, 3)).toBe('Element selected: #buy');
    expect(elementNote(element, 4)).toBe('Element selected: #buy (picked on another tab)');
    expect(elementNote(element, undefined)).toBe('Element selected: #buy');
  });
});
