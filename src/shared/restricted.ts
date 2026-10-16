const RESTRICTED_SCHEMES = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|view-source):/i;
const RESTRICTED_STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;

export const RESTRICTED_MESSAGE = "BugBrief can't record this page.";

const RESTRICTED_ERRORS =
  /cannot access (a |contents of )?(url )?"?(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source)[: ]|cannot attach to this target|cannot access contents of the page|extensions gallery cannot be scripted/i;

export function isRestrictedAttachError(message: string): boolean {
  return RESTRICTED_ERRORS.test(message);
}

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return RESTRICTED_SCHEMES.test(url) || RESTRICTED_STORE.test(url);
}
