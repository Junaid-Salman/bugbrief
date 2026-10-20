// jsdom ships no types and @types/jsdom is not installed. These cover only what the P9 helpers use.
declare module 'jsdom' {
  export class VirtualConsole {
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface JSDOMWindow {
    document: { readyState: string; getElementById(id: string): { outerHTML: string } | null };
    addEventListener(type: string, listener: (event: never) => void): void;
    close(): void;
  }

  export interface FromUrlOptions {
    runScripts?: 'dangerously' | 'outside-only';
    resources?: 'usable';
    pretendToBeVisual?: boolean;
    virtualConsole?: VirtualConsole;
    beforeParse?(window: JSDOMWindow): void;
  }

  export class JSDOM {
    static fromURL(url: string, options?: FromUrlOptions): Promise<JSDOM>;
    window: JSDOMWindow;
  }
}
