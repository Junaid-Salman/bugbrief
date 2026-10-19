import type { PickerToWorker } from '../shared/messages';
import { buildPayload, describeElement, describeTarget, resolveTarget } from './picker-dom';

const FLAG = '__bugbriefPicker';
const HINT = 'Click an element. Esc cancels.';
const ACCENT = '#1a73e8';
const TOP_Z_INDEX = '2147483647';
// Page handlers must not run while picking: a click on a link must not navigate.
const SWALLOWED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'auxclick'] as const;

interface PickerWindow extends Window {
  [FLAG]?: boolean;
}

export interface PickerDeps {
  win: Window;
  send: (message: PickerToWorker) => void;
  /** Schedules `callback` on the next animation frame. */
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
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

function nextFrame(deps: PickerDeps): Promise<void> {
  return new Promise((resolve) => deps.requestFrame(() => resolve()));
}

/** Starts one pick. A second start while one is active does nothing. */
export function startPicker(overrides: Partial<PickerDeps> = {}): PickerHandle | undefined {
  const win = overrides.win ?? window;
  const deps: PickerDeps = {
    win,
    send: overrides.send ?? defaultSend,
    requestFrame: overrides.requestFrame ?? ((callback) => win.requestAnimationFrame(() => callback())),
    cancelFrame: overrides.cancelFrame ?? ((handle) => win.cancelAnimationFrame(handle)),
  };
  const guard = win as PickerWindow;
  if (guard[FLAG]) return undefined;
  guard[FLAG] = true;

  const doc = win.document;
  const host = doc.createElement('div');
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

  const box = doc.createElement('div');
  style(box, {
    position: 'fixed',
    display: 'none',
    'box-sizing': 'border-box',
    border: `2px solid ${ACCENT}`,
    background: 'rgba(26, 115, 232, 0.15)',
    'pointer-events': 'none',
  });
  const label = doc.createElement('div');
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
  const hint = doc.createElement('div');
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
  doc.documentElement.appendChild(host);
  host.focus({ preventScroll: true });

  let point: { x: number; y: number } | undefined;
  let frame: number | undefined;
  let done = false;

  function refresh(): void {
    frame = undefined;
    if (done || !point) return;
    const target = resolveTarget(doc, point.x, point.y, host);
    if (!target) {
      box.style.setProperty('display', 'none', 'important');
      label.style.setProperty('display', 'none', 'important');
      return;
    }
    const rect = target.getBoundingClientRect();
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
    if (event.type === 'click') void pick(event as MouseEvent);
  }

  function onKey(event: Event): void {
    if ((event as KeyboardEvent).key !== 'Escape') return;
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

  function cancel(): void {
    if (done) return;
    cleanup();
    deps.send({ type: 'PICKER_CANCELLED' });
  }

  async function pick(event: MouseEvent): Promise<void> {
    if (done) return;
    const target = resolveTarget(doc, event.clientX, event.clientY, host);
    if (!target) return; // nothing under the point: stay active
    const described = describeElement(target);
    // Spec §4.2 step 5, in this order: scroll, remove the overlay, re-read the rect, wait two
    // frames. `instant` matters: a smooth scroll would leave the re-read rect wrong.
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    cleanup();
    const rect = target.getBoundingClientRect();
    await nextFrame(deps);
    await nextFrame(deps);
    deps.send(buildPayload(described, rect, win));
  }

  win.addEventListener('pointermove', onMove, true);
  win.addEventListener('mousemove', onMove, true);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule, true);
  win.addEventListener('pagehide', cleanup, true);
  for (const type of SWALLOWED) win.addEventListener(type, onSwallow, true);

  return { host, box, label, hint, cancel };
}
