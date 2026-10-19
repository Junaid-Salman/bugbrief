// @vitest-environment jsdom
/**
 * Step 4: overlay, swallowed events, Esc, cleanup, re-injection and the pre-send order
 * (criteria 2, 3, 7, 8). Frames are driven by hand so the order is deterministic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickerToWorker } from '../src/shared/messages';
import { startPicker, type PickerHandle } from '../src/content/picker-run';

interface Rig {
  timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }>;
  fireTimers: () => void;
  start: (overrides?: Partial<Parameters<typeof startPicker>[0]>) => PickerHandle | undefined;
  handles: PickerHandle[];
  sent: PickerToWorker[];
  frames: Array<() => void>;
  log: string[];
  flushFrame: () => void;
}

let rig: Rig;
let target: HTMLElement;

// jsdom has a real `Element.prototype.getBoundingClientRect` (all zeros), and the picker reads it
// through the prototype (dom-safe), so tests stub the prototype and key the answer by element.
const rects = new WeakMap<Element, () => DOMRect>();
const realRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const stub = rects.get(this);
    return stub ? stub() : realRect.call(this);
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect;
});

function stackAt(elements: Element[]): void {
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => elements;
}

function makeRig(): Rig {
  const sent: PickerToWorker[] = [];
  const frames: Array<() => void> = [];
  const log: string[] = [];
  const handles: PickerHandle[] = [];
  const timers: Rig['timers'] = [];
  return {
    timers,
    fireTimers() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    },
    handles,
    sent,
    frames,
    log,
    flushFrame() {
      const callbacks = frames.splice(0);
      for (const callback of callbacks) callback();
    },
    start: (overrides = {}) => {
      const handle = startPicker({
        requireTrusted: false,
        setTimeout: (fn, ms) => {
          const id = timers.length + 1;
          timers.push({ id, fn, ms, cleared: false });
          return id;
        },
        clearTimeout: (id) => {
          const timer = timers.find((t) => t.id === id);
          if (timer) timer.cleared = true;
        },
        send: (message) => {
          log.push('send');
          sent.push(message);
        },
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: () => undefined,
        ...overrides,
      });
      if (handle) handles.push(handle);
      return handle;
    },
  };
}

function overlayCount(): number {
  return document.documentElement.children.length;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    rig.flushFrame();
    await Promise.resolve();
  }
}

beforeEach(() => {
  document.body.innerHTML = '<a id="link" href="https://example.com/away">go</a><button id="b" class="btn">Buy</button>';
  target = document.getElementById('b') as HTMLElement;
  rig = makeRig();
});

afterEach(() => {
  // A picker left active would keep its window listeners and swallow events in the next test.
  for (const handle of rig.handles) handle.cancel();
  (window as unknown as { __bugbriefPicker?: boolean }).__bugbriefPicker = false;
  vi.restoreAllMocks();
});

describe('lifecycle (criterion 2)', () => {
  it('adds one overlay and ignores a second start', () => {
    const before = overlayCount();
    const first = rig.start();
    expect(first).toBeDefined();
    expect(overlayCount()).toBe(before + 1);
    expect(rig.start()).toBeUndefined();
    expect(overlayCount()).toBe(before + 1);
  });

  it('leaves no overlay and no flag after Esc, and a new start works', () => {
    const before = overlayCount();
    const handle = rig.start() as PickerHandle;
    handle.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(overlayCount()).toBe(before);
    expect((window as unknown as { __bugbriefPicker?: boolean }).__bugbriefPicker).toBe(false);
    expect(rig.start()).toBeDefined();
    expect(overlayCount()).toBe(before + 1);
  });

  it('cleans up on pagehide without sending anything', () => {
    const before = overlayCount();
    rig.start();
    window.dispatchEvent(new Event('pagehide'));
    expect(overlayCount()).toBe(before);
    expect(rig.sent).toEqual([]);
  });

  it('does nothing after cleanup: a later move or key press is ignored', () => {
    const handle = rig.start() as PickerHandle;
    handle.cancel();
    rig.sent.length = 0;
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    rig.flushFrame();
    expect(rig.sent).toEqual([]);
  });
});

describe('Esc (criterion 8)', () => {
  it('sends PICKER_CANCELLED once', () => {
    const handle = rig.start() as PickerHandle;
    handle.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    handle.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(rig.sent).toEqual([{ type: 'PICKER_CANCELLED' }]);
  });

  it('ignores other keys', () => {
    const handle = rig.start() as PickerHandle;
    handle.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(rig.sent).toEqual([]);
  });

  it('takes focus so Esc works without a prior click', () => {
    const handle = rig.start() as PickerHandle;
    expect(document.activeElement).toBe(handle.host);
  });
});

describe('page events are swallowed (criterion 3)', () => {
  it.each(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'auxclick'])(
    'stops %s before page handlers',
    (type) => {
      const handle = rig.start() as PickerHandle;
      stackAt([handle.host]);
      const pageHandler = vi.fn();
      document.addEventListener(type, pageHandler);
      document.body.addEventListener(type, pageHandler);
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 3, clientY: 3 });
      handle.host.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(pageHandler).not.toHaveBeenCalled();
      document.removeEventListener(type, pageHandler);
    },
  );

  it('does not follow a link or send anything for a swallowed click on empty space', () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host]);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 3, clientY: 3 });
    handle.host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(rig.sent).toEqual([]);
    expect(overlayCount()).toBeGreaterThan(0); // still active
  });
});

describe('hover highlight (criterion 4)', () => {
  it('draws the box and label for the element under the pointer, throttled to a frame', () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    rects.set(target, () => ({ x: 10, y: 50, left: 10, top: 50, right: 110, bottom: 90, width: 100, height: 40, toJSON: () => ({}) }) as DOMRect);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 60 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 21, clientY: 61 }));
    expect(rig.frames).toHaveLength(1);
    rig.flushFrame();
    expect(handle.box.style.display).toBe('block');
    expect(handle.box.style.left).toBe('10px');
    expect(handle.box.style.width).toBe('100px');
    expect(handle.label.textContent).toBe('button#b.btn  100×40');
  });

  it('hides the box when only the overlay is under the pointer', () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host]);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1 }));
    rig.flushFrame();
    expect(handle.box.style.display).toBe('none');
  });

  it('styles through the CSSOM only: no <style> element and no style attribute text from HTML', () => {
    const handle = rig.start() as PickerHandle;
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(handle.host.style.position).toBe('fixed');
    expect(handle.hint.textContent).toBe('Click an element. Esc cancels.');
  });
});

describe('pick sequence (criterion 7)', () => {
  it('scrolls, removes the overlay, re-reads the rect, waits two frames, then sends', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    const scroll = vi.fn(() => rig.log.push('scroll'));
    (target as unknown as { scrollIntoView: typeof scroll }).scrollIntoView = scroll;
    rects.set(target, () => {
      rig.log.push(handle.host.isConnected ? 'rect-with-overlay' : 'rect');
      return { x: 5, y: 6, left: 5, top: 6, right: 35, bottom: 46, width: 30, height: 40, toJSON: () => ({}) } as DOMRect;
    });

    handle.host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 }));
    // The first frame request happens after the rect is re-read.
    expect(rig.log).toEqual(['scroll', 'rect']);
    expect(rig.sent).toEqual([]);
    expect(rig.frames).toHaveLength(1);
    rig.flushFrame();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.sent).toEqual([]); // one frame is not enough
    await settle();
    expect(rig.log).toEqual(['scroll', 'rect', 'send']);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'instant' });
    expect(rig.sent).toHaveLength(1);
    const message = rig.sent[0] as Extract<PickerToWorker, { type: 'ELEMENT_PICKED' }>;
    expect(message.type).toBe('ELEMENT_PICKED');
    expect(message.element.selector).toBe('#b');
    expect(message.element.rect).toEqual({ x: 5, y: 6, width: 30, height: 40 });
    expect(Object.keys(message.element.styles)).toHaveLength(15);
    expect(overlayCount()).toBe(document.documentElement.children.length);
  });

  it('allows a new pick right after the overlay is gone', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
    handle.host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 }));
    await settle();
    expect(rig.sent).toHaveLength(1);
    expect(rig.start()).toBeDefined();
  });
});

function clickAt(handle: PickerHandle): void {
  handle.host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 }));
}

function stubScroll(): void {
  (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
}

describe('a failure never traps the user (criterion 18)', () => {
  it('removes the overlay and cancels when describing the element throws', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    // Reads go through the prototype, so make the prototype getter throw for this element.
    const real = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML') as PropertyDescriptor;
    Object.defineProperty(Element.prototype, 'outerHTML', {
      get() {
        if (this === target) throw new Error('boom');
        return (real.get as () => string).call(this);
      },
      configurable: true,
    });
    try {
      clickAt(handle);
      await settle();
      expect(rig.sent).toEqual([{ type: 'PICKER_CANCELLED' }]);
      expect(handle.host.isConnected).toBe(false);
      expect(rig.start()).toBeDefined(); // the next pick works
    } finally {
      Object.defineProperty(Element.prototype, 'outerHTML', real);
    }
  });

  it('cancels when the rect read throws after the overlay is gone', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    rects.set(target, () => {
      throw new Error('no layout');
    });
    clickAt(handle);
    await settle();
    expect(rig.sent).toEqual([{ type: 'PICKER_CANCELLED' }]);
    expect(handle.host.isConnected).toBe(false);
  });

  it('survives a send that throws', async () => {
    const handle = rig.start({
      send: () => {
        throw new Error('port');
      },
    }) as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    clickAt(handle);
    await settle();
    expect(handle.host.isConnected).toBe(false);
  });

  it('a throw while highlighting hides the box and the next frame still runs', () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    rects.set(target, () => {
      throw new Error('bad node');
    });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1 }));
    expect(() => rig.flushFrame()).not.toThrow();
    expect(handle.box.style.display).toBe('none');
    rects.set(target, () => ({ x: 1, y: 2, left: 1, top: 2, right: 11, bottom: 12, width: 10, height: 10, toJSON: () => ({}) }) as DOMRect);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2, clientY: 2 }));
    rig.flushFrame();
    expect(handle.box.style.display).toBe('block');
  });
});

describe('the pick is not lost (criterion 19, Q5)', () => {
  it('sends at once, without frames, when the tab is hidden', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    const state = vi.spyOn(Document.prototype, 'visibilityState', 'get').mockReturnValue('hidden');
    clickAt(handle);
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]?.type).toBe('ELEMENT_PICKED');
    expect(rig.frames).toHaveLength(0);
    state.mockRestore();
  });

  it('sends after the timeout when frames never fire', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    clickAt(handle);
    await Promise.resolve();
    expect(rig.sent).toEqual([]);
    expect(rig.timers.map((t) => t.ms)).toEqual([300]);
    rig.fireTimers();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.sent).toHaveLength(1);
  });

  it('normal frames win, send once, and clear the timeout', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    clickAt(handle);
    await settle();
    expect(rig.sent).toHaveLength(1);
    expect(rig.timers[0]?.cleared).toBe(true);
    rig.fireTimers();
    await settle();
    expect(rig.sent).toHaveLength(1); // the cleared timer does nothing
  });

  it('a pagehide during the wait sends what it has', async () => {
    const handle = rig.start() as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    clickAt(handle);
    await Promise.resolve();
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.sent).toHaveLength(1);
  });
});

describe('page script cannot drive or strand the picker (criterion 23, Q6)', () => {
  it('ignores a synthetic click and Escape by default, but still swallows the click', async () => {
    const handle = rig.start({ requireTrusted: true }) as PickerHandle;
    stackAt([handle.host, target]);
    stubScroll();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 });
    handle.host.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    handle.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(rig.sent).toEqual([]);
    expect(handle.host.isConnected).toBe(true);
  });

  it('recovers when page script removes the overlay: the next start works and the old one is cleaned up', () => {
    const first = rig.start() as PickerHandle;
    first.host.remove();
    const second = rig.start();
    expect(second).toBeDefined();
    expect(second?.host.isConnected).toBe(true);
    // The stale picker's listeners are gone: Escape reaches only the new one.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(rig.sent).toEqual([{ type: 'PICKER_CANCELLED' }]);
  });
});
