import { COPY } from './copy';
import logoUrl from './assets/logo.png';

interface ExplainerProps {
  onDismiss: () => void;
}

/** The disclosure and agreement the user sees before the first recording (the store's User Data policy asks for it in the product itself). */
export function Explainer({ onDismiss }: ExplainerProps) {
  return (
    <section class="card explainer">
      <img src={logoUrl} alt="" />
      <h1>Before you record</h1>
      <p>
        When you start recording, Chrome shows a banner: <em>"BugBrief started debugging this browser."</em> BugBrief
        needs it to read data from the tab you choose.
      </p>
      <h2>{COPY.explainerReadsTitle}</h2>
      <ul>
        {COPY.explainerReads.map((item) => (
          <li key={item}>
            <span class="dot" aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
      <ul>
        {COPY.explainerPoints.map((point) => (
          <li key={point}>
            <span class="dot" aria-hidden="true" />
            {point}
          </li>
        ))}
      </ul>
      <button class="btn btn--primary" onClick={onDismiss}>{COPY.agree}</button>
    </section>
  );
}
