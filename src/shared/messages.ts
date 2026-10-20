import type { ScreenshotReason, ScreenshotStatus } from '../core/screenshot-model';
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
  /** `capturedAt` and `previewHash` come from the Preview, so the files match the text that was copied. */
  | { type: 'DOWNLOAD_CAPSULE'; userNote: string; capturedAt: string; previewHash: string }
  | { type: 'CLEAR' };

export type PickerToWorker =
  | {
      type: 'ELEMENT_PICKED';
      element: Omit<ElementSnapshot, 'screenshotDataUrl'>;
      viewport: { width: number; height: number };
      devicePixelRatio: number;
      /** documentElement.clientWidth/clientHeight: the viewport without classic scrollbars (P6). */
      clientWidth?: number;
      clientHeight?: number;
      pageUrl: string;
      pageTitle: string;
    }
  | { type: 'PICKER_CANCELLED' };

/** What the popup shows about the picked element. The selector is already redacted for display. */
export interface ElementSummary {
  selector: string;
  tabId: number;
  pageUrl: string;
  pickedAt: number;
  screenshot: ScreenshotStatus;
  /** Set when `screenshot` is 'unavailable'. */
  reason?: ScreenshotReason;
}

/** Why a capsule request failed, for the popup to act on without reading the message text (BL-012). */
export type FailureCode = 'preview-required' | 'stale-preview';

export type WorkerResponse =
  | {
      ok: true;
      state: RecordingState;
      capsule?: Capsule;
      markdown?: string;
      hasElement: boolean;
      element?: ElementSummary;
      /** Preview: the masks applied before the caps, when the capsule was built, and its hash. */
      redactionCount?: number;
      capturedAt?: string;
      previewHash?: string;
      /** What the capsule says about the screenshot. 'captured' and 'clipped' mean a PNG goes with Download. */
      screenshot?: 'none' | 'pending' | 'captured' | 'clipped' | 'unavailable';
      /** Download: the files that were started. */
      files?: string[];
      counts?: BufferCounts;
      persistenceOk?: boolean;
    }
  | { ok: false; error: string; code?: FailureCode };
