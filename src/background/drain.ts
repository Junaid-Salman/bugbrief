export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Waits until the set is empty or the deadline passes. Tasks added while waiting are awaited too.
 * Returns true when the set drained, false on timeout.
 */
export async function drain(inFlight: Set<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      await withTimeout(Promise.allSettled([...inFlight]), remaining);
    } catch {
      return false;
    }
  }
  return true;
}
