import type { PickerToWorker, PopupToWorker } from '../shared/messages';
import { handleDetach, handleEvent, handleTabRemoved } from './debugger-session';
import { log } from './log';
import { handleMessage } from './router';

// All listeners register synchronously at top level so a restarted worker receives events.
chrome.runtime.onMessage.addListener((message: PopupToWorker | PickerToWorker, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse);
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
  log.info('installed');
});
