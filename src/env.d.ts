declare module '*?script' {
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
