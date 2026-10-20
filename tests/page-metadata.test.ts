/** Pure rules for page metadata and its persistence (criterion 9). */
import { describe, expect, it } from 'vitest';
import { emptyState, rehydrateState, serialize } from '../src/core/buffer-model';
import { mergePageMetadata, pageFor, sanitizePageMetadata, sanitizeStoredPage, type PageMetadata } from '../src/core/page-metadata';

const U = 'http://localhost:5174/';

describe('sanitizePageMetadata', () => {
  it('accepts a title and a viewport of positive integers', () => {
    expect(sanitizePageMetadata({ title: 'Shop', width: 1280, height: 720 }, U)).toEqual({ title: 'Shop', viewport: { width: 1280, height: 720 }, forUrl: U });
  });
  it.each([
    ['null', null], ['a string', 'x'], ['an array', []], ['a number', 5],
    ['nothing usable', { title: 5, width: -1, height: 0 }],
    ['an empty title and no viewport', { title: '', width: 'a', height: 'b' }],
  ])('returns nothing for %s', (_label, raw) => {
    expect(sanitizePageMetadata(raw, U)).toBeUndefined();
  });
  it('drops a non-string title but keeps a good viewport', () => {
    expect(sanitizePageMetadata({ title: { toString: () => 'evil' }, width: 800, height: 600 }, U)).toEqual({ title: '', viewport: { width: 800, height: 600 }, forUrl: U });
  });
  it.each([[0, 10], [-5, 10], [1.5, 10], [Number.NaN, 10], [Infinity, 10], [200_000, 10], ['800', 10]])('drops the viewport for width %j', (width, height) => {
    expect(sanitizePageMetadata({ title: 'T', width, height }, U)?.viewport).toBeUndefined();
  });
  it('cuts the title to 512 characters', () => {
    expect(sanitizePageMetadata({ title: 'x'.repeat(900) }, U)?.title).toHaveLength(512);
  });
});

describe('mergePageMetadata', () => {
  const start: PageMetadata = { title: 'Start', viewport: { width: 1, height: 1 }, forUrl: U };
  it('a newer value wins', () => {
    expect(mergePageMetadata(start, { title: 'Stop', viewport: { width: 2, height: 2 }, forUrl: U })).toEqual({ title: 'Stop', viewport: { width: 2, height: 2 }, forUrl: U });
  });
  it('an empty title never erases a non-empty one for the same URL', () => {
    expect(mergePageMetadata(start, { title: '', forUrl: U })).toEqual({ title: 'Start', viewport: { width: 1, height: 1 }, forUrl: U });
  });
  it('an empty title does erase an older one for another URL', () => {
    expect(mergePageMetadata(start, { title: '', forUrl: `${U}next` })).toEqual({ title: '', forUrl: `${U}next` });
  });
  it('keeps the earlier value when the new read failed', () => {
    expect(mergePageMetadata(start, undefined)).toBe(start);
    expect(mergePageMetadata(undefined, start)).toBe(start);
  });
});

describe('pageFor', () => {
  it('returns the metadata only while it describes the current page', () => {
    const page: PageMetadata = { title: 'T', forUrl: U };
    expect(pageFor(page, U)).toBe(page);
    expect(pageFor(page, `${U}next`)).toBeUndefined();
    expect(pageFor(page, undefined)).toBeUndefined();
    expect(pageFor(undefined, U)).toBeUndefined();
  });
});

describe('persistence in buffer.meta', () => {
  it('round-trips through serialize and rehydrate', () => {
    const state = { ...emptyState(), pageUrl: U, page: { title: 'T', viewport: { width: 5, height: 6 }, forUrl: U } };
    expect(rehydrateState(serialize(state, true)).page).toEqual(state.page);
  });
  it('rehydrates data stored by an older build, which has no page', () => {
    const state = rehydrateState({ 'buffer.meta': { pageUrl: U, nextSeq: 3, evicted: {} } });
    expect(state.page).toBeUndefined();
    expect(state.pageUrl).toBe(U);
  });
  it('re-validates a stored value, since storage can hold anything', () => {
    expect(sanitizeStoredPage({ title: 5, forUrl: U })).toBeUndefined();
    expect(sanitizeStoredPage({ title: 'T', forUrl: 7 })).toBeUndefined();
    expect(sanitizeStoredPage('junk')).toBeUndefined();
    expect(rehydrateState({ 'buffer.meta': { page: { title: 'T', width: -1, forUrl: U } } }).page).toEqual({ title: 'T', forUrl: U });
  });
});
