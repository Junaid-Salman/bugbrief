import type { PopupToWorker, RecordingState, WorkerResponse } from '../shared/messages';
import { buildCapsule, type BuildDeps, type BuildResult } from './capsule-builder';
import { downloadCapsule, type DownloadDeps } from './download';
import { fileStamp } from '../core/capsule';
import { log } from './log';

export const RECORDING_MESSAGE = 'Stop recording first.';
export const STALE_MESSAGE = 'The data changed since the preview. Preview again.';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

type Build = Extract<PopupToWorker, { type: 'BUILD_CAPSULE' }>;
type Download = Extract<PopupToWorker, { type: 'DOWNLOAD_CAPSULE' }>;
type Ok = Extract<WorkerResponse, { ok: true }>;
/** The fields the router adds from its own state, so the flow stays independent of the buffer. */
type Base = Pick<Ok, 'state' | 'hasElement' | 'element' | 'counts' | 'persistenceOk'>;

function failure(error: string): WorkerResponse {
  return { ok: false, error };
}

function guard(state: RecordingState): string | undefined {
  return state.status === 'recording' ? RECORDING_MESSAGE : undefined;
}

function noteOf(message: { userNote?: unknown }): string {
  return typeof message.userNote === 'string' ? message.userNote : '';
}

export function createCapsuleFlow(deps: BuildDeps, downloads: DownloadDeps) {
  return {
    /** BUILD_CAPSULE. The router has already called `reconcile()` and passes the fresh state. */
    build(message: Build, state: RecordingState, base: Base): WorkerResponse {
      const refused = guard(state);
      if (refused) return failure(refused);
      const started = Date.now();
      const result: BuildResult = buildCapsule(deps, { userNote: noteOf(message) });
      if (!result.ok) return failure(result.error);
      log.info('capsule built', { chars: result.markdown.length, masks: result.redactionCount, ms: Date.now() - started });
      return {
        ok: true, ...base,
        markdown: result.markdown, redactionCount: result.redactionCount, capturedAt: result.capturedAt,
        previewHash: result.previewHash, screenshot: result.screenshot,
      };
    },

    /** DOWNLOAD_CAPSULE: same guards, then a rebuild that must match the preview. */
    async download(message: Download, state: RecordingState, base: Base): Promise<WorkerResponse> {
      const refused = guard(state);
      if (refused) return failure(refused);
      if (typeof message.capturedAt !== 'string' || !ISO.test(message.capturedAt) || typeof message.previewHash !== 'string') {
        return failure('Preview first.');
      }
      const result = buildCapsule(deps, { userNote: noteOf(message), capturedAt: message.capturedAt });
      if (!result.ok) return failure(result.error);
      // A re-pick, Clear or a changed note between Preview and Download is detected, not silently saved.
      if (result.previewHash !== message.previewHash) return failure(STALE_MESSAGE);
      if (result.screenshot === 'pending') return failure('The screenshot is still being captured. Try again in a moment.');
      const saved = await downloadCapsule(downloads, {
        markdown: result.markdown, pngDataUrl: result.pngDataUrl, stamp: fileStamp(result.capturedAt),
      });
      if (!saved.ok) return failure(saved.error);
      return {
        ok: true, ...base,
        redactionCount: result.redactionCount, capturedAt: result.capturedAt, previewHash: result.previewHash,
        screenshot: result.screenshot, files: saved.files,
      };
    },
  };
}

export type CapsuleFlow = ReturnType<typeof createCapsuleFlow>;
