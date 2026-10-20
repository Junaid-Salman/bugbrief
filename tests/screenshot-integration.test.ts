/**
 * Step 7: a captured snapshot through P4's redactCapsule (criterion 15), and what the capture flow
 * logs (criterion 14), in a normal build and in a debug build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDeps } from '../src/background/screenshot';
import type { CapsuleDraft } from '../src/core/redact/redact';
import { SEED, mulberry32 } from './helpers/secrets';

vi.mock('../src/background/inject-picker', () => ({ injectPicker: async () => undefined }));

const SECRET_URL = 'https://example.com/reset?token=URLSECRET123';
const SECRET_TITLE = 'Reset password for jane@example.com';
const SECRET_SELECTOR = 'input[value="hunter2"]';
const EXT = 'ext';

// A long base64 payload that the long-run rule would mask if the data URL were ever redacted.
function fakePng(): string {
  const rng = mulberry32(SEED);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let body = '';
  for (let i = 0; i < 6000; i++) body += alphabet[Math.floor(rng() * alphabet.length)];
  return `data:image/png;base64,${body}`;
}
const PNG = fakePng();

const message = {
  type: 'ELEMENT_PICKED' as const,
  element: {
    selector: SECRET_SELECTOR,
    outerHTML: '<input type="password" value="hunter2">',
    styles: { display: 'block' },
    rect: { x: 100, y: 200, width: 300, height: 100 },
  },
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 2,
  pageUrl: SECRET_URL,
  pageTitle: SECRET_TITLE,
};
const sender = { id: EXT, tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;

function fakeDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    getTab: async () => ({ active: true, windowId: 1, url: SECRET_URL }),
    capture: async () => 'data:image/png;base64,RAW',
    decode: async () => ({ width: 2560, height: 1600, close: () => undefined }),
    encode: async () => PNG,
    storageBytesInUse: async () => 0,
    storageQuota: () => 10_485_760,
    now: () => 1_000_000,
    sleep: async () => undefined,
    setTimer: () => () => undefined,
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  const data = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    runtime: { id: EXT },
    storage: {
      session: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
        set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
        remove: async (keys: string[]) => void keys.forEach((k) => data.delete(k)),
      },
    },
  });
  const element = await import('../src/background/element');
  const flow = await import('../src/background/picker-flow');
  const shot = await import('../src/background/screenshot');
  const redact = await import('../src/core/redact/redact');
  await element.elementsReady;
  return { elements: element.elements, receivePick: flow.receivePick, shot, redact };
}

const IDLE = { status: 'idle' } as const;

function draftWith(element: CapsuleDraft['element']): CapsuleDraft {
  return { pageUrl: SECRET_URL, pageTitle: SECRET_TITLE, userAgent: 'ua', viewport: { width: 1280, height: 800 }, capturedAt: 'now', console: [], network: [], element };
}

function consoleOutput(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map((v) => JSON.stringify(v)).join(' ');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a captured snapshot through redactCapsule (criterion 15)', () => {
  it('passes the data URL through unchanged and keeps the clipped flag, while text is still masked', async () => {
    const { elements, receivePick, shot, redact } = await load();
    await receivePick(message, sender, IDLE);
    await shot.captureForPick(shot.createCapturer(fakeDeps()), elements);
    await elements.flush();
    const snapshot = elements.snapshot();
    expect(snapshot?.screenshotDataUrl).toBe(PNG);

    const { draft, redactionCount } = redact.redactCapsule(draftWith(snapshot));
    expect(draft.element?.screenshotDataUrl).toBe(PNG);
    expect(draft.element?.selector).toBe('input[value="[REDACTED]"]');
    expect(JSON.stringify(draft)).not.toContain('hunter2');
    expect(draft.pageUrl).not.toContain('URLSECRET123');
    // The image adds nothing to the count: only the text fields were masked.
    const withoutImage = redact.redactCapsule(draftWith({ ...(snapshot as NonNullable<typeof snapshot>), screenshotDataUrl: '' }));
    expect(redactionCount).toBe(withoutImage.redactionCount);
  });

  it('keeps screenshotClipped for a clipped capture', async () => {
    const { elements, receivePick, shot, redact } = await load();
    await receivePick({ ...message, element: { ...message.element, rect: { x: 1200, y: 700, width: 300, height: 300 } } }, sender, IDLE);
    await shot.captureForPick(shot.createCapturer(fakeDeps()), elements);
    await elements.flush();
    const { draft } = redact.redactCapsule(draftWith(elements.snapshot()));
    expect(draft.element?.screenshotClipped).toBe(true);
    expect(draft.element?.screenshotUnavailable).toBeUndefined();
    expect(draft.element?.screenshotDataUrl).toBe(PNG);
  });

  it('keeps the unavailable reason and an empty image', async () => {
    const { elements, receivePick, shot, redact } = await load();
    await receivePick(message, sender, IDLE);
    await shot.captureForPick(shot.createCapturer(fakeDeps({ getTab: async () => ({ active: false, windowId: 1, url: SECRET_URL }) })), elements);
    await elements.flush();
    const { draft } = redact.redactCapsule(draftWith(elements.snapshot()));
    expect(draft.element?.screenshotUnavailable).toBe('tab-not-active');
    expect(draft.element?.screenshotDataUrl).toBe('');
    expect(draft.element?.screenshotClipped).toBeUndefined();
  });

  it('is idempotent: a second redaction pass changes nothing and counts nothing', async () => {
    const { elements, receivePick, shot, redact } = await load();
    await receivePick(message, sender, IDLE);
    await shot.captureForPick(shot.createCapturer(fakeDeps()), elements);
    await elements.flush();
    const first = redact.redactCapsule(draftWith(elements.snapshot()));
    const second = redact.redactCapsule(first.draft);
    expect(second.redactionCount).toBe(0);
    expect(second.draft.element).toEqual(first.draft.element);
  });
});

describe('what the capture flow logs (criterion 14, N2)', () => {
  async function runFlow(overrides: Partial<CaptureDeps> = {}) {
    const { elements, receivePick, shot } = await load();
    await receivePick(message, sender, IDLE);
    await shot.captureForPick(shot.createCapturer(fakeDeps(overrides)), elements);
    await elements.flush();
  }

  it('normal build: nothing from the page and no image data, on success and on failure', async () => {
    await runFlow();
    await runFlow({ capture: async () => { throw new Error(`Cannot access contents of url "${SECRET_URL}"`); } });
    await runFlow({ getTab: async () => ({ active: false, windowId: 1, url: SECRET_URL }) });
    const output = consoleOutput();
    expect(output).toContain('screenshot stored');
    expect(output).toContain('screenshot unavailable');
    for (const secret of ['hunter2', 'URLSECRET123', SECRET_TITLE, 'jane@example.com', PNG.slice(30, 80), 'data:image/png']) {
      expect(output, secret).not.toContain(secret);
    }
  });

  it('debug build: the existing "picked element" line may carry page data by design, but never the image', async () => {
    vi.stubEnv('VITE_BUGBRIEF_DEBUG', 'true');
    await runFlow();
    const output = consoleOutput();
    expect(output).toContain('picked element'); // log.debug in picker-flow.ts, debug builds only
    expect(output).toContain('screenshot size');
    expect(output).toContain(`"chars":${PNG.length}`);
    expect(output).not.toContain(PNG.slice(30, 80));
    expect(output).not.toContain('data:image/png');
  });
});
