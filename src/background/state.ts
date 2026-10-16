import type { RecordingState } from '../shared/messages';

const STATE_KEY = 'recordingState';

let current: RecordingState = { status: 'idle' };

export function getCurrent(): RecordingState {
  return current;
}

export async function setState(state: RecordingState): Promise<void> {
  current = state;
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function isSessionAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the stored state and verifies it against Chrome. A stored "recording"
 * state without a live debugger session becomes "stopped".
 */
export async function reconcile(): Promise<RecordingState> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const state = (stored[STATE_KEY] as RecordingState | undefined) ?? { status: 'idle' };
  if (state.status === 'recording' && !(await isSessionAlive(state.tabId))) {
    const stopped: RecordingState = {
      status: 'stopped',
      tabId: state.tabId,
      startedAt: state.startedAt,
      stoppedAt: Date.now(),
    };
    await setState(stopped);
    return stopped;
  }
  current = state;
  return state;
}
