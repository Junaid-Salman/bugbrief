import { COPY } from './copy';
import logoUrl from './assets/logo.png';

interface ExplainerProps {
  onDismiss: () => void;
}

export function Explainer({ onDismiss }: ExplainerProps) {
  return (
    <section class="card explainer">
      <img src={logoUrl} alt="" />
      <h1>Before you record</h1>
      <p>
        When you start recording, Chrome shows a banner: <em>"BugBrief started debugging this browser."</em> BugBrief
        needs it to read console errors and failed requests from the tab you choose.
      </p>
      <ul>
        <li><span class="dot" aria-hidden="true" />It records only after you click Start, and only on that tab.</li>
        <li><span class="dot" aria-hidden="true" />It detaches when you click Stop. Click Cancel on the banner to end it at once.</li>
        <li><span class="dot" aria-hidden="true" />Secrets are redacted before anything is shown. Nothing leaves your machine.</li>
      </ul>
      <button class="btn btn--primary" onClick={onDismiss}>{COPY.gotIt}</button>
    </section>
  );
}
