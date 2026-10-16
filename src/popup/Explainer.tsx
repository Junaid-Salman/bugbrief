interface ExplainerProps {
  onDismiss: () => void;
}

export function Explainer({ onDismiss }: ExplainerProps) {
  return (
    <section>
      <h1 style={{ margin: 0, fontSize: '18px' }}>Before you record</h1>
      <p style={{ margin: '8px 0' }}>
        When you start recording, Chrome shows a banner: <em>"BugBrief started debugging this browser."</em>
      </p>
      <p style={{ margin: '8px 0' }}>
        BugBrief needs it to read console errors and failed requests from the tab you choose. It records only after
        you click Start, only on that tab, and detaches when you click Stop. Nothing leaves your machine.
      </p>
      <p style={{ margin: '8px 0' }}>Click Cancel on the banner at any time to end the session.</p>
      <button onClick={onDismiss}>Got it</button>
    </section>
  );
}
