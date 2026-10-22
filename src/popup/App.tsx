import { useEffect, useMemo, useState } from 'preact/hooks';
import { FIELD } from '../core/limits';
import type { BufferCounts, ElementSummary, PopupToWorker, RecordingState, WorkerResponse } from '../shared/messages';
import { isRestrictedUrl, OTHER_TAB_MESSAGE } from '../shared/restricted';
import {
  SCREENSHOT_WARNING, badgeText, canCopy, canDownload, canPreview, dataSignature, dropsPreview, isStale, previewHint,
  showsScreenshotWarning, type CapsuleUi, type PreviewState,
} from './capsule-state';
import { COPY, plural, recordedSummary } from './copy';
import { Explainer } from './Explainer';
import { topNotices } from './notices';
import { createDraftWriter, loadDraft } from './note-draft';
import { canPick, elementNote, pickLabel, pollWhilePending, screenshotNote, showClear } from './pick-state';
import { stepsView, type Rail } from './steps';
import logoUrl from './assets/logo.png';

const EXPLAINER_KEY = 'explainerSeen';

function send(message: PopupToWorker): Promise<WorkerResponse> {
  return chrome.runtime.sendMessage(message) as Promise<WorkerResponse>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const statusLabel: Record<RecordingState['status'], string> = {
  idle: 'Idle',
  recording: 'Recording',
  stopped: 'Stopped',
};

export function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab | undefined>();
  const [state, setState] = useState<RecordingState>({ status: 'idle' });
  const [explainerSeen, setExplainerSeen] = useState<boolean | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<BufferCounts | undefined>();
  const [persistenceOk, setPersistenceOk] = useState(true);
  const [element, setElement] = useState<ElementSummary | undefined>();
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const [downloaded, setDownloaded] = useState(false);
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const draft = useMemo(() => createDraftWriter(chrome.storage.session), []);
  // False until the worker answers the first GET_STATE, so a slow answer never shows a false Idle.
  const [loaded, setLoaded] = useState(false);

  function apply(response: WorkerResponse): void {
    if (response.ok) {
      setState(response.state);
      setElement(response.element);
      if (response.counts) setCounts(response.counts);
      if (response.persistenceOk !== undefined) setPersistenceOk(response.persistenceOk);
    } else {
      setError(response.error);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setTab(activeTab);
        const stored = await chrome.storage.local.get(EXPLAINER_KEY);
        setExplainerSeen(stored[EXPLAINER_KEY] === true);
        apply(await send({ type: 'GET_STATE' }));
      } catch (caught) {
        setExplainerSeen((seen) => seen ?? true);
        setError(describe(caught));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Restore the note, and write it once more if the popup closes (the user clicked into the page).
  useEffect(() => {
    void loadDraft(chrome.storage.session).then((saved) => {
      draft.seed(saved);
      setNote((current) => (current === '' ? saved : current));
    });
    const flush = (): void => void draft.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [draft]);

  // The popup closes on every pick, so reopening it during the capture is the normal flow.
  useEffect(() => {
    if (element?.screenshot !== 'pending') return undefined;
    return pollWhilePending(async () => {
      const response = await send({ type: 'GET_STATE' });
      apply(response);
      return response.ok ? response.element : undefined;
    });
  }, [element?.screenshot, element?.pickedAt]);

  async function run(message: PopupToWorker): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      apply(await send(message));
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  // The popup closes only after the worker confirms the injection. A failure keeps it open.
  async function pickElement(): Promise<void> {
    if (tab?.id === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await send({ type: 'START_PICKER', tabId: tab.id });
      apply(response);
      if (response.ok) window.close();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  function onNote(value: string): void {
    const next = value.slice(0, FIELD.userNote);
    setNote(next);
    setNotice(undefined);
    void draft.update(next);
  }

  async function previewCapsule(): Promise<void> {
    setBusy(true);
    setBuilding(true);
    setError(undefined);
    setNotice(undefined);
    setDownloaded(false);
    try {
      const response = await send({ type: 'BUILD_CAPSULE', userNote: note });
      apply(response);
      if (response.ok && response.markdown !== undefined && response.capturedAt && response.previewHash) {
        setPreview({
          markdown: response.markdown,
          redactionCount: response.redactionCount ?? 0,
          capturedAt: response.capturedAt,
          previewHash: response.previewHash,
          screenshot: response.screenshot ?? 'none',
          note,
          signature: dataSignature(response.counts ?? counts, response.element),
        });
      } else {
        setPreview(undefined);
      }
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
      setBuilding(false);
    }
  }

  async function copyCapsule(): Promise<void> {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.markdown);
      setError(undefined);
      setNotice(COPY.copied);
    } catch (caught) {
      setNotice(undefined);
      setError(`Could not copy: ${describe(caught)}`);
    }
  }

  async function downloadCapsule(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await send({ type: 'DOWNLOAD_CAPSULE', userNote: preview.note, capturedAt: preview.capturedAt, previewHash: preview.previewHash });
      if (response.ok) {
        apply(response);
        setDownloaded(true);
        setNotice(`Download started: ${(response.files ?? []).join(', ')}`);
      } else {
        setError(response.error);
        if (dropsPreview(response.code)) setPreview(undefined); // the preview is missing or out of date: a new Preview is needed
      }
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  // Clear also drops the note draft and the preview (spec §4.3 step 7).
  async function clearAll(): Promise<void> {
    await run({ type: 'CLEAR' });
    await draft.clear();
    setNote('');
    setPreview(undefined);
    setDownloaded(false);
    setNotice(undefined);
  }

  async function dismissExplainer(): Promise<void> {
    await chrome.storage.local.set({ [EXPLAINER_KEY]: true });
    setExplainerSeen(true);
  }

  if (explainerSeen === undefined) return <main class="popup" />;
  if (!explainerSeen) {
    return (
      <main class="popup">
        <Header />
        <div class="body">
          <Explainer onDismiss={() => void dismissExplainer()} />
        </div>
      </main>
    );
  }

  // Chrome withholds the URL of pages the extension can't access, even after the popup grants activeTab.
  const restricted = tab !== undefined && (tab.url === undefined || isRestrictedUrl(tab.url));
  const recording = state.status === 'recording';
  const recordingHere = recording && state.tabId === tab?.id;
  const ui: CapsuleUi = { loaded, busy, state, counts, element, note, preview, downloaded };
  const stale = isStale(ui);
  const hint = previewHint(ui);
  const view = stepsView(ui);
  const notices = topNotices({ restricted, persistenceOk, error, notice });
  const hasEntries = counts !== undefined && hasData(counts);
  const canStart = !busy && loaded && !restricted && tab?.id !== undefined;
  const pickable = canPick({ loaded, busy, restricted, tabId: tab?.id, state });
  const startRecording = (): void => {
    if (tab?.id !== undefined) void run({ type: 'START_RECORDING', tabId: tab.id });
  };
  const pickButton = (small: boolean) => (
    <button class={`btn btn--secondary${small ? ' btn--small' : ''}`} disabled={!pickable} onClick={() => void pickElement()}>
      {pickLabel(element)}
    </button>
  );

  return (
    <main class="popup">
      <div class="top">
        <Header status={loaded ? state.status : undefined} />
        {notices.length > 0 ? (
          <div class="notices">
            {notices.map((item) => (
              <p key={item.text} class={`msg msg--${item.kind} box box--${item.kind}`} role={item.kind === 'ok' ? 'status' : 'alert'}>
                {item.text}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div class="body">
        <ol class="steps">
          <Step n={1} rail={view.rail[0]}>
            {view.open[0] ? (
              <section class={`card${view.rail[0] === 1 ? ' card--active' : ''}`}>
                <div class="card__title">
                  <h2>{COPY.recordTitle}</h2>
                  {recording ? <span class="live">{COPY.live}</span> : null}
                </div>
                <div class="row">
                  {recording ? (
                    <button class="btn btn--danger" disabled={busy || !loaded} onClick={() => void run({ type: 'STOP_RECORDING' })}>
                      {COPY.stop}
                    </button>
                  ) : (
                    <button class="btn btn--primary" disabled={!canStart} onClick={startRecording}>
                      {COPY.start}
                    </button>
                  )}
                </div>
                {counts && (recording || hasEntries) ? <Counts counts={counts} /> : restricted ? null : <p class="hint">{COPY.recordHint}</p>}
                {recording && !recordingHere ? <p class="msg msg--warn">{OTHER_TAB_MESSAGE}</p> : null}
              </section>
            ) : (
              <section class="card card--folded">
                <div class="folded__text">
                  <strong class="folded__title">{COPY.recordedTitle}</strong>
                  <span class="sub">{counts ? recordedSummary(counts) : ''}</span>
                </div>
                <button class="btn btn--ghost btn--small" disabled={!canStart} onClick={startRecording}>
                  {COPY.startOver}
                </button>
              </section>
            )}
          </Step>
          <Step n={2} rail={view.rail[1]}>
            {view.open[1] ? (
              <section class={`card${view.rail[1] === 1 ? ' card--active' : ''}`}>
                <div class="card__title">
                  <h2>{COPY.pickTitle}</h2>
                </div>
                <div class="row">
                  {pickButton(false)}
                  {element ? <code class="selector" title={elementNote(element, tab?.id)}>{element.selector}</code> : null}
                </div>
                {element ? (
                  <p class={`status status--${element.screenshot === 'unavailable' ? 'bad' : element.screenshot === 'pending' ? 'pending' : 'ok'}`}>
                    <span class="dot" aria-hidden="true" />
                    {screenshotNote(element)}
                  </p>
                ) : (
                  <p class="hint">{recording ? COPY.recordingHint : COPY.pickHint}</p>
                )}
              </section>
            ) : (
              <section class="card card--folded">
                <div class="folded__text">
                  <strong class="folded__title" title={element ? elementNote(element, tab?.id) : undefined}>
                    Picked {element?.selector}
                  </strong>
                  <span class="sub">{element ? screenshotNote(element) : ''}</span>
                </div>
                {pickButton(true)}
              </section>
            )}
          </Step>
          <Step n={3} rail={view.rail[2]} last>
            {view.open[2] ? (
              <section class={`card${view.rail[2] === 1 ? ' card--active' : ''}`}>
                <div class="card__title">
                  <h2>{COPY.shareTitle}</h2>
                  {showClear(state, hasEntries, element) ? (
                    <button class="btn btn--ghost btn--small" disabled={busy || !loaded} onClick={() => void clearAll()}>
                      {COPY.clear}
                    </button>
                  ) : null}
                </div>
                <label class="label" htmlFor="note">{COPY.noteLabel}</label>
                <textarea
                  id="note"
                  class="note"
                  rows={2}
                  maxLength={FIELD.userNote}
                  placeholder={COPY.notePlaceholder}
                  value={note}
                  onInput={(event) => onNote((event.target as HTMLTextAreaElement).value)}
                />
                <div class="row">
                  <button class={`btn ${preview ? 'btn--secondary' : 'btn--primary'}`} disabled={!canPreview(ui)} onClick={() => void previewCapsule()}>
                    {building ? COPY.building : COPY.preview}
                  </button>
                  <button class="btn btn--secondary" disabled={!canCopy(ui)} onClick={() => void copyCapsule()}>{COPY.copy}</button>
                  <button class="btn btn--secondary" disabled={!canDownload(ui)} onClick={() => void downloadCapsule()}>{COPY.download}</button>
                </div>
                {hint ? <p class={`hint${stale ? ' msg--warn' : ''}`}>{hint}</p> : null}
                {preview ? (
                  <>
                    <div class="preview__head">
                      <h3>{COPY.previewTitle}</h3>
                      <span class="badge">
                        <span class="dot" aria-hidden="true" />
                        {badgeText(preview.redactionCount)}
                      </span>
                    </div>
                    {showsScreenshotWarning(ui) ? (
                      <p class="msg msg--warn box box--warn">
                        <span class="dot" aria-hidden="true" />
                        {SCREENSHOT_WARNING}
                      </p>
                    ) : null}
                    <pre class={`md${stale ? ' md--stale' : ''}`} tabIndex={0} aria-label={COPY.previewTitle}>{preview.markdown}</pre>
                  </>
                ) : null}
              </section>
            ) : (
              <section class="card card--folded card--muted">
                <div class="folded__text">
                  <strong class="folded__title">{COPY.shareTitle}</strong>
                  <span class="sub">{COPY.shareLocked}</span>
                </div>
              </section>
            )}
          </Step>
        </ol>
      </div>
    </main>
  );
}

function Header({ status }: { status?: RecordingState['status'] }) {
  return (
    <header class="header">
      <h1 class="brand">
        <img src={logoUrl} alt="" />
        Conscribe
      </h1>
      {status ? (
        <span class={`pill pill--${status}`} aria-label={`Status: ${statusLabel[status]}`}>
          <span class="dot" aria-hidden="true" />
          {statusLabel[status]}
        </span>
      ) : null}
    </header>
  );
}

function Step({ n, rail, last, children }: { n: number; rail: Rail; last?: boolean; children: preact.ComponentChildren }) {
  return (
    <li class="step" aria-current={rail === 1 ? 'step' : undefined}>
      <div class="rail" aria-hidden="true">
        <span class={`node node--${rail}`}>{rail === 2 ? '✓' : n}</span>
        {last ? null : <span class={`link${rail === 2 ? ' link--done' : ''}`} />}
      </div>
      {children}
    </li>
  );
}

function hasData(counts: BufferCounts): boolean {
  return counts.console.unique + counts.network.unique + counts.console.evicted.entries + counts.network.evicted.entries > 0;
}

function Counts({ counts }: { counts: BufferCounts }) {
  const evicted = counts.console.evicted.entries + counts.network.evicted.entries;
  return (
    <>
      <div class="chips">
        <div class="chip">
          <strong>{plural(counts.console.unique, 'error')}</strong>
          <span class="sub">{plural(counts.console.total, 'occurrence')}</span>
        </div>
        <div class="chip">
          <strong>{plural(counts.network.unique, 'failed request')}</strong>
          <span class="sub">{plural(counts.network.total, 'occurrence')}</span>
        </div>
      </div>
      {evicted > 0 ? <p class="hint">{plural(evicted, 'older entry', 'older entries')} dropped (buffer limit).</p> : null}
    </>
  );
}
