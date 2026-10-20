import { useEffect, useMemo, useState } from 'preact/hooks';
import { FIELD } from '../core/limits';
import type { BufferCounts, ElementSummary, PopupToWorker, RecordingState, WorkerResponse } from '../shared/messages';
import { isRestrictedUrl, RESTRICTED_MESSAGE } from '../shared/restricted';
import {
  SCREENSHOT_WARNING, badgeText, canCopy, canDownload, canPreview, dataSignature, isStale, previewHint,
  showsScreenshotWarning, type CapsuleUi, type PreviewState,
} from './capsule-state';
import { Explainer } from './Explainer';
import { createDraftWriter, loadDraft } from './note-draft';
import { canPick, elementNote, pickLabel, pollWhilePending, screenshotNote, showClear } from './pick-state';

const EXPLAINER_KEY = 'explainerSeen';

function send(message: PopupToWorker): Promise<WorkerResponse> {
  return chrome.runtime.sendMessage(message) as Promise<WorkerResponse>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const label: Record<RecordingState['status'], string> = {
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
    void loadDraft(chrome.storage.session).then((saved) => setNote((current) => (current === '' ? saved : current)));
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
    }
  }

  async function copyCapsule(): Promise<void> {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.markdown);
      setError(undefined);
      setNotice('Copied to the clipboard.');
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
        if (response.error.includes('Preview')) setPreview(undefined); // the data changed: a new Preview is needed
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

  if (explainerSeen === undefined) return <main style={styles.main} />;
  if (!explainerSeen) {
    return (
      <main style={styles.main}>
        <Explainer onDismiss={() => void dismissExplainer()} />
      </main>
    );
  }

  // Chrome withholds the URL of pages the extension can't access, even after the popup grants activeTab.
  const restricted = tab !== undefined && (tab.url === undefined || isRestrictedUrl(tab.url));
  const recordingHere = state.status === 'recording' && state.tabId === tab?.id;
  const ui: CapsuleUi = { loaded, busy, state, counts, element, note, preview, downloaded };
  const stale = isStale(ui);
  const hint = previewHint(ui);

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>BugBrief</h1>
      <p style={styles.status}>
        Status: <strong>{loaded ? label[state.status] : 'Checking…'}</strong>
      </p>
      {restricted ? <p style={styles.error}>{RESTRICTED_MESSAGE}</p> : null}
      {state.status === 'recording' ? (
        <button disabled={busy || !loaded} onClick={() => void run({ type: 'STOP_RECORDING' })}>
          Stop recording
        </button>
      ) : (
        <button
          disabled={busy || !loaded || restricted || tab?.id === undefined}
          onClick={() => tab?.id !== undefined && void run({ type: 'START_RECORDING', tabId: tab.id })}
        >
          Start recording
        </button>
      )}
      {state.status === 'recording' && !recordingHere ? (
        <p style={styles.hint}>Recording another tab. Start here to switch.</p>
      ) : null}
      <button
        style={styles.secondary}
        disabled={!canPick({ loaded, busy, restricted, tabId: tab?.id, state })}
        onClick={() => void pickElement()}
      >
        {pickLabel(element)}
      </button>
      {element ? (
        <p style={styles.element}>
          {elementNote(element, tab?.id)}
          <br />
          {screenshotNote(element)}
        </p>
      ) : null}
      {counts ? <Counts counts={counts} /> : null}
      {showClear(state, counts !== undefined && hasData(counts), element) ? (
        <button style={styles.secondary} disabled={busy || !loaded} onClick={() => void clearAll()}>
          Clear
        </button>
      ) : null}
      <label style={styles.label} htmlFor="note">What happened? (expected vs actual)</label>
      <textarea
        id="note"
        style={styles.note}
        rows={3}
        maxLength={FIELD.userNote}
        value={note}
        onInput={(event) => onNote((event.target as HTMLTextAreaElement).value)}
      />
      <div style={styles.row}>
        <button disabled={!canPreview(ui)} onClick={() => void previewCapsule()}>Preview</button>
        <button disabled={!canCopy(ui)} onClick={() => void copyCapsule()}>Copy</button>
        <button disabled={!canDownload(ui)} onClick={() => void downloadCapsule()}>Download</button>
      </div>
      {hint ? <p style={styles.hint}>{hint}</p> : null}
      {preview ? (
        <div>
          <p style={styles.badge}>{badgeText(preview.redactionCount)}</p>
          {showsScreenshotWarning(ui) ? <p style={styles.warn}>{SCREENSHOT_WARNING}</p> : null}
          <pre style={stale ? styles.previewStale : styles.preview}>{preview.markdown}</pre>
        </div>
      ) : null}
      {notice ? <p style={styles.notice}>{notice}</p> : null}
      {!persistenceOk ? (
        <p style={styles.error}>Persistence is off. Captured data may be lost if the worker restarts.</p>
      ) : null}
      {error ? <p style={styles.error}>{error}</p> : null}
    </main>
  );
}

function hasData(counts: BufferCounts): boolean {
  return counts.console.unique + counts.network.unique + counts.console.evicted.entries + counts.network.evicted.entries > 0;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function Counts({ counts }: { counts: BufferCounts }) {
  const evicted = counts.console.evicted.entries + counts.network.evicted.entries;
  return (
    <div style={styles.counts}>
      <div>
        {plural(counts.console.unique, 'error')} ({plural(counts.console.total, 'occurrence')})
      </div>
      <div>
        {plural(counts.network.unique, 'failed request')} ({plural(counts.network.total, 'occurrence')})
      </div>
      {evicted > 0 ? <div>{plural(evicted, 'older entry', 'older entries')} dropped</div> : null}
    </div>
  );
}

const styles = {
  main: { width: '480px', padding: '16px', fontFamily: 'system-ui, sans-serif' },
  title: { margin: 0, fontSize: '18px' },
  status: { margin: '8px 0 12px' },
  counts: { margin: '12px 0 0', fontSize: '13px', lineHeight: 1.5 },
  secondary: { marginTop: '8px' },
  hint: { margin: '8px 0 0', color: '#555', fontSize: '12px' },
  element: { margin: '8px 0 0', fontSize: '12px', wordBreak: 'break-all' },
  label: { display: 'block', margin: '12px 0 4px', fontSize: '12px' },
  note: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '13px' },
  row: { display: 'flex', gap: '8px', marginTop: '8px' },
  badge: { margin: '12px 0 4px', fontSize: '12px', fontWeight: 600 },
  warn: { margin: '4px 0', color: '#8a5a00', fontSize: '12px' },
  notice: { margin: '8px 0 0', color: '#1b6e2d', fontSize: '12px', wordBreak: 'break-all' },
  preview: { maxHeight: '260px', overflow: 'auto', margin: '4px 0 0', padding: '8px', background: '#f6f8fa', border: '1px solid #d0d7de', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  previewStale: { maxHeight: '260px', overflow: 'auto', margin: '4px 0 0', padding: '8px', background: '#f6f8fa', border: '1px dashed #b00020', opacity: 0.5, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  error: { margin: '8px 0 0', color: '#b00020', fontSize: '13px' },
} as const;
