# Privacy practices tab: single purpose and permission justifications

## Single purpose
Conscribe captures the evidence of a bug on the tab the user chooses (console errors, failed requests, one picked element and its screenshot) and packages it into one Markdown report for the user to copy or save.

## Permission justifications

| Permission | Justification (paste) |
|---|---|
| `debugger` | Used to attach to the one tab the user records, after they click Start recording, and read its console errors and failed network requests (including bodies) through the Chrome DevTools Protocol. There is no other way to read response bodies of failed requests. Chrome shows its own "started debugging this browser" banner while this is on, and it detaches when the user clicks Stop. |
| `activeTab` | Gives temporary access to the tab the user is looking at when they click the Conscribe icon, so that they can pick an element and Conscribe can capture a screenshot of it. No access to other tabs. |
| `scripting` | Injects the element picker into the active tab when the user clicks Pick element, and removes it when they finish. Nothing is injected otherwise. |
| `storage` | Keeps the recording buffer, the picked element, the screenshot and the note draft in `chrome.storage.session` (cleared when the browser closes) so the popup and service worker can share them, and one flag in `chrome.storage.local` that records whether the user has seen the first-run notice. |
| `downloads` | Saves the Markdown report and its screenshot PNG to the user's Downloads folder when they click Download. |

## Host permissions
None requested. Conscribe does not ask for access to all websites.

## Remote code
No. All code is in the package. Nothing is fetched and run.
