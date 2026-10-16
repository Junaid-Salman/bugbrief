import type { PopupToWorker, WorkerResponse } from '../shared/messages';
import {
  clearBuffers,
  getCounts,
  handleDetach,
  handleEvent,
  handleTabRemoved,
  ready,
  startRecording,
  stopRecording,
} from './debugger-session';
import { reconcile } from './state';

async function handleMessage(message: PopupToWorker): Promise<WorkerResponse> {
  try {
    switch (message.type) {
      case 'START_RECORDING': {
        const state = await startRecording(message.tabId);
        return { ok: true, state, hasElement: false, ...(await getCounts()) };
      }
      case 'STOP_RECORDING': {
        const state = await stopRecording();
        return { ok: true, state, hasElement: false, ...(await getCounts()) };
      }
      case 'GET_STATE': {
        await ready;
        const state = await reconcile();
        return { ok: true, state, hasElement: false, ...(await getCounts()) };
      }
      case 'CLEAR': {
        const state = await clearBuffers();
        return { ok: true, state, hasElement: false, ...(await getCounts()) };
      }
      default:
        return { ok: false, error: 'Not implemented yet.' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// All listeners register synchronously at top level so a restarted worker receives events.
chrome.runtime.onMessage.addListener((message: PopupToWorker, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse);
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  void handleEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void handleDetach(source, reason);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BugBrief] installed');
});
