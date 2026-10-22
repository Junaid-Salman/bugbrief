import type { PickerToWorker } from '../shared/messages';
import { createElementOf, documentElementOf, rectOf, scrollIntoViewOf, visibilityStateOf } from './dom-safe';
import { buildPayload, describeElement, describeTarget, resolveTarget } from './picker-dom';

const FLAG = '__conscribePicker';
const HINT = 'Click an element. Esc cancels.';
const ACCENT = '#1a73e8';
const TOP_Z_INDEX = '2147483647';
// After the click the picker waits for two animation frames so the page repaints without the
// overlay, but never longer than this: frames do not fire in a hidden tab.
const FRAME_WAIT_MS = 300;
// Page handlers must not run while picking: a click on a link must not navigate.
const SWALLOWED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'auxclick'] as const;

/** What a running picker leaves on the window, so a later injection can recover from a stale one. */
interface PickerSession {
  host: HTMLElement;
  cleanup: () => void;
}

interface PickerWindow extends Window {
  [FLAG]?: PickerSession | false;
}

export interface PickerDeps {
  win: Window;
  send: (message: PickerToWorker) => void;
  /** Schedules `callback` on the next animation frame. */
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** Ignore clicks and keys that page script dispatched (`isTrusted` false). On by default. */
  requireTrusted: boolean;
}

export interface PickerHandle {
  host: HTMLElement;
  box: HTMLElement;
  label: HTMLElement;
  hint: HTMLElement;
  cancel: () => void;
}

function defaultSend(message: PickerToWorker): void {
  try {
    // The worker does not answer a pick, so a closed-port rejection is expected and ignored.
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension was reloaded or removed: nothing to send to.
  }
}

/** Styles go through the CSSOM only. A page CSP blocks `<style>` elements and style attributes. */
function style(el: HTMLElement, rules: Record<string, string>): void {
  for (const [name, value] of Object.entries(rules)) el.style.setProperty(name, value, 'important');
}

