import { useEffect, useState } from 'preact/hooks';
import type { BufferCounts, ElementSummary, PopupToWorker, RecordingState, WorkerResponse } from '../shared/messages';
import { isRestrictedUrl, RESTRICTED_MESSAGE } from '../shared/restricted';
import { Explainer } from './Explainer';
import { canPick, elementNote, pickLabel, showClear } from './pick-state';

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
      {element ? <p style={styles.element}>{elementNote(element, tab?.id)}</p> : null}
      {counts ? <Counts counts={counts} /> : null}
      {showClear(state, counts !== undefined && hasData(counts), element) ? (
        <button style={styles.secondary} disabled={busy || !loaded} onClick={() => void run({ type: 'CLEAR' })}>
          Clear
        </button>
      ) : null}
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
  main: { width: '320px', padding: '16px', fontFamily: 'system-ui, sans-serif' },
  title: { margin: 0, fontSize: '18px' },
  status: { margin: '8px 0 12px' },
  counts: { margin: '12px 0 0', fontSize: '13px', lineHeight: 1.5 },
  secondary: { marginTop: '8px' },
  hint: { margin: '8px 0 0', color: '#555', fontSize: '12px' },
  element: { margin: '8px 0 0', fontSize: '12px', wordBreak: 'break-all' },
  error: { margin: '8px 0 0', color: '#b00020', fontSize: '13px' },
} as const;
