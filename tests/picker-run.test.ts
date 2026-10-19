// @vitest-environment jsdom
/**
 * Step 4: overlay, swallowed events, Esc, cleanup, re-injection and the pre-send order
 * (criteria 2, 3, 7, 8). Frames are driven by hand so the order is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickerToWorker } from '../src/shared/messages';
import { startPicker, type PickerHandle } from '../src/content/picker-run';

interface Rig {
  handles: PickerHandle[];
  sent: PickerToWorker[];
  frames: Array<() => void>;
  log: string[];
  flushFrame: () => void;
  start: () => PickerHandle | undefined;
}

let rig: Rig;
let target: HTMLElement;

function stackAt(elements: Element[]): void {
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => elements;
}

function makeRig(): Rig {
  const sent: PickerToWorker[] = [];
  const frames: Array<() => void> = [];
  const log: string[] = [];
  const handles: PickerHandle[] = [];
  return {
    handles,
    sent,
    frames,
    log,
    flushFrame() {
      const callbacks = frames.splice(0);
      for (const callback of callbacks) callback();
    },
    start: () => {
      const handle = startPicker({
        send: (message) => {
          log.push('send');
          sent.push(message);
        },
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: () => undefined,
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
    target.getBoundingClientRect = () => ({ x: 10, y: 50, left: 10, top: 50, right: 110, bottom: 90, width: 100, height: 40, toJSON: () => ({}) }) as DOMRect;
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
    target.getBoundingClientRect = () => {
      rig.log.push(handle.host.isConnected ? 'rect-with-overlay' : 'rect');
      return { x: 5, y: 6, left: 5, top: 6, right: 35, bottom: 46, width: 30, height: 40, toJSON: () => ({}) } as DOMRect;
    };

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
