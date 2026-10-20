# Test instructions for the reviewer (paste into the dashboard)

No account or sign-in is needed. BugBrief works on any ordinary web page.

1. Open any https page, for example https://example.com.
2. Click the BugBrief toolbar icon. Read the first-run notice and click "I understand, continue".
3. Click "Start recording". Chrome shows "BugBrief started debugging this browser". That is Chrome's own banner and is expected while recording.
4. Open DevTools (F12), choose the Console tab and run:
   `fetch('/missing-' + Date.now()); console.error('reviewer test')`
5. Open the BugBrief popup. The Record step shows 1 error and 1 failed request.
6. Click "Stop recording". Click "Pick element", then click the page heading.
7. Open the popup, type a note, click "Preview", then "Copy" (or "Download").

The report contains the console error, the failed request, the picked element and a screenshot. Nothing leaves the browser.

BugBrief cannot record chrome:// pages or the Chrome Web Store; it shows a message there.

## Short version (the dashboard field allows 500 characters)

```
No sign-in needed. Works on any https page (e.g. example.com).
1. Click the icon, then "I understand, continue".
2. Click Start recording (Chrome's debugging banner is expected).
3. In the page's DevTools console run: fetch('/x'+Date.now()); console.error('t')
4. Reopen the popup: 1 error, 1 failed request.
5. Stop, Pick element, click the heading.
6. Add a note, Preview, Copy.
Nothing leaves the browser. chrome:// pages are not supported.
```
