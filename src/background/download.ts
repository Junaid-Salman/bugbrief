import { log } from './log';
import { safeMessage } from './screenshot';

/** Chrome refuses URLs over about 2 MB. The P6 PNG budget (1.5 million characters) fits. */
export const MAX_DOWNLOAD_URL = 2_000_000;

export interface DownloadOptions {
  url: string;
  filename: string;
  saveAs: false;
  conflictAction: 'uniquify';
}

export interface DownloadDeps {
  download(options: DownloadOptions): Promise<unknown>;
}

export type DownloadResult = { ok: true; files: string[] } | { ok: false; error: string };

export const markdownName = (stamp: string): string => `bugbrief/capsule-${stamp}.md`;
export const pngName = (stamp: string): string => `bugbrief/capsule-${stamp}.png`;
export const markdownDataUrl = (markdown: string): string => `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;

/**
 * Saves the Markdown and, when there is an image, the PNG, with the same stamp (D4). Both URLs are
 * checked before anything is saved. `downloads.download` resolves when a download STARTS, so only
 * start errors are reported (the popup says "Download started", not "Saved").
 */
export async function downloadCapsule(
  deps: DownloadDeps,
  input: { markdown: string; pngDataUrl: string; stamp: string },
): Promise<DownloadResult> {
  const mdUrl = markdownDataUrl(input.markdown);
  if (mdUrl.length > MAX_DOWNLOAD_URL) return { ok: false, error: 'The capsule is too large to download as one file.' };
  if (input.pngDataUrl.length > MAX_DOWNLOAD_URL) return { ok: false, error: 'The screenshot is too large to download.' };

  const files: string[] = [];
  try {
    await deps.download({ url: mdUrl, filename: markdownName(input.stamp), saveAs: false, conflictAction: 'uniquify' });
    files.push(markdownName(input.stamp));
  } catch (error) {
    log.warn('capsule download failed', { file: 'md', error: safeMessage(error) });
    return { ok: false, error: 'The Markdown file could not be saved.' };
  }
  if (input.pngDataUrl !== '') {
    try {
      await deps.download({ url: input.pngDataUrl, filename: pngName(input.stamp), saveAs: false, conflictAction: 'uniquify' });
      files.push(pngName(input.stamp));
    } catch (error) {
      log.warn('capsule download failed', { file: 'png', error: safeMessage(error) });
      return { ok: false, error: 'The Markdown file was saved, but the screenshot could not be.' };
    }
  }
  log.info('capsule download started', { files: files.length });
  return { ok: true, files };
}

export function chromeDownloadDeps(): DownloadDeps {
  return { download: (options) => chrome.downloads.download(options) };
}
