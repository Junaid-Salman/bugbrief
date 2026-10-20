import { describe, expect, it } from 'vitest';
import { FIELD } from '../src/core/limits';
import {
  SCREENSHOT_WARNING, STALE_NOTE, badgeText, canCopy, canDownload, canPreview, dataSignature, hasData, isStale,
  previewHint, showsScreenshotWarning, type CapsuleUi, type PreviewState,
} from '../src/popup/capsule-state';
import { NOTE_KEY, cap, createDraftWriter, loadDraft, type DraftStorage } from '../src/popup/note-draft';
import type { BufferCounts, ElementSummary } from '../src/shared/messages';

const counts = (unique = 1): BufferCounts => ({
  console: { unique, total: unique, evicted: { entries: 0, occurrences: 0 } },
  network: { unique: 0, total: 0, evicted: { entries: 0, occurrences: 0 } },
});
const element = (screenshot: ElementSummary['screenshot'] = 'captured'): ElementSummary => ({ selector: '#a', tabId: 1, pageUrl: 'u', pickedAt: 5, screenshot });

function ui(patch: Partial<CapsuleUi> = {}): CapsuleUi {
  return { loaded: true, busy: false, state: { status: 'stopped', tabId: 1, startedAt: 1, stoppedAt: 2 }, counts: counts(), element: undefined, note: '', preview: undefined, downloaded: false, ...patch };
}
function withPreview(patch: Partial<CapsuleUi> = {}, preview: Partial<PreviewState> = {}): CapsuleUi {
  const base = ui(patch);
  return { ...base, preview: { markdown: '# x', redactionCount: 2, capturedAt: 'c', previewHash: 'h', screenshot: 'none', note: base.note, signature: dataSignature(base.counts, base.element), ...preview } };
}

describe('canPreview (criterion 14, Q1)', () => {
  it('is on for a stopped recording with data', () => expect(canPreview(ui())).toBe(true));
  it('is on for an element alone and for an idle state', () => expect(canPreview(ui({ counts: undefined, element: element(), state: { status: 'idle' } }))).toBe(true));
  it.each([
    ['not loaded', { loaded: false }], ['busy', { busy: true }],
    ['recording', { state: { status: 'recording' as const, tabId: 1, startedAt: 1 } }],
    ['nothing to report', { counts: undefined, element: undefined }],
    ['a pending screenshot', { element: element('pending') }],
  ])('is off when %s', (_label, patch) => expect(canPreview(ui(patch as Partial<CapsuleUi>))).toBe(false));
});

describe('stale previews (Q18)', () => {
  it('a fresh preview is not stale and allows Copy and Download', () => {
    const v = withPreview();
    expect(isStale(v)).toBe(false);
    expect(canCopy(v)).toBe(true);
    expect(canDownload(v)).toBe(true);
  });
  it('editing the note makes it stale and disables Copy and Download', () => {
    const v = { ...withPreview(), note: 'changed' };
    expect(isStale(v)).toBe(true);
    expect(canCopy(v)).toBe(false);
    expect(canDownload(v)).toBe(false);
    expect(previewHint(v)).toBe(STALE_NOTE);
  });
  it('a re-pick, a new screenshot status or new entries make it stale', () => {
    const v = withPreview({ element: element('captured') });
    expect(isStale({ ...v, element: { ...element('captured'), pickedAt: 6 } })).toBe(true);
    expect(isStale({ ...v, element: element('unavailable') })).toBe(true);
    expect(isStale({ ...v, counts: counts(2) })).toBe(true);
    expect(isStale({ ...v, element: undefined })).toBe(true);
  });
  it('no preview means no Copy and no Download', () => {
    expect(canCopy(ui())).toBe(false);
    expect(canDownload(ui())).toBe(false);
  });
});

describe('Download after a success (Q13)', () => {
  it('is disabled until the next Preview, while Copy stays on', () => {
    const v = { ...withPreview(), downloaded: true };
    expect(canDownload(v)).toBe(false);
    expect(canCopy(v)).toBe(true);
  });
  it('is off while recording or a screenshot is pending', () => {
    expect(canDownload({ ...withPreview(), state: { status: 'recording', tabId: 1, startedAt: 1 } })).toBe(false);
    expect(canDownload({ ...withPreview({ element: element('pending') }) })).toBe(false);
  });
});

