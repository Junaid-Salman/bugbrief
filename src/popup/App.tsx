import { useEffect, useState } from 'preact/hooks';
import type { PopupToWorker, RecordingState, WorkerResponse } from '../shared/messages';
import { isRestrictedUrl, RESTRICTED_MESSAGE } from '../shared/restricted';
import { Explainer } from './Explainer';

const EXPLAINER_KEY = 'explainerSeen';

function send(message: PopupToWorker): Promise<WorkerResponse> {
  return chrome.runtime.sendMessage(message) as Promise<WorkerResponse>;
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

  useEffect(() => {
    void (async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTab(activeTab);
      const stored = await chrome.storage.local.get(EXPLAINER_KEY);
      setExplainerSeen(stored[EXPLAINER_KEY] === true);
      const response = await send({ type: 'GET_STATE' });
      if (response.ok) setState(response.state);
      else setError(response.error);
    })();
  }, []);

  async function run(message: PopupToWorker): Promise<void> {
    setBusy(true);
    setError(undefined);
    const response = await send(message);
    if (response.ok) setState(response.state);
    else setError(response.error);
    setBusy(false);
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
        Status: <strong>{label[state.status]}</strong>
      </p>
      {restricted ? <p style={styles.error}>{RESTRICTED_MESSAGE}</p> : null}
      {state.status === 'recording' ? (
        <button disabled={busy} onClick={() => void run({ type: 'STOP_RECORDING' })}>
          Stop recording
        </button>
      ) : (
        <button
          disabled={busy || restricted || tab?.id === undefined}
          onClick={() => tab?.id !== undefined && void run({ type: 'START_RECORDING', tabId: tab.id })}
        >
          Start recording
        </button>
      )}
      {state.status === 'recording' && !recordingHere ? (
        <p style={styles.hint}>Recording another tab. Start here to switch.</p>
      ) : null}
      {error ? <p style={styles.error}>{error}</p> : null}
    </main>
  );
}

const styles = {
  main: { width: '320px', padding: '16px', fontFamily: 'system-ui, sans-serif' },
  title: { margin: 0, fontSize: '18px' },
  status: { margin: '8px 0 12px' },
  hint: { margin: '8px 0 0', color: '#555', fontSize: '12px' },
  error: { margin: '8px 0 0', color: '#b00020', fontSize: '13px' },
} as const;
