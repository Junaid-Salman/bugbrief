# End-to-end checklist (manual, in Chrome)

This is the part of testing that only a real browser can show: the extension loaded in Chrome, the demo shop, a real capsule. The automated tests (`npm test`, `npm run demo:verify`) cover everything that can be checked without a browser. See the README "Testing" section for the split.

Set aside about 90 minutes. Fill in the **Result** column as you go (Pass, Fail or Skipped, plus a short note). Anything that fails is a finding: write down what you saw, and stop to look at it before going on if it blocks the next steps.

## 0. Results summary (fill in last)

| | |
|---|---|
| Date | |
| Tester | |
| Chrome version (`chrome://version`) | |
| Build commit (`git rev-parse --short HEAD`) | |
| `npm run build` and `npm test` pass (3 runs in a row) | |

| Criterion (proposal §7) | How it is shown | Status |
|---|---|---|
| 1. A coding agent can fix the bugs from the capsule | **Indirect.** The capsule sufficiency tests show the capsule points at the right file, line, request and cause, and `npm run demo:verify` shows the bugs are fixable. No AI agent is run by the tests. Part F is an optional paste into your own session | Indirect (automated). Part F: not done / done: ______ |
| 2. Capture completeness | Part A (real capsule) | |
| 3. Zero leaks | Automated on the Tier A capsule; Part A (real capsule) | |
| 4. Signal only | Unit tests; Part A confirms on a real page | |
| 5. Resilience | Part B | |
| 6. Quality gates | Setup 5 | |
| 7. Consolidation | Part C | |

## Setup

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | `git clone https://github.com/Junaid-Salman/bugbrief.git`, then `cd bugbrief` (or use your checkout, on a clean working tree) | | |
| 2 | `npm ci`, then `npm run build` | The build finishes without errors | |
| 3 | In Chrome use a clean profile (no other extensions, no other tabs). Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, choose `dist/`. Pin the BugBrief icon | The BugBrief logo is the toolbar icon | |
| 4 | `npm run demo` in a terminal and leave it running | It prints the shop and lab addresses | |
| 5 | In another terminal run `npm run build` and `npm test` three times | Zero errors each time (this is criterion 6) | |

## A. The real flow on the demo shop (README steps)

Open `http://localhost:5174/?token=demo-session-3b7f1c9e2a`. The page should look like a cart page and show nothing wrong.

