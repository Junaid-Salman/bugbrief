import { sanitizePick } from '../core/element-model';
import { isRestrictedAttachError, isRestrictedUrl, OTHER_TAB_MESSAGE, RESTRICTED_MESSAGE } from '../shared/restricted';
import type { ElementSummary, RecordingState } from '../shared/messages';
import { elements, elementsReady } from './element';
import { injectPicker } from './inject-picker';
import { log } from './log';

export const REOPEN_MESSAGE = 'Reopen BugBrief on this tab and try again.';
export const FILE_URL_MESSAGE =
  'BugBrief needs "Allow access to file URLs" turned on for the extension to pick on a file:// page.';
export { OTHER_TAB_MESSAGE };

const NO_ACCESS = /cannot access|must request permission|missing host permission/i;

/** Turns an executeScript failure into the message the popup shows. */
export function mapInjectError(error: unknown, tabUrl: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (tabUrl?.toLowerCase().startsWith('file:') && NO_ACCESS.test(message)) return new Error(FILE_URL_MESSAGE);
  if (isRestrictedAttachError(message)) {
    // A normal page that refuses the script means the activeTab grant is gone, not a restricted page.
    return new Error(tabUrl !== undefined && !isRestrictedUrl(tabUrl) ? REOPEN_MESSAGE : RESTRICTED_MESSAGE);
  }
  if (NO_ACCESS.test(message)) return new Error(REOPEN_MESSAGE);
  return error instanceof Error ? error : new Error(message);
}

/** START_PICKER. While recording, only the recorded tab may be picked (Q2). */
export async function startPickerFlow(tabId: number, recording: RecordingState): Promise<void> {
  if (recording.status === 'recording' && recording.tabId !== tabId) throw new Error(OTHER_TAB_MESSAGE);
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MESSAGE);
  try {
    await injectPicker(tabId);
  } catch (error) {
    throw mapInjectError(error, tab.url);
  }
  log.info('picker started', { tabId });
}

/** Only our own picker, in the top frame of a real tab, may deliver a pick. */
export function pickSenderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  if (sender.id !== chrome.runtime.id) return undefined;
  if (sender.tab?.id === undefined) return undefined;
  if ((sender.frameId ?? 0) !== 0) return undefined;
  return sender.tab.id;
}

/**
 * ELEMENT_PICKED. Returns true when a snapshot was stored. While recording, only the recorded tab
 * may deliver a pick (Q2): the rule is also checked here, not only at START_PICKER, because the
 * recording can start on another tab while the overlay is still up.
 */
export async function receivePick(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  recording: RecordingState,
): Promise<boolean> {
  await elementsReady;
  const tabId = pickSenderTabId(sender);
  if (tabId === undefined) {
    log.warn('pick rejected', { reason: 'sender' });
    return false;
  }
  if (recording.status === 'recording' && recording.tabId !== tabId) {
    log.warn('pick rejected', { reason: 'tab', tabId, recordingTabId: recording.tabId });
    return false;
  }
  const picked = sanitizePick(message);
  if (!picked) {
    log.warn('pick rejected', { reason: 'payload', tabId });
    return false;
  }
  await elements.set(tabId, picked);
  log.info('element picked', { tabId, truncated: picked.snapshot.outerHTMLTruncated === true });
  log.debug('picked element', { selector: picked.snapshot.selector, url: picked.page.url, title: picked.page.title });
  return true;
}

export async function elementFields(): Promise<{ hasElement: boolean; element?: ElementSummary }> {
  await elementsReady;
  const element = elements.summary();
  return element ? { hasElement: true, element } : { hasElement: false };
}
