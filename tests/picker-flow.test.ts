import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '../src/shared/messages';

const inject = vi.fn<(tabId: number) => Promise<void>>();
vi.mock('../src/background/inject-picker', () => ({ injectPicker: (tabId: number) => inject(tabId) }));

const EXTENSION_ID = 'ext-id';
const store = new Map<string, unknown>();
let tabUrl: string | undefined = 'https://example.com/page';

function install() {
  vi.stubGlobal('chrome', {
    runtime: { id: EXTENSION_ID },
    tabs: { get: async (id: number) => ({ id, url: tabUrl }) },
    storage: {
      session: {
        async get(keys: string[]) {
          return Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
        },
        async remove(keys: string[]) {
          for (const k of keys) store.delete(k);
        },
      },
    },
  });
}

async function load() {
  vi.resetModules();
  install();
  return import('../src/background/picker-flow');
}

const idle: RecordingState = { status: 'idle' };
const recording = (tabId: number): RecordingState => ({ status: 'recording', tabId, startedAt: 1 });
const stopped = (tabId: number): RecordingState => ({ status: 'stopped', tabId, startedAt: 1, stoppedAt: 2 });

function good(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ELEMENT_PICKED',
    element: {
      selector: '#buy',
      outerHTML: '<button id="buy">Buy</button>',
      styles: { display: 'block' },
      rect: { x: 1, y: 2, width: 3, height: 4 },
    },
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 2,
    pageUrl: 'https://example.com/page',
    pageTitle: 'Shop',
    ...overrides,
  };
}

const tabSender = (tabId = 9, extra: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender =>
  ({ id: EXTENSION_ID, tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, ...extra }) as chrome.runtime.MessageSender;

beforeEach(() => {
  store.clear();
  tabUrl = 'https://example.com/page';
  inject.mockReset();
  inject.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startPickerFlow (criterion 9, Q2)', () => {
  it('injects the picker on a normal tab', async () => {
    const flow = await load();
    await flow.startPickerFlow(4, idle);
    expect(inject).toHaveBeenCalledWith(4);
  });

  it('refuses a restricted page without injecting', async () => {
    const flow = await load();
    tabUrl = 'chrome://extensions';
    await expect(flow.startPickerFlow(4, idle)).rejects.toThrow("BugBrief can't record this page.");
    expect(inject).not.toHaveBeenCalled();
  });

  it('while recording, allows only the recorded tab', async () => {
    const flow = await load();
    await expect(flow.startPickerFlow(5, recording(4))).rejects.toThrow(flow.OTHER_TAB_MESSAGE);
    expect(inject).not.toHaveBeenCalled();
    await flow.startPickerFlow(4, recording(4));
    expect(inject).toHaveBeenCalledWith(4);
  });

  it('when stopped or idle, allows any tab', async () => {
    const flow = await load();
    await flow.startPickerFlow(5, stopped(4));
    await flow.startPickerFlow(6, idle);
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('maps a lost activeTab grant on a normal page to the reopen message', async () => {
    const flow = await load();
    inject.mockRejectedValue(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'));
    await expect(flow.startPickerFlow(4, idle)).rejects.toThrow(flow.REOPEN_MESSAGE);
  });

  it('keeps the restricted message when the page URL is hidden', async () => {
    const flow = await load();
    tabUrl = undefined;
    inject.mockRejectedValue(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'));
    await expect(flow.startPickerFlow(4, idle)).rejects.toThrow("BugBrief can't record this page.");
  });

  it('names the file URL setting on a file:// page', async () => {
    const flow = await load();
    tabUrl = 'file:///tmp/demo.html';
    inject.mockRejectedValue(new Error('Cannot access contents of url "file:///tmp/demo.html". Extension manifest must request permission to access this host.'));
    await expect(flow.startPickerFlow(4, idle)).rejects.toThrow(flow.FILE_URL_MESSAGE);
  });

  it('passes other errors through', async () => {
    const flow = await load();
    inject.mockRejectedValue(new Error('The tab was closed.'));
    await expect(flow.startPickerFlow(4, idle)).rejects.toThrow('The tab was closed.');
  });
});

describe('pickSenderTabId (criterion 10)', () => {
  it('accepts our own top-frame tab sender only', async () => {
    const flow = await load();
    expect(flow.pickSenderTabId(tabSender(9))).toBe(9);
    expect(flow.pickSenderTabId(tabSender(9, { id: 'someone-else' }))).toBeUndefined();
    expect(flow.pickSenderTabId({ id: EXTENSION_ID } as chrome.runtime.MessageSender)).toBeUndefined(); // popup
    expect(flow.pickSenderTabId(tabSender(9, { frameId: 3 }))).toBeUndefined();
    expect(flow.pickSenderTabId({ id: EXTENSION_ID, tab: {} as chrome.tabs.Tab } as chrome.runtime.MessageSender)).toBeUndefined();
  });
});

describe('receivePick', () => {
  it('validates, stores and reports the element', async () => {
    const flow = await load();
    expect(await flow.receivePick(good(), tabSender(9))).toBe(true);
    const fields = await flow.elementFields();
    expect(fields.hasElement).toBe(true);
    expect(fields.element).toMatchObject({ selector: '#buy', tabId: 9, pageUrl: 'https://example.com/page' });
    expect((store.get('elementSnapshot') as { snapshot: { screenshotDataUrl: string } }).snapshot.screenshotDataUrl).toBe('');
  });

  it('rejects a bad sender or payload with no state change', async () => {
    const flow = await load();
    expect(await flow.receivePick(good(), { id: EXTENSION_ID } as chrome.runtime.MessageSender)).toBe(false);
    expect(await flow.receivePick(good({ devicePixelRatio: 'x' }), tabSender(9))).toBe(false);
    expect(await flow.receivePick('junk', tabSender(9))).toBe(false);
    expect((await flow.elementFields()).hasElement).toBe(false);
    expect(store.size).toBe(0);
  });

  it('replaces the earlier pick', async () => {
    const flow = await load();
    await flow.receivePick(good(), tabSender(1));
    await flow.receivePick(good({ element: { ...good().element, selector: '#second' } }), tabSender(2));
    expect((await flow.elementFields()).element).toMatchObject({ selector: '#second', tabId: 2 });
  });

  it('survives a worker restart', async () => {
    const flow = await load();
    await flow.receivePick(good(), tabSender(9));
    const restarted = await load(); // fresh modules, same session storage
    expect((await restarted.elementFields()).hasElement).toBe(true);
  });

  it('logs no page data outside a debug build (criterion 14)', async () => {
    const flow = await load();
    const secretTitle = 'Reset password for jane@example.com';
    const secretSelector = 'input[value="hunter2"]';
    await flow.receivePick(
      good({ pageTitle: secretTitle, element: { ...good().element, selector: secretSelector, outerHTML: '<input value="hunter2">' } }),
      tabSender(9),
    );
    await flow.receivePick(good({ devicePixelRatio: 0, pageTitle: secretTitle }), tabSender(9)); // rejected
    const output = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map((v) => JSON.stringify(v)).join(' ');
    expect(output).toContain('element picked');
    for (const secret of ['hunter2', 'jane@example.com', secretTitle]) expect(output).not.toContain(secret);
  });
});
