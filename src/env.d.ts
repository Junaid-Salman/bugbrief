// `?iife` builds one self-contained classic script, so executeScript runs it fresh each time.
// `?script` would build an ES module behind an async loader whose body runs once per page.
declare module '*?iife' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  /** "true" in a debug build. Enables logs that may contain captured page data. */
  readonly VITE_BUGBRIEF_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