| # | Do | Expect | Result |
|---|---|---|---|
| A1 | Click the BugBrief icon the first time | The first-run explainer. Its third point says screenshots are **not** redacted. Click **Got it** | |
| A2 | Click **Start recording** | Chrome shows "BugBrief started debugging this browser". The popup shows Recording | |
| A3 | Click the page, press `F5` to reload | The page reloads | |
| A4 | Open the popup | Record shows **2 errors** and **1 failed request** (the `TypeError` and the page's `console.error`; the `POST /api/orders` that returns 500). Write down the exact counts: ______ | |
| A5 | Click **Stop recording** | The banner disappears. The popup shows Stopped and keeps the counts | |
| A6 | Click **Pick element**. The popup closes. Move over the page: an overlay follows the pointer. Click the **Order Summary** card | The page does not react to the click. No overlay stays on the page | |
| A7 | Open the popup | Step 2 shows `Picked #summary` (or the selector the picker chose) and "Screenshot captured" | |
| A8 | Type a note ("Checkout does nothing") and click **Preview** | A badge such as "7 values redacted" with a count above zero (write it down: ______). The screenshot warning is shown. The Markdown preview scrolls inside its box | |
| A9 | Click **Copy**, paste into a text editor | The "Copied to the clipboard." message shows at the top of the popup | |
| A10 | **Capture completeness.** In the pasted text look for: an exception with a stack (`TypeError` with frames in `/shop/app.js`); `POST /api/orders → 500` with a **Request body** and a **Response body**; the **Selected element** block with selector, styles and HTML; a `**Screenshot:** capsule-….png` line | All present. Write down anything missing | |
| A11 | **Zero leaks.** Search the pasted text for each of: `demo-session-3b7f1c9e2a`, `demo-bearer-5d2e8f0a1b`, `jane.doe`, `demo-csrf-77c0a41e`. Also search for `Authorization` | None found (`j***@example.com` is the masked email, which is expected). Request headers are never put in the report, so the `Authorization` check proves nothing about redaction | |
| A12 | **Signal only.** Search for `Failed to load resource` and `ERR_ABORTED` | Neither appears. There is one failed request, not two | |
| A13 | **Link.** Find the console error "POST /api/orders failed with status 500" | It says "Likely related to failed request #1." | |
| A14 | Click **Download**. Open the `.md` and the `.png` | The two file names match the `Screenshot:` line in the Markdown. The popup says "Download started". **Download** is now off until a new Preview | |
| A15 | **Crop.** Open the PNG. "Correct" means: the whole picked element is in it, and no more than 16 px of page around each side | Pass or fail, with a note. Repeat the pick at 150% browser zoom (`Ctrl` and `+`) and in a window short enough to show a vertical scrollbar | |
| A16 | Click **Clear** | The note and the preview disappear and the counts reset | |

Save the pasted capsule from A9 to a local file outside the repo (for example `~/bugbrief-real-capsule.md`). Do not commit it and do not paste it anywhere: it holds page content.

## B. Resilience

| # | Do | Expect | Result |
|---|---|---|---|
| B1 | Start recording on the shop. Open `chrome://serviceworker-internals`, find BugBrief's worker and click **Stop**. Reopen the popup | Within about 2 s it shows **Recording** (not Stopped) and the counts are still there | |
| B2 | Reload the shop a few times while the popup is open | Status stays Recording. The counts grow | |
| B3 | Close the recorded tab | The debugger banner goes away. Open the popup on another tab: it shows Stopped. The counts are kept (open the shop in a new tab to see them) | |
| B4 | Start recording again. Click **Cancel** on the Chrome banner, reopen the popup | Status is Stopped. A request that was still in flight is counted | |
| B5 | Start on one tab, then on a second tab right away | The first tab stops, the second records, no banner is stuck | |

## C. Consolidation, on `http://localhost:5174/lab`

Start recording on the lab page first. Reopen the popup after each action to read the counts.

| # | Do | Expect | Result |
|---|---|---|---|
| C1 | Click **Fire the same error 5×**. Stop, **Preview** | One entry marked `(×5)` and flagged "High frequency" | |
| C2 | Click **Look-alike pair (index 0 and 1)** | Two separate entries, not one | |
| C3 | Click **POST /api/lab/orders/123 and /456** | One entry `POST /api/lab/orders/:id`-style marked `(×2)` (the numeric ids are normalized) | |
| C4 | In the Summary table add up the `(×N)` values | The totals equal the sum | |

## D. Phase 9.0 fixes

| # | Do | Expect | Result |
|---|---|---|---|
| D1 | Start recording, type a note, Stop with nothing captured (no errors, no pick). Close and reopen the popup | The note is still there, **Preview** is off, the hint says "Nothing to report yet", and only the Record step is highlighted | |
| D2 | With a preview showing, try to make Copy fail. A real popup rarely fails to copy, so this may not be possible by hand: mark it **Skipped** if you cannot. (The harness shows the case: `npm run build`, then `node scripts/popup-harness.mjs copy-fail`) | A "Could not copy: …" message shows at the top of the popup without scrolling | |
| D3 | Copy successfully, then scroll the popup to the bottom | "Copied to the clipboard." is still visible at the top | |
| D4 | Open the popup on `chrome://extensions` after a recording | "BugBrief can't record this page." shows above the steps, with Record folded | |
| D5 | Every popup action works from the real popup: Start, Stop, Pick, Preview, Copy, Download, Clear | Nothing says "Not allowed." (the popup is accepted by the new sender checks) | |

## E. Checks carried over from earlier phases

**Debugging session (phase 3). Use `/lab`.**

| # | Do | Expect | Result |
|---|---|---|---|
| E1 | Start, click **Freeze page (30 s)**, click Stop | Stopped within about 5 s, the banner disappears, counts kept | |
| E2 | Start, freeze the page, stop the worker in `chrome://serviceworker-internals`, reopen the popup | The popup answers within about 2 s and shows Recording | |
| E3 | Start, stop the worker, click **Cancel** on the banner, reopen the popup | Stopped (a really dead session is noticed) | |
| E4 | Click **Slow-body 500 (1.5 s)** and Stop within 1.5 s | The failed-request count includes it right after Stop and does not change afterwards | |
| E5 | Freeze the tab, then press **Start** | Within about 3 s the popup shows an error or Recording, never a stuck busy state | |
| E6 | Start on a healthy tab | Behaves normally | |
| E7 | Build with `npm run build:debug`, reload the extension, record the demo errors and a 500, Stop. Open the worker console (`chrome://extensions`, BugBrief, "service worker") | Entry lines and a buffer summary are logged | |
| E8 | Build normally again (`npm run build`), repeat | Only lines like "recording started" and "recording stopped" and warnings. No URLs, bodies or titles | |

**Picker and screenshot (phases 5 and 6). Use `/lab`.** After each pick, open the popup, Preview and Download the PNG.

| # | Do | Expect | Result |
|---|---|---|---|
| E9 | Pick a button, the shadow-root button, and the fixed element | One screenshot each, cropped to the element, no overlay visible in any crop | |
| E10 | Pick the tall element | The popup says the screenshot is clipped to the viewport, and the image is the visible part | |
| E11 | Crop at browser zoom 100% and 150%, and on a page with a vertical scrollbar | The crop does not drift toward the right edge | |
| E12 | Pick, then within a second pick again | The second pick wins; no stale image | |
| E13 | Pick, then switch to another tab right after the click | No screenshot of the other tab. The popup shows a reason | |
| E14 | Pick while recording | Works | |
| E15 | Record only: scroll the page 100 px while a second pick is queued. Pinch-zoom, pick. (Known limits: write down what you see, these are not gates) | | |
| E16 | Stop the worker during a capture (`chrome://serviceworker-internals`) | The element survives and the popup reports "interrupted" | |

**Capsule and popup (phases 7 and 8).**

| # | Do | Expect | Result |
|---|---|---|---|
| E17 | Reload the popup after typing a note | The note is restored | |
| E18 | Edit the note after Preview | Copy and Download are off and the preview is labelled out of date | |
| E19 | Record only (no pick), pick only (no recording), and an element picked on another tab | Each gives a sensible capsule | |
| E20 | Click Download twice for one preview | The second is off until a new Preview | |
| E21 | Record, Cancel on the banner, then Preview | Title and viewport come from Start | |
| E22 | Open the popup in every state (idle, recording, ready, preview, stale, restricted) in light and dark mode (`chrome://settings/appearance`) | Text is readable, the layout fits the 600 px popup height, nothing is cut off, and the header stays in view while you scroll | |

## F. Optional: one paste into your own AI agent

This is not part of any test and nothing depends on it. It is the closest free check of the original acceptance idea. It uses your own session, at your own choosing.

1. `npm run demo:reset`, then copy `demo/` to a scratch folder outside the repo.
2. Put the real capsule from A9 in that folder as `CAPSULE.md`. The screenshot file is not attached.
3. Open your agent in the scratch folder and give it the capsule with the sentence: "Fix the problems this report describes by editing the files in this folder."
4. `npm run demo:verify <scratch folder>` shows whether the demo works again.
5. Write down: did the agent ask a question? Did `demo:verify` go green? ______

## Findings

| # | Step | What I saw | Severity (blocks release / should fix / note) |
|---|---|---|---|
| | | | |
