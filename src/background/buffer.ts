import {
  KEYS,
  emptyState,
  rehydrateState,
  serialize,
  shrinkOne,
  trimBodies,
  type BufferState,
} from '../core/buffer-model';
import { fitsSoftLimit } from '../core/limits';

export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface BufferOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

const ALL_KEYS = Object.values(KEYS) as string[];

export function createBuffer(storage: SessionStorageLike, options: BufferOptions = {}) {
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 1000;
  const log = options.log ?? (() => undefined);

  let state: BufferState = emptyState();
  let generation = 0;
  let dirty = false;
  let persistenceOk = true;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  function clearTimers(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (maxWaitTimer !== undefined) clearTimeout(maxWaitTimer);
    debounceTimer = undefined;
    maxWaitTimer = undefined;
  }

  function schedule(): void {
    dirty = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void flush();
    }, debounceMs);
    if (maxWaitTimer === undefined) {
      maxWaitTimer = setTimeout(() => {
        void flush();
      }, maxWaitMs);
    }
  }

  /** Builds the payload, degrading step by step until it fits under the soft limit. */
  function buildPayload(): Record<string, unknown> {
    let payload = serialize(state, true);
    if (fitsSoftLimit(JSON.stringify(payload))) return payload;
    trimBodies(state);
    payload = serialize(state, true);
    if (fitsSoftLimit(JSON.stringify(payload))) return payload;
    payload = serialize(state, false);
    while (!fitsSoftLimit(JSON.stringify(payload)) && shrinkOne(state)) {
      payload = serialize(state, false);
    }
    return payload;
  }

  async function writeNow(forGeneration: number): Promise<void> {
    if (forGeneration !== generation || !dirty) return;
    dirty = false;
    try {
      await storage.set(buildPayload());
      persistenceOk = true;
    } catch (firstError) {
      log('write failed, retrying with trimmed bodies', firstError);
      try {
        trimBodies(state);
        await storage.set(serialize(state, false));
        persistenceOk = true;
      } catch (secondError) {
        persistenceOk = false;
        log('write failed again, persistence is off', secondError);
      }
    }
  }

  function flush(): Promise<void> {
    clearTimers();
    const forGeneration = generation;
    chain = chain.then(() => writeNow(forGeneration)).catch(() => undefined);
    return chain;
  }

  return {
    getState: (): BufferState => state,
    generation: (): number => generation,
    isCurrent: (token: number): boolean => token === generation,
    persistenceOk: (): boolean => persistenceOk,

    /** Loads stored state for any recording status. Never rejects: failures reset to empty. */
    async rehydrate(): Promise<BufferState> {
      try {
        state = rehydrateState(await storage.get(ALL_KEYS));
      } catch (error) {
        log('rehydrate failed, starting empty', error);
        state = emptyState();
      }
      persistenceOk = true;
      return state;
    },

    /** Applies a change. Pass persist=false for changes that are never written (unmarked pending records). */
    mutate(change: (current: BufferState) => void, persist = true): void {
      change(state);
      if (persist) schedule();
    },

    flush,

    /** Drops all buffered data and invalidates work that started under the old generation. */
    reset(): Promise<void> {
      generation += 1;
      clearTimers();
      dirty = false;
      state = emptyState();
      persistenceOk = true;
      chain = chain.then(() => storage.remove(ALL_KEYS)).catch(() => undefined);
      return chain;
    },
  };
}

export type Buffer = ReturnType<typeof createBuffer>;
