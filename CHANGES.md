# Summary of changes (LinkedIn job list scores, invalid-URL hardening, UI)

## Overview

- **Job list page**: Show cached score badges on search/collections; load and apply scores on page load with retries.
- **Extension context / invalid URL**: Guards and defensive fixes for `chrome-extension://invalid/` and “extension context invalidated” (popup + content script).
- **PDF worker**: No longer exposed to web pages; worker cleared when context is invalid.
- **Popup UI**: Tabbed layout (main, settings, resumes, debug), batch controls removed, debug log panel.

---

## 1. Manifest

- **`web_accessible_resources`**: Set to `[]`. Removed `pdf.worker.mjs` from being loadable by `<all_urls>`. Only the extension (e.g. popup) can load the worker; this avoids pages (e.g. LinkedIn) ever successfully requesting it and then hitting `chrome-extension://invalid/` after reload.

---

## 2. Popup

- **Invalid-URL guard (top of script)**: Patch `window.fetch` and `window.Worker` to block and `console.error` (with stack) any URL containing `chrome-extension://invalid`, so we can see if our code ever triggers such requests.
- **Clear PDF worker when context invalid**: On load, if `chrome.runtime.getURL('x')` contains `"invalid"`, dynamically import `pdfjs-dist` and set `GlobalWorkerOptions.workerSrc = ''` so no stale worker URL is used.
- **PDF parsing**: In `parsePdfToText`, check `getURL()` for `invalid` and throw before importing PDF.js; add `debugLog` for worker URL, context validity, and getDocument success/failure.
- **Tabs**: Main (resume checkboxes + evaluate), Settings, Resumes, Debug. External links open in a new tab.
- **Batch mode removed**: No “batch” naming, “Refresh scores” button, or batch settings; kept list-page cache and score tags.
- **List scores**: When panel opens, call `refreshCachedScoresOnPage` so the current tab’s job list gets cached scores applied.
- **Result score label**: Shown as `Score: x/100`.
- **Debug log**: In-memory log (max 200 entries), clear button, rendered in Debug tab.

---

## 3. Content script

- **Invalid-URL guard (top of script)**: Same fetch/Worker patch as popup, with `[job-eval CONTENT]` in logs to distinguish source.
- **Score tags on job list**: For job search/collections, request cached scores via `GET_CACHED_SCORES_FOR_JOBS`; render a small badge at bottom-right of each job card with `Score: x/100`.
- **Scores on load**: On list-page load, request cached scores and apply badges; retry at 1.5s, 4s, 7s to cope with SPA render timing.
- **Extension context invalidated**: Try/catch around notify/sendMessage; deferred `sendMessage` in `setTimeout` where needed; job-change logic only in top frame; interval, click, and message handlers wrapped in try/catch so errors don’t escape.

---

## 4. Background (service worker)

- **`GET_CACHED_SCORES_FOR_JOBS`**: New message type; accepts `jobIds` array, reads cache via `getJobEvaluation`, returns `{ scores: Record<string, number> }`.

---

## 5. Other files

- **popup.html / popup.css**: Tabbed panels, debug log container, removal of batch-related UI.
- **build.mjs, package.json, llm.ts**: Build/config and model usage adjustments as needed for the above.

---

## Note on `chrome-extension://invalid/` errors

If you see `GET chrome-extension://invalid/ net::ERR_FAILED` in the console **even with this extension disabled**, the request is not from this extension. It comes from page context (e.g. LinkedIn’s scripts or another extension) using a stale extension URL. The guards and PDF changes in this branch ensure this extension does not introduce or perpetuate that pattern.
