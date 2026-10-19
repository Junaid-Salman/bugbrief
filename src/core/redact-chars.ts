/** Character predicates shared by the redaction scanners. One copy, so they cannot drift apart. */

/** Space, tab, LF, CR. */
export function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** HTML whitespace also includes the form feed. */
export function isHtmlSpace(code: number): boolean {
  return isSpace(code) || code === 12;
}

/** Space or tab: the gap allowed around `=` and `:` without crossing a line. */
export function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/** A character that can appear in a key: `[A-Za-z0-9_.\-[\]]`. */
export function isKeyChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 || code === 46 || code === 45 || code === 91 || code === 93
  );
}

/** A key character that can also be part of a file name (no brackets). */
export function isFileNameChar(code: number): boolean {
  return isKeyChar(code) && code !== 91 && code !== 93;
}
