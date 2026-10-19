import type { PickerToWorker, PopupToWorker, WorkerResponse } from '../shared/messages';
import {
  clearBuffers,
  getCounts,
  ready,
  startRecording,
  stopRecording,
} from './debugger-session';
import { elements, elementsReady } from './element';
import { elementFields, receivePick, startPickerFlow } from './picker-flow';
import { reconcile } from './state';

export async function handleMessage(
  message: PopupToWorker | PickerToWorker,
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
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
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      case 'PICKER_CANCELLED': {
        await ready;
        const state = await reconcile();
        return { ok: true, state, ...(await elementFields()), ...(await getCounts()) };
      }
      default:
        return { ok: false, error: 'Not implemented yet.' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