describe('warning, badge and hints', () => {
  it('warns about the screenshot only when an image goes with Download', () => {
    expect(showsScreenshotWarning(withPreview({}, { screenshot: 'captured' }))).toBe(true);
    expect(showsScreenshotWarning(withPreview({}, { screenshot: 'clipped' }))).toBe(true);
    for (const s of ['none', 'pending', 'unavailable'] as const) expect(showsScreenshotWarning(withPreview({}, { screenshot: s }))).toBe(false);
    expect(SCREENSHOT_WARNING).toBe('Screenshot is not redacted. Check it before sharing.');
  });
  it('pluralizes the badge', () => {
    expect(badgeText(0)).toBe('0 values redacted');
    expect(badgeText(1)).toBe('1 value redacted');
    expect(badgeText(12)).toBe('12 values redacted');
  });
  it('explains why Preview is off, in priority order', () => {
    expect(previewHint(ui({ state: { status: 'recording', tabId: 1, startedAt: 1 } }))).toBe('Stop recording to preview.');
    expect(previewHint(ui({ element: element('pending') }))).toBe('Waiting for the screenshot…');
    expect(previewHint(ui({ counts: undefined }))).toContain('Nothing to report');
    expect(previewHint(ui())).toBeUndefined();
  });
  it('hasData counts evicted entries and an element', () => {
    expect(hasData({ counts: undefined, element: undefined })).toBe(false);
    expect(hasData({ counts: undefined, element: element() })).toBe(true);
  });
});

function fakeStorage(): DraftStorage & { data: Map<string, unknown>; sets: number } {
  const data = new Map<string, unknown>();
  const api = {
    data, sets: 0,
    async get(key: string) { return data.has(key) ? { [key]: data.get(key) } : {}; },
    async set(items: Record<string, unknown>) { api.sets += 1; for (const [k, v] of Object.entries(items)) data.set(k, v); },
    async remove(key: string) { data.delete(key); },
  };
  return api;
}

describe('note draft (criterion 13, Q16)', () => {
  it('writes on every input, with no debounce', async () => {
    const storage = fakeStorage();
    const writer = createDraftWriter(storage);
    await writer.update('a');
    await writer.update('ab');
    expect(storage.sets).toBe(2);
    expect(storage.data.get(NOTE_KEY)).toBe('ab');
  });
  it('a draft typed just before the popup closes is restored (pagehide flush)', async () => {
    const storage = fakeStorage();
    const writer = createDraftWriter(storage);
    void writer.update('typed just now'); // not awaited: the popup is closing
    await writer.flush();
    expect(await loadDraft(storage)).toBe('typed just now');
  });
  it('caps the draft at 2 000 characters on write and on load', async () => {
    const storage = fakeStorage();
    await createDraftWriter(storage).update('x'.repeat(5000));
    expect((storage.data.get(NOTE_KEY) as string).length).toBe(FIELD.userNote);
    storage.data.set(NOTE_KEY, 'y'.repeat(9000));
    expect((await loadDraft(storage)).length).toBe(FIELD.userNote);
    expect(cap('short')).toBe('short');
  });
  it('Clear removes the draft', async () => {
    const storage = fakeStorage();
    const writer = createDraftWriter(storage);
    await writer.update('note');
    await writer.clear();
    expect(storage.data.has(NOTE_KEY)).toBe(false);
    expect(await loadDraft(storage)).toBe('');
  });
  it('tolerates a broken storage and a non-string value', async () => {
    const broken: DraftStorage = { get: async () => { throw new Error('no'); }, set: async () => { throw new Error('no'); }, remove: async () => { throw new Error('no'); } };
    expect(await loadDraft(broken)).toBe('');
    await expect(createDraftWriter(broken).update('x')).resolves.toBeUndefined();
    await expect(createDraftWriter(broken).clear()).resolves.toBeUndefined();
    const odd = fakeStorage();
    odd.data.set(NOTE_KEY, { not: 'a string' });
    expect(await loadDraft(odd)).toBe('');
  });
});
