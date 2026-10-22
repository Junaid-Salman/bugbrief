# Store listing (Chrome Web Store dashboard, Store listing tab)

Paste each block into the matching field. Nothing here is submitted until the owner submits it.

## Name
Conscribe

## Summary (max 132 characters; must equal `manifest.description`)
Package console errors, failed requests, the broken element and a screenshot into one agent-ready Markdown report.

## Category
Developer Tools

## Language
English

## Description
Conscribe turns a broken page into one Markdown report that you can paste into an AI coding agent or send to a teammate.

How it works
1. Open the page that is broken and click Start recording.
2. Reproduce the problem. Conscribe collects console errors and failed requests from that tab.
3. Click Stop, then Pick element and click the part of the page that looks wrong. Conscribe adds its selector, styles, HTML and a screenshot.
4. Add a short note, click Preview, then Copy or Download.

What is in the report
- Console errors with stack traces, repeats counted once
- Failed requests with status, request body and response body
- The element you picked: selector, computed styles, HTML and a screenshot
- Your note, the page address and the browser size

What it reads
Conscribe reads data from the tab you record: page content, a screenshot of the element you pick, the addresses of requests, request and response contents and console messages. That can include personal data and sign-in tokens that the page shows or sends. It all stays on your device. Nothing is sent anywhere, and there is no account, server or analytics.

Redaction
Conscribe masks secrets it recognizes, such as tokens, keys, passwords and email addresses. It can miss others, so read the report before you share it. The screenshot is not masked.

Limits
- One tab at a time. Chrome shows its own "started debugging this browser" banner while you record.
- It cannot record Chrome pages (chrome://), the Chrome Web Store or other restricted pages.
- Recording keeps the most recent errors and requests, not an unlimited history.

Open source (MIT): https://github.com/Junaid-Salman/conscribe
Privacy policy: see the Privacy policy field.
