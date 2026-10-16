import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '../src/shared/messages';

interface Options {
  stored?: RecordingState;
  targets?: Array<{ tabId?: number; attached: boolean }> | Error;
  evaluate?: () => Promise<unknown>;
  getGate?: Promise<void>;
}

function install(options: Options = {}) {
  const store = new Map<string, unknown>();
  if (options.stored) store.set('recordingState', options.stored);
  const calls = { evaluate: 0, getTargets: 0 };
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        async get(key: string) {
          if (options.getGate) await options.getGate;
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
      },
    },
    debugger: {
      async getTargets() {
        calls.getTargets += 1;
        if (options.targets instanceof Error) throw options.targets;
        return options.targets ?? [{ tabId: 7, attached: true }];
      },
      async sendCommand(_target: unknown, method: string) {
        if (method === 'Runtime.evaluate') {
          calls.evaluate += 1;
          return options.evaluate ? options.evaluate() : { result: { value: 1 } };
        }
        return {};
      },
    },
  });
  return { store, calls };
}

const recording: RecordingState = { status: 'recording', tabId: 7, startedAt: 1000 };
const stoppedAt = (state: RecordingState) => state.status;

async function load() {
  vi.resetModules();
  return import('../src/background/state');
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('probeSession', () => {
  it('is alive when the probe answers', async () => {
    install();
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('alive');
  });

  it('is dead when getTargets has no target for the tab, without probing', async () => {
    const { calls } = install({ targets: [{ tabId: 99, attached: true }] });
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('dead');
    expect(calls.evaluate).toBe(0);
  });

  it('is dead when getTargets says the tab is not attached, without probing', async () => {
    const { calls } = install({ targets: [{ tabId: 7, attached: false }] });
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('dead');
    expect(calls.evaluate).toBe(0);
  });

  it('falls back to the probe when getTargets throws', async () => {
    const { calls } = install({ targets: new Error('boom') });
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('alive');
    expect(calls.evaluate).toBe(1);
  });

  it('is alive when the probe hangs, after the probe timeout', async () => {
    install({ evaluate: () => new Promise(() => undefined) });
    const { probeSession } = await load();
    const result = probeSession(7);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(result).resolves.toBe('alive');
  });

  it.each([
    'Cannot find context with specified id',
    'Execution context was destroyed.',
    'Inspected target navigated or closed',
    'Something unexpected',
  ])('is alive on the transient error "%s"', async (message) => {
    install({ evaluate: () => Promise.reject(new Error(message)) });
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('alive');
  });

  it.each([
    'Debugger is not attached to the tab with id: 7.',
    'Detached while handling command.',
    'No tab with given id 7.',
    'No target with given id 7.',
  ])('is dead on the error "%s"', async (message) => {
    install({ evaluate: () => Promise.reject(new Error(message)) });
    const { probeSession } = await load();
    await expect(probeSession(7)).resolves.toBe('dead');
  });
});

describe('reconcile', () => {
  it('keeps a live recording', async () => {
    install({ stored: recording });
    const { reconcile, getCurrent } = await load();
    expect(stoppedAt(await reconcile())).toBe('recording');
    expect(getCurrent().status).toBe('recording');
  });

  it('turns a recording with a dead session into stopped and stores it', async () => {
    const { store } = install({ stored: recording, targets: [{ tabId: 7, attached: false }] });
    const { reconcile, getCurrent } = await load();
    const result = await reconcile();
    expect(result.status).toBe('stopped');
    expect(getCurrent().status).toBe('stopped');
    expect((store.get('recordingState') as RecordingState).status).toBe('stopped');
  });

  it('keeps a recording when the probe fails with a transient error', async () => {
    install({ stored: recording, evaluate: () => Promise.reject(new Error('Cannot find context with specified id')) });
    const { reconcile } = await load();
    expect((await reconcile()).status).toBe('recording');
  });

  it('keeps a recording when the probe hangs', async () => {
    install({ stored: recording, evaluate: () => new Promise(() => undefined) });
    const { reconcile } = await load();
    const result = reconcile();
    await vi.advanceTimersByTimeAsync(1200);
    expect((await result).status).toBe('recording');
  });

  it('does not let a stale stored value overwrite a state set while it was reading', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    install({ stored: recording, getGate: gate });
    const { reconcile, setState, getCurrent } = await load();
    const pending = reconcile();
    await setState({ status: 'stopped', tabId: 7, startedAt: 1000, stoppedAt: 2000 });
    open();
    const result = await pending;
    expect(result.status).toBe('stopped');
    expect(getCurrent().status).toBe('stopped');
  });

  it('does not let a stale stored value overwrite a recording that started while it was reading', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    install({ stored: { status: 'stopped', tabId: 7, startedAt: 1, stoppedAt: 2 }, getGate: gate });
    const { reconcile, setState, getCurrent } = await load();
    const pending = reconcile();
    await setState(recording);
    open();
    expect((await pending).status).toBe('recording');
    expect(getCurrent().status).toBe('recording');
  });

  it('ignores a dead probe result when the state moved on during the probe', async () => {
    let release!: () => void;
    const slowProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    install({
      stored: recording,
      evaluate: async () => {
        await slowProbe;
        throw new Error('Debugger is not attached to the tab with id: 7.');
      },
    });
    const { reconcile, setState, getCurrent } = await load();
    const pending = reconcile();
    await vi.advanceTimersByTimeAsync(10);
    await setState({ status: 'stopped', tabId: 7, startedAt: 1000, stoppedAt: 1500 });
    release();
    const result = await pending;
    expect(result).toMatchObject({ status: 'stopped', stoppedAt: 1500 });
    expect(getCurrent()).toMatchObject({ status: 'stopped', stoppedAt: 1500 });
  });

  it('reads idle when nothing is stored', async () => {
    install();
    const { reconcile } = await load();
    expect((await reconcile()).status).toBe('idle');
  });
});
