import { FIELD } from '../core/limits';

export const NOTE_KEY = 'noteDraft';

export interface DraftStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const cap = (text: string): string => (text.length > FIELD.userNote ? text.slice(0, FIELD.userNote) : text);

export async function loadDraft(storage: DraftStorage): Promise<string> {
  try {
    const value = (await storage.get(NOTE_KEY))[NOTE_KEY];
    return typeof value === 'string' ? cap(value) : '';
  } catch {
    return '';
  }
}

/**
 * Saves the note on every input (spec §4.3, Q16), and again on `pagehide`: the popup closes the
 * moment the user clicks into the page, and the note is at most 2 000 characters, so no debounce.
 */
export function createDraftWriter(storage: DraftStorage) {
  // undefined means nothing was loaded or typed, so a flush must not touch the saved draft.
  let latest: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  const write = (): Promise<void> => {
    if (latest === undefined) return pending;
    pending = storage.set({ [NOTE_KEY]: latest }).catch(() => undefined);
    return pending;
  };
  return {
    update(text: string): Promise<void> {
      latest = cap(text);
      return write();
    },
    /** Records the draft that was loaded, unless the user already typed before the load finished. */
    seed(text: string): void {
      if (latest === undefined) latest = cap(text);
    },
    /** Writes the latest value now. Safe to call from `pagehide`. */
    flush: (): Promise<void> => write(),
    async clear(): Promise<void> {
      latest = undefined;
      pending = storage.remove(NOTE_KEY).catch(() => undefined);
      await pending;
    },
  };
}
