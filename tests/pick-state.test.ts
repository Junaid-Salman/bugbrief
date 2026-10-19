import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  canPick,
  elementNote,
  pickLabel,
  pollWhilePending,
  screenshotNote,
  showClear,
} from '../src/popup/pick-state';
import { SCREENSHOT_REASONS, REASON_MESSAGES } from '../src/core/screenshot-model';
import type { ElementSummary, RecordingState } from '../src/shared/messages';

const idle: RecordingState = { status: 'idle' };
const recording = (tabId: number): RecordingState => ({ status: 'recording', tabId, startedAt: 1 });
const stopped: RecordingState = { status: 'stopped', tabId: 3, startedAt: 1, stoppedAt: 2 };
const base = { loaded: true, busy: false, restricted: false, tabId: 3, state: idle };
const element: ElementSummary = { selector: '#buy', tabId: 3, pageUrl: 'https://example.com/', pickedAt: 1, screenshot: 'captured' };

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

describe('screenshotNote (criterion 11)', () => {
  it('has one line per status', () => {
    expect(screenshotNote({ ...element, screenshot: 'pending' })).toBe('Taking screenshot…');
    expect(screenshotNote({ ...element, screenshot: 'captured' })).toBe('Screenshot captured');
    expect(screenshotNote({ ...element, screenshot: 'clipped' })).toBe('Screenshot captured (clipped to the viewport)');
  });
  it.each(SCREENSHOT_REASONS)('explains the unavailable reason %s in plain language', (reason) => {
    expect(screenshotNote({ ...element, screenshot: 'unavailable', reason })).toBe(`No screenshot: ${REASON_MESSAGES[reason]}`);
  });
  it('falls back to capture-failed when the reason is missing', () => {
    expect(screenshotNote({ ...element, screenshot: 'unavailable' })).toBe(`No screenshot: ${REASON_MESSAGES['capture-failed']}`);
  });
});

describe('pollWhilePending (criterion 23)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const pending = { ...element, screenshot: 'pending' as const };

  it('polls every second and stops when the status changes', async () => {
    const poll = vi.fn<() => Promise<ElementSummary | undefined>>();
    poll.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValue(element);
    pollWhilePending(poll);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('gives up after 10 attempts', async () => {
    const poll = vi.fn(async () => pending);
    pollWhilePending(poll);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 30);
    expect(poll).toHaveBeenCalledTimes(POLL_MAX_ATTEMPTS);
  });

  it('stops when the caller stops it, even mid-wait', async () => {
    const poll = vi.fn(async () => pending);
    const stop = pollWhilePending(poll);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('survives a failing poll and keeps trying', async () => {
    const poll = vi.fn<() => Promise<ElementSummary | undefined>>();
    poll.mockRejectedValueOnce(new Error('worker asleep')).mockResolvedValue(element);
    pollWhilePending(poll);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('a stop that arrives while a poll is in flight prevents the next one', async () => {
    let resolve!: (value: ElementSummary) => void;
    const poll = vi.fn(() => new Promise<ElementSummary | undefined>((r) => (resolve = r)));
    const stop = pollWhilePending(poll);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    stop();
    resolve(pending);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
