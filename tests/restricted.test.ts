import { describe, expect, it } from 'vitest';
import { isRestrictedAttachError, isRestrictedUrl } from '../src/shared/restricted';

describe('isRestrictedUrl', () => {
  it.each([
    'chrome://extensions',
    'chrome-extension://abc/popup.html',
    'edge://settings',
    'about:blank',
    'view-source:https://example.com',
    'devtools://devtools/bundled/inspector.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
  ])('blocks %s', (url) => {
    expect(isRestrictedUrl(url)).toBe(true);
  });
  it.each(['http://localhost:5174/', 'https://example.com/chrome://x', 'file:///tmp/a.html'])('allows %s', (url) => {
    expect(isRestrictedUrl(url)).toBe(false);
  });
  it('allows an unknown url so attach can report the real error', () => {
    expect(isRestrictedUrl(undefined)).toBe(false);
  });
});

describe('isRestrictedAttachError', () => {
  it.each([
    'Cannot access a chrome:// URL',
    'Cannot access a chrome-extension:// URL of different extension',
    'Cannot attach to this target.',
    'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
    'Cannot access contents of url "devtools://devtools/bundled/inspector.html".',
  ])('flags %s', (message) => {
    expect(isRestrictedAttachError(message)).toBe(true);
  });
  it.each(['Another debugger is already attached to the tab with id: 1.', 'net::ERR_FAILED'])('ignores %s', (message) => {
    expect(isRestrictedAttachError(message)).toBe(false);
  });
});
