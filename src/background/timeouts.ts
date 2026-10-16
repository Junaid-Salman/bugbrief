/** Time limits for every call that can block on a frozen or closing tab. */
export const PROBE_TIMEOUT_MS = 1000;
export const METADATA_TIMEOUT_MS = 1000;
export const DETACH_TIMEOUT_MS = 1000;
export const DRAIN_TIMEOUT_MS = 2000;
export const FETCH_TIMEOUT_MS = 3000;
/** Cap on the whole pre-flush phase of Stop (drain, metadata, detach), so the flush always runs. */
export const FINISH_BUDGET_MS = 4500;
