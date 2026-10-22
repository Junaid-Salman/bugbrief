const PREFIX = '[Conscribe]';

/** True only in a debug build (npm run dev or npm run build:debug). Off in the build you ship. */
export function debugEnabled(): boolean {
  return import.meta.env.VITE_CONSCRIBE_DEBUG === 'true';
}

/**
 * info and warn carry ids, reasons, counts and error text only, so they always print.
 * debug may carry captured page data (URLs, bodies, titles), so it prints only in a debug build.
 */
export const log = {
  info: (message: string, detail?: object): void => console.log(`${PREFIX} ${message}`, detail),
  warn: (message: string, detail?: object): void => console.warn(`${PREFIX} ${message}`, detail),
  debug: (message: string, detail?: object): void => {
    if (debugEnabled()) console.log(`${PREFIX} ${message}`, detail);
  },
};
