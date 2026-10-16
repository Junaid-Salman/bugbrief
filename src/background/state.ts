import type { RecordingState } from '../shared/messages';
import { TimeoutError, withTimeout } from './drain';
import { PROBE_TIMEOUT_MS } from './timeouts';

const STATE_KEY = 'recordingState';

/** Messages that mean our debugger session is gone. Anything else is treated as a transient error. */
const DEAD_SESSION_ERROR = /not attached|detached|no (tab|target) with given id/i;

let current: RecordingState = { status: 'idle' };
// Bumped by every setState, so a slower reader can tell its result is stale.
let version = 0;

export function getCurrent(): RecordingState {
  return current;
}

export async function setState(state: RecordingState): Promise<void> {
  version += 1;
  current = state;
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

export type Liveness = 'alive' | 'dead';

/**
 * Decides whether our debugger session on a tab still exists. Every step is time-limited, and
 * only clear "not attached" evidence counts as dead: a frozen tab or a transient error during a
 * navigation must not flip a live recording to stopped.
 */
export async function probeSession(tabId: number): Promise<Liveness> {
  try {
    const targets = await withTimeout(chrome.debugger.getTargets(), PROBE_TIMEOUT_MS);
    const target = targets.find((item) => item.tabId === tabId);
    if (!target || !target.attached) return 'dead';
  } catch {
    // getTargets is only a shortcut. Fall through to the probe.
  }
  try {
    await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }), PROBE_TIMEOUT_MS);
    return 'alive';
  } catch (error) {
    if (error instanceof TimeoutError) return 'alive';
    const message = error instanceof Error ? error.message : String(error);
    return DEAD_SESSION_ERROR.test(message) ? 'dead' : 'alive';
  }
}

/**
 * Loads the stored state and verifies it against Chrome. A stored "recording" state whose
 * debugger session is gone becomes "stopped". If anything calls setState while this runs, the
 * newer in-memory state wins and is returned instead.
 */
export async function reconcile(): Promise<RecordingState> {
  const started = version;
  const stored = await chrome.storage.session.get(STATE_KEY);
  const state = (stored[STATE_KEY] as RecordingState | undefined) ?? { status: 'idle' };
  if (version !== started) return current;

  if (state.status === 'recording') {
    const liveness = await probeSession(state.tabId);
    if (version !== started) return current;
    if (liveness === 'dead') {
      const stopped: RecordingState = {
        status: 'stopped',
        tabId: state.tabId,
        startedAt: state.startedAt,
        stoppedAt: Date.now(),
      };
      await setState(stopped);
      return stopped;
    }
  }
  current = state;
  return state;
}
