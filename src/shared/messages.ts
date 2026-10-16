import type { Capsule, ElementSnapshot } from '../core/types';

export interface EvictedTally {
  entries: number;
  occurrences: number;
}

export interface BufferCounts {
  console: { unique: number; total: number; evicted: EvictedTally };
  network: { unique: number; total: number; evicted: EvictedTally };
}

export type RecordingState =
  | { status: 'idle' }
  | { status: 'recording'; tabId: number; startedAt: number }
  | { status: 'stopped'; tabId: number; startedAt: number; stoppedAt: number };

export type PopupToWorker =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING' }
  | { type: 'START_PICKER'; tabId: number }
  | { type: 'GET_STATE' }
  | { type: 'BUILD_CAPSULE'; userNote: string }
  | { type: 'DOWNLOAD_CAPSULE'; userNote: string }
  | { type: 'CLEAR' };

export type PickerToWorker =
  | {
      type: 'ELEMENT_PICKED';
      element: Omit<ElementSnapshot, 'screenshotDataUrl'>;
      viewport: { width: number; height: number };
      devicePixelRatio: number;
      pageUrl: string;
      pageTitle: string;
    }
  | { type: 'PICKER_CANCELLED' };

export type WorkerResponse =
  | {
      ok: true;
      state: RecordingState;
      capsule?: Capsule;
      markdown?: string;
      hasElement: boolean;
      counts?: BufferCounts;
      persistenceOk?: boolean;
    }
  | { ok: false; error: string };
