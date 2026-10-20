# Screenshots (owner captures; 1 to 5)

Final size 1280x800, full bleed, no device frame. Capture with the OS tool from a clean profile, then `ffmpeg -i in.png -vf scale=1280:800 store/assets/shot-N.png`.

1. The demo shop (`npm run demo`) with the popup open on step 1, recording, showing the error and failed-request counts.
2. The picker over the Order Summary card.
3. The Preview step with the "values redacted" badge and the screenshot warning.
4. The finished Markdown report pasted into an editor (use the demo data only; no real secrets).
5. The first-run notice listing what BugBrief reads.

Use only the demo shop's fake data. Save as `store/assets/shot-1.png` ... `shot-5.png`; `npm run store:check` fails if none exist.
