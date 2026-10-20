import type { PickerToWorker, PopupToWorker, WorkerResponse } from '../shared/messages';
import {
  clearBuffers,
  getCounts,
  ready,
  startRecording,
  stopRecording,
} from './debugger-session';
import { elements, elementsReady } from './element';
import { elementFields, isExtensionPage, pickSenderTabId, receivePick, startPickerFlow } from './picker-flow';
import { captureForPick, sharedCapturer } from './screenshot';
import { reconcile } from './state';
import { chromeDownloadDeps } from './download';
import { createCapsuleFlow } from './capsule-flow';
import { getBufferState } from './debugger-session';

/** The real reads for the capsule builder. Created on first use, so importing this file touches no API. */
function realFlow() {
  return createCapsuleFlow(
    {
      readBuffer: () => {
        const buffer = getBufferState();
        return { console: buffer.console, network: buffer.network, pageUrl: buffer.pageUrl, page: buffer.page, evicted: buffer.evicted };
      },
      readElement: () => {
        const stored = elements.get();
        const snapshot = elements.snapshot();
        return stored && snapshot
          ? { snapshot, tabId: stored.tabId, pickedAt: stored.pickedAt, page: stored.page, screenshot: stored.screenshot }
          : undefined;
      },
      userAgent: () => navigator.userAgent,
      now: () => new Date(),
    },
    chromeDownloadDeps(),
  );
}

/** The messages that only the extension's own popup may send. */
const POPUP_ONLY = new Set<string>([
  'START_RECORDING', 'STOP_RECORDING', 'GET_STATE', 'CLEAR', 'START_PICKER', 'BUILD_CAPSULE', 'DOWNLOAD_CAPSULE',
]);

export async function handleMessage(
  message: PopupToWorker | PickerToWorker,
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
  // Only our own popup may send these, and only our own picker (a real tab, the top frame) may cancel a pick (BL-030).
  const refused = { ok: false, error: 'Not allowed.' } as const;
  if (POPUP_ONLY.has(message.type) && !isExtensionPage(sender)) return refused;
  if (message.type === 'PICKER_CANCELLED' && pickSenderTabId(sender) === undefined) return refused;
  try {
    switch (message.type) {
      case 'START_RECORDING': {
        const state = await startRecording(message.tabId);
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'STOP_RECORDING': {
        const state = await stopRecording();
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'GET_STATE': {
        await ready;
        const state = await reconcile();
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'CLEAR': {
        const state = await clearBuffers();
        await elementsReady;
        await elements.clear();
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'START_PICKER': {
        await ready;
        const state = await reconcile();
        await startPickerFlow(message.tabId, state);
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'ELEMENT_PICKED': {
        await ready;
        const state = await reconcile();
        if (!(await receivePick(message, sender, state))) return { ok: false, error: 'Pick ignored.' };
        // The pick is already stored. A capture problem is recorded as a reason, never an error here.
        await captureForPick(sharedCapturer(), elements).catch(() => undefined);
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'PICKER_CANCELLED': {
        await ready;
        const state = await reconcile();
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'BUILD_CAPSULE':
      case 'DOWNLOAD_CAPSULE': {
        await ready;
        const state = await reconcile();
        await elementsReady;
        const base = { state, ...(await elementFields()), ...(await getCounts()) };
        const flow = realFlow();
        return message.type === 'BUILD_CAPSULE' ? flow.build(message, state, base) : flow.download(message, state, base);
      }
      default:
        return { ok: false, error: 'Not implemented yet.' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