/** Starts one pick. A second start while one is active does nothing. */
export function startPicker(overrides: Partial<PickerDeps> = {}): PickerHandle | undefined {
  const win = overrides.win ?? window;
  const deps: PickerDeps = {
    win,
    send: overrides.send ?? defaultSend,
    requestFrame: overrides.requestFrame ?? ((callback) => win.requestAnimationFrame(() => callback())),
    cancelFrame: overrides.cancelFrame ?? ((handle) => win.cancelAnimationFrame(handle)),
    setTimeout: overrides.setTimeout ?? ((callback, ms) => win.setTimeout(callback, ms)),
    clearTimeout: overrides.clearTimeout ?? ((handle) => win.clearTimeout(handle)),
    requireTrusted: overrides.requireTrusted ?? true,
  };
  const guard = win as PickerWindow;
  const existing = guard[FLAG];
  if (existing) {
    // Page script can remove the overlay. A picker whose host is gone is stale: clean it up and start fresh.
    if (existing.host.isConnected) return undefined;
    existing.cleanup();
  }

  const doc = win.document;
  const host = createElementOf(doc, 'div');
  style(host, {
    all: 'initial',
    position: 'fixed',
    top: '0px',
    left: '0px',
    width: '100vw',
    height: '100vh',
    'z-index': TOP_Z_INDEX,
    cursor: 'crosshair',
    display: 'block',
    'pointer-events': 'auto',
  });
  host.tabIndex = -1;
  const root = host.attachShadow({ mode: 'closed' });

  const box = createElementOf(doc, 'div');
  style(box, {
    position: 'fixed',
    display: 'none',
    'box-sizing': 'border-box',
    border: `2px solid ${ACCENT}`,
    background: 'rgba(26, 115, 232, 0.15)',
    'pointer-events': 'none',
  });
  const label = createElementOf(doc, 'div');
  style(label, {
    position: 'fixed',
    display: 'none',
    padding: '2px 6px',
    background: ACCENT,
    color: '#fff',
    font: '12px monospace',
    'border-radius': '3px',
    'white-space': 'nowrap',
    'pointer-events': 'none',
  });
  const hint = createElementOf(doc, 'div');
  hint.textContent = HINT;
  style(hint, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 12px',
    background: '#202124',
    color: '#fff',
    font: '13px system-ui, sans-serif',
    'border-radius': '6px',
    'pointer-events': 'none',
  });
  root.append(box, label, hint);
  documentElementOf(doc).appendChild(host);
  host.focus({ preventScroll: true });

  let point: { x: number; y: number } | undefined;
  let frame: number | undefined;
  let done = false;

  function hideHighlight(): void {
    box.style.setProperty('display', 'none', 'important');
    label.style.setProperty('display', 'none', 'important');
  }

  function refresh(): void {
    frame = undefined;
    if (done || !point) return;
    try {
      highlight(point);
    } catch {
      // One bad frame (an odd page node) must not stop the next one.
      hideHighlight();
    }
  }

  function highlight(at: { x: number; y: number }): void {
    const target = resolveTarget(doc, at.x, at.y, host);
    if (!target) {
      hideHighlight();
      return;
    }
    const rect = rectOf(target);
    style(box, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    style(label, {
      display: 'block',
      left: `${Math.max(0, rect.left)}px`,
      top: `${rect.top > 22 ? rect.top - 22 : rect.bottom + 2}px`,
    });
    label.textContent = describeTarget(target, rect);
  }

  function schedule(): void {
    if (frame === undefined) frame = deps.requestFrame(refresh);
  }

  function onMove(event: Event): void {
    const { clientX, clientY } = event as MouseEvent;
    point = { x: clientX, y: clientY };
    schedule();
  }

  function onSwallow(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type === 'click' && (event.isTrusted || !deps.requireTrusted)) {
      void pick(event as MouseEvent).catch(() => abandon());
    }
  }

  function onKey(event: Event): void {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    if (deps.requireTrusted && !event.isTrusted) return; // page script cannot cancel the pick
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function cleanup(): void {
    if (done) return;
    done = true;
    if (frame !== undefined) deps.cancelFrame(frame);
    win.removeEventListener('pointermove', onMove, true);
    win.removeEventListener('mousemove', onMove, true);
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('scroll', schedule, true);
    win.removeEventListener('resize', schedule, true);
    win.removeEventListener('pagehide', cleanup, true);
    for (const type of SWALLOWED) win.removeEventListener(type, onSwallow, true);
    host.remove();
    guard[FLAG] = false;
  }

  /** Something went wrong after the click: leave nothing behind and tell the worker. */
  function abandon(): void {
    cleanup();
    try {
      deps.send({ type: 'PICKER_CANCELLED' });
    } catch {
      // Nothing more to do.
    }
  }

  function cancel(): void {
    if (done) return;
    cleanup();
    deps.send({ type: 'PICKER_CANCELLED' });
  }

  /** Two animation frames, at most FRAME_WAIT_MS, and none at all in a hidden tab or on pagehide. */
  function settleFrames(): Promise<void> {
    if (visibilityStateOf(doc) === 'hidden') return Promise.resolve();
    return new Promise((resolve) => {
      let timer: number | undefined;
      const finish = (): void => {
        if (timer !== undefined) deps.clearTimeout(timer);
        win.removeEventListener('pagehide', finish, true);
        resolve();
      };
      timer = deps.setTimeout(finish, FRAME_WAIT_MS);
      win.addEventListener('pagehide', finish, true);
      deps.requestFrame(() => deps.requestFrame(finish));
    });
  }

  async function pick(event: MouseEvent): Promise<void> {
    if (done) return;
    try {
      const target = resolveTarget(doc, event.clientX, event.clientY, host);
      if (!target) return; // nothing under the point: stay active
      const described = describeElement(target);
      // Spec §4.2 step 5, in this order: scroll, remove the overlay, re-read the rect, wait two
      // frames. `instant` matters: a smooth scroll would leave the re-read rect wrong.
      scrollIntoViewOf(target, { block: 'center', inline: 'nearest', behavior: 'instant' });
      cleanup();
      const rect = rectOf(target);
      await settleFrames();
      deps.send(buildPayload(described, rect, win));
    } catch {
      abandon();
    }
  }

  win.addEventListener('pointermove', onMove, true);
  win.addEventListener('mousemove', onMove, true);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule, true);
  win.addEventListener('pagehide', cleanup, true);
  for (const type of SWALLOWED) win.addEventListener(type, onSwallow, true);

  guard[FLAG] = { host, cleanup };
  return { host, box, label, hint, cancel };
}
