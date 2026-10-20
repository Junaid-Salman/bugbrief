import { describe, expect, it } from 'vitest';
import { dataSignature, type CapsuleUi, type PreviewState } from '../src/popup/capsule-state';
import { plural, recordedSummary } from '../src/popup/copy';
import { stepsView } from '../src/popup/steps';
import type { BufferCounts, ElementSummary } from '../src/shared/messages';

const counts = (errors = 2, requests = 3, evicted = 0): BufferCounts => ({
  console: { unique: errors, total: errors * 3, evicted: { entries: evicted, occurrences: evicted } },
  network: { unique: requests, total: requests * 2, evicted: { entries: 0, occurrences: 0 } },
});
const element = (screenshot: ElementSummary['screenshot'] = 'captured'): ElementSummary => ({ selector: 'ul.order-list', tabId: 1, pageUrl: 'u', pickedAt: 5, screenshot });
const stopped = { status: 'stopped' as const, tabId: 1, startedAt: 1, stoppedAt: 2 };
const recording = { status: 'recording' as const, tabId: 1, startedAt: 1 };

function ui(patch: Partial<CapsuleUi> = {}): CapsuleUi {
  return { loaded: true, busy: false, state: stopped, counts: counts(), element: undefined, note: '', preview: undefined, downloaded: false, ...patch };
}
function withPreview(patch: Partial<CapsuleUi> = {}, preview: Partial<PreviewState> = {}): CapsuleUi {
  const base = ui(patch);
  return { ...base, preview: { markdown: '# x', redactionCount: 2, capturedAt: 'c', previewHash: 'h', screenshot: 'none', note: base.note, signature: dataSignature(base.counts, base.element), ...preview } };
}

describe('stepsView: which steps are open and where the rail stands', () => {
  it('idle with nothing captured: Record and Pick open, Share folded', () => {
    expect(stepsView(ui({ state: { status: 'idle' }, counts: undefined }))).toMatchObject({ open: [true, true, false], rail: [1, 0, 0] });
  });
  it('recording: all three open, Record active', () => {
    expect(stepsView(ui({ state: recording }))).toMatchObject({ open: [true, true, true], rail: [1, 0, 0] });
  });
  it('recording with a captured element: Pick folds to done', () => {
    expect(stepsView(ui({ state: recording, element: element() }))).toMatchObject({ open: [true, false, true], rail: [1, 2, 0] });
  });
  it('stopped with a captured element: Record and Pick fold, Share is active', () => {
    expect(stepsView(ui({ element: element() }))).toMatchObject({ open: [false, false, true], rail: [2, 2, 1] });
  });
  it('a clipped screenshot counts as captured', () => {
    expect(stepsView(ui({ element: element('clipped') }))).toMatchObject({ open: [false, false, true], rail: [2, 2, 1] });
  });
  it('a pending screenshot keeps Pick open and Share not yet active', () => {
    expect(stepsView(ui({ element: element('pending') }))).toMatchObject({ open: [false, true, true], rail: [2, 1, 0] });
  });
  it('an unavailable screenshot keeps Pick open, and Share stays usable', () => {
    expect(stepsView(ui({ element: element('unavailable') }))).toMatchObject({ open: [false, true, true], rail: [2, 1, 1] });
  });
  it('stopped with entries and no element: Pick is open and optional', () => {
    expect(stepsView(ui())).toMatchObject({ open: [false, true, true], rail: [2, 0, 1] });
  });
  it('an element alone (no recording): Record stays open and idle, Share is active', () => {
    expect(stepsView(ui({ state: { status: 'idle' }, counts: undefined, element: element() }))).toMatchObject({ open: [true, false, true], rail: [0, 2, 1] });
  });
  it('a fresh preview completes Share; a stale one does not', () => {
    expect(stepsView(withPreview({ element: element() })).rail).toEqual([2, 2, 2]);
    expect(stepsView(withPreview({ element: element(), note: 'edited' }, { note: 'old' })).rail).toEqual([2, 2, 1]);
  });
  it('dropped entries alone still count as something recorded', () => {
    const only = { console: { unique: 0, total: 0, evicted: { entries: 3, occurrences: 9 } }, network: { unique: 0, total: 0, evicted: { entries: 0, occurrences: 0 } } };
    expect(stepsView(ui({ counts: only })).open[0]).toBe(false);
  });
});

describe('recordedSummary and plural', () => {
  it('names both counts', () => expect(recordedSummary(counts(2, 3))).toBe('2 errors · 3 failed requests'));
  it('uses singular forms', () => expect(recordedSummary(counts(1, 1))).toBe('1 error · 1 failed request'));
  it('shows zero explicitly', () => expect(recordedSummary(counts(0, 3))).toBe('0 errors · 3 failed requests'));
  it('plural handles an irregular plural', () => {
    expect(plural(1, 'older entry', 'older entries')).toBe('1 older entry');
    expect(plural(3, 'older entry', 'older entries')).toBe('3 older entries');
  });
});
