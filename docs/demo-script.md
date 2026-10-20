# Demo GIF: recording script

The README GIF (`docs/demo.gif`, 33 s, 1280x800, 3.5 MB) is currently rendered from the built popup and the real demo shop with scripted extension state, because a live recording of the extension could not be made in the build session. It stops at the paste: no agent output is shown.

This script is for replacing it with a true screen recording: about 30 s, 1280x800, an MP4 master and a GIF under 5 MB (10 fps), of the built extension and the demo shop, with no mocked screens.

## Before you record

1. Build the final extension and load `dist/` in a clean Chrome profile with no other extensions, bookmarks or tabs.
2. `npm run demo`, then open `http://localhost:5174/?token=demo-session-3b7f1c9e2a`.
3. Set the window to 1280x800. Pin the BugBrief icon. Zoom 100%.
4. Run `npm run demo:reset` so the shop is in its broken state.
5. Have a Claude Code prompt box ready in another window. Do not show any earlier session.

## Takes

| Time | What you do | On screen | Caption |
|---|---|---|---|
| 0 to 3 s | Show the cart page. Click Go to Checkout: nothing happens. | The cart page | A bug your AI agent can't see. |
| 3 to 7 s | Click the icon, **Start recording**. Click the page, press `F5`. | Recording state, the banner, the page reloading | Record, then reload. |
| 7 to 13 s | Open the popup. | Counts: 2 errors, 3 failed requests | Errors and failed requests, captured. |
| 13 to 18 s | **Stop recording**, **Pick element**, click the Order Summary card. Reopen the popup. | The picker overlay, then "Screenshot captured" | Point at what is broken. |
| 18 to 24 s | Type the note: "Go to Checkout does nothing: the order fails with a 500 and the page throws an error." Click **Preview**. | The redaction count, the screenshot warning, `[REDACTED]` in the page address | Secrets removed before anything is shown. |
| 24 to 28 s | Click **Copy**. | "Copied to the clipboard." | One report, on your clipboard. |
| 28 to 32 s | Switch to the prompt box and paste. Stop there. | The pasted report | Paste it to your agent. |
| 32 to 35 s | End card, hold 2 s. | Logo and `github.com/Junaid-Salman/bugbrief` | BugBrief. Free and open source. |

## After recording

Give the raw file to the promo-video pipeline (brief: `~/promo-videos/bugbrief/brief.md`), which trims it, adds the captions and exports the MP4 and the GIF. Check the final frames for anything that is not the demo: tabs, notifications, other windows. Replace `docs/demo.gif` with the new file and remove the italic note under it in the README.
