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
        {COPY.explainerPoints.map((point) => (
          <li key={point}>
            <span class="dot" aria-hidden="true" />
            {point}
          </li>
        ))}
      </ul>
      <button class="btn btn--primary" onClick={onDismiss}>{COPY.gotIt}</button>
    </section>
  );
}
