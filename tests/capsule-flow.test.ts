/** Step 5: BUILD_CAPSULE and DOWNLOAD_CAPSULE guards, the hash check and the saved files (criteria 11, 12). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildDeps } from '../src/background/capsule-builder';
import { createCapsuleFlow, RECORDING_MESSAGE, STALE_MESSAGE } from '../src/background/capsule-flow';
import { MAX_DOWNLOAD_URL, downloadCapsule, markdownDataUrl, type DownloadOptions } from '../src/background/download';
import type { RecordingState } from '../src/shared/messages';
import type { ElementSnapshot } from '../src/core/types';
import { consoleEntry, UA } from './helpers/capsule';

const idle: RecordingState = { status: 'idle' };
const recording: RecordingState = { status: 'recording', tabId: 7, startedAt: 1 };
const BASE = { state: idle, hasElement: false } as never;

interface Rig { note?: string; element?: ElementSnapshot; pickedAt: number; status: 'captured' | 'pending' }
function make(rig: Rig = { pickedAt: 1, status: 'captured' }) {
  const state = { ...rig };
  const deps: BuildDeps = {
    readBuffer: () => ({ console: [consoleEntry({ message: 'boom' })], network: [], pageUrl: 'http://localhost:5174/', page: { title: 'Orders', forUrl: 'http://localhost:5174/' }, evicted: { console: { entries: 0, occurrences: 0 }, network: { entries: 0, occurrences: 0 } } }),
    readElement: () => state.element
      ? { snapshot: state.element, tabId: 3, pickedAt: state.pickedAt, page: { url: 'http://localhost:5174/', title: 'T', viewport: { width: 1, height: 1 }, devicePixelRatio: 1 }, screenshot: { status: state.status } }
      : undefined,
    userAgent: () => UA,
    now: () => new Date('2026-10-20T10:15:30.120Z'),
  };
  const calls: DownloadOptions[] = [];
  const downloads = { download: vi.fn(async (options: DownloadOptions) => void calls.push(options)) };
  return { state, flow: createCapsuleFlow(deps, downloads), calls, downloads };
}
const picked = (extra: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  selector: '#buy', outerHTML: '<b>x</b>', styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, screenshotDataUrl: 'data:image/png;base64,AAAA', ...extra,
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('build', () => {
  it('returns the Markdown, the count, capturedAt, the hash and the screenshot kind', () => {
    const { flow } = make();
    const response = flow.build({ type: 'BUILD_CAPSULE', userNote: 'n' }, idle, BASE);
    expect(response).toMatchObject({ ok: true, capturedAt: '2026-10-20T10:15:30.120Z', screenshot: 'none' });
    expect(response.ok && response.markdown).toContain('# Bug Capsule — Orders');
    expect(response.ok && typeof response.previewHash).toBe('string');
    expect(response.ok && typeof response.redactionCount).toBe('number');
  });
  it('refuses while a recording is running', () => {
    expect(make().flow.build({ type: 'BUILD_CAPSULE', userNote: '' }, recording, BASE)).toEqual({ ok: false, error: RECORDING_MESSAGE });
  });
  it('treats a non-string note as empty instead of throwing', () => {
    expect(make().flow.build({ type: 'BUILD_CAPSULE', userNote: 5 as never }, idle, BASE).ok).toBe(true);
  });
  it('reports nothing to report as a failure', () => {
    const empty = createCapsuleFlow({ readBuffer: () => ({ console: [], network: [], evicted: { console: { entries: 0, occurrences: 0 }, network: { entries: 0, occurrences: 0 } } }), readElement: () => undefined, userAgent: () => UA, now: () => new Date() }, { download: async () => undefined });
    expect(empty.build({ type: 'BUILD_CAPSULE', userNote: '' }, idle, BASE)).toEqual({ ok: false, error: 'Nothing to report yet.' });
  });
});

describe('download (criterion 12)', () => {
  async function preview(rig: ReturnType<typeof make>, note = '') {
    const built = rig.flow.build({ type: 'BUILD_CAPSULE', userNote: note }, idle, BASE);
    if (!built.ok || !built.capturedAt || !built.previewHash) throw new Error('preview failed');
    return { capturedAt: built.capturedAt, previewHash: built.previewHash, markdown: built.markdown ?? '' };
  }

  it('saves the .md and the .png with the same stamp, matching the previewed text', async () => {
    const rig = make({ element: picked(), pickedAt: 1, status: 'captured' });
    const p = await preview(rig, 'note');
    const response = await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: 'note', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE);
    expect(response).toMatchObject({ ok: true, files: ['conscribe/capsule-20261020-101530.md', 'conscribe/capsule-20261020-101530.png'] });
    expect(rig.calls.map((c) => c.filename)).toEqual(['conscribe/capsule-20261020-101530.md', 'conscribe/capsule-20261020-101530.png']);
    expect(rig.calls.every((c) => c.saveAs === false && c.conflictAction === 'uniquify')).toBe(true);
    expect(rig.calls[0]?.url).toBe(markdownDataUrl(p.markdown));
    expect(decodeURIComponent((rig.calls[0]?.url ?? '').split(',').slice(1).join(','))).toBe(p.markdown);
    expect(p.markdown).toContain('capsule-20261020-101530.png');
    expect(rig.calls[1]?.url).toBe('data:image/png;base64,AAAA');
  });
  it('skips the .png when there is no image', async () => {
    const rig = make();
    const p = await preview(rig);
    const response = await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE);
    expect(response).toMatchObject({ ok: true, files: ['conscribe/capsule-20261020-101530.md'] });
    expect(rig.calls).toHaveLength(1);
  });
  it('refuses while recording, and without a preview', async () => {
    const rig = make();
    const p = await preview(rig);
    expect(await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', ...p }, recording, BASE)).toEqual({ ok: false, error: RECORDING_MESSAGE });
    for (const bad of [{ capturedAt: 'yesterday', previewHash: p.previewHash }, { capturedAt: p.capturedAt, previewHash: 5 as never }]) {
      expect(await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', ...bad }, idle, BASE)).toEqual({ ok: false, error: 'Preview first.', code: 'preview-required' });
    }
    expect(rig.calls).toEqual([]);
  });
  it('refuses when the note changed after the preview', async () => {
    const rig = make();
    const p = await preview(rig, 'one');
    expect(await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: 'two', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE)).toEqual({ ok: false, error: STALE_MESSAGE, code: 'stale-preview' });
    expect(rig.calls).toEqual([]);
  });
  it('refuses when the element was re-picked with identical Markdown but a different image', async () => {
    const rig = make({ element: picked(), pickedAt: 1, status: 'captured' });
    const p = await preview(rig);
    rig.state.pickedAt = 2;
    expect(await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE)).toEqual({ ok: false, error: STALE_MESSAGE, code: 'stale-preview' });
    rig.state.pickedAt = 1;
    rig.state.element = picked({ screenshotDataUrl: 'data:image/png;base64,AAAAAAAA' });
    expect(await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE)).toEqual({ ok: false, error: STALE_MESSAGE, code: 'stale-preview' });
    expect(rig.calls).toEqual([]);
  });
  it('refuses while the screenshot is still being captured', async () => {
    const rig = make({ element: picked({ screenshotDataUrl: '' }), pickedAt: 1, status: 'pending' });
    const p = await preview(rig);
    const response = await rig.flow.download({ type: 'DOWNLOAD_CAPSULE', userNote: '', capturedAt: p.capturedAt, previewHash: p.previewHash }, idle, BASE);
    expect(response.ok).toBe(false);
    expect(rig.calls).toEqual([]);
  });
});

describe('downloadCapsule (criterion 12)', () => {
  const ok = (calls: DownloadOptions[]) => ({ download: async (o: DownloadOptions) => void calls.push(o) });
  it('names which file failed: the .md fails first, nothing else is tried', async () => {
    const calls: DownloadOptions[] = [];
    const result = await downloadCapsule({ download: async (o) => { calls.push(o); throw new Error('Invalid filename'); } }, { markdown: 'x', pngDataUrl: 'data:image/png;base64,AA', stamp: '20261020-101530' });
    expect(result).toEqual({ ok: false, error: 'The Markdown file could not be saved.' });
    expect(calls).toHaveLength(1);
  });
  it('says the .md was saved when only the .png fails', async () => {
    let n = 0;
    const result = await downloadCapsule({ download: async () => { if (++n === 2) throw new Error('boom'); } }, { markdown: 'x', pngDataUrl: 'data:image/png;base64,AA', stamp: 's' });
    expect(result).toEqual({ ok: false, error: 'The Markdown file was saved, but the screenshot could not be.' });
  });
  it('refuses a URL over the limit before saving anything', async () => {
    const calls: DownloadOptions[] = [];
    expect(await downloadCapsule(ok(calls), { markdown: 'x'.repeat(MAX_DOWNLOAD_URL), pngDataUrl: '', stamp: 's' })).toMatchObject({ ok: false });
    expect(await downloadCapsule(ok(calls), { markdown: 'x', pngDataUrl: `data:image/png;base64,${'A'.repeat(MAX_DOWNLOAD_URL)}`, stamp: 's' })).toEqual({ ok: false, error: 'The screenshot is too large to download.' });
    expect(calls).toEqual([]);
  });
  it('logs no page data', async () => {
    await downloadCapsule({ download: async () => { throw new Error('Cannot open "https://x.test/secret?token=ABC"'); } }, { markdown: 'SECRETMD', pngDataUrl: '', stamp: 's' });
    const out = JSON.stringify([...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]);
    expect(out).not.toContain('ABC');
    expect(out).not.toContain('SECRETMD');
  });
});
