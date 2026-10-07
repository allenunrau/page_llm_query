# On-Device LLM Queries (Chrome extension)

Side-panel extension that queries Chrome's built-in on-device model (Gemini Nano) via the Prompt API.

- The subject of each query is the page open in the active tab (or its selected text). Give a URL in the URL field, or in the query itself, to query that page instead
- Enter a new query and stream the response
- Query history persisted in `chrome.storage.local`
- Re-run, edit, copy, or delete any saved query (or delete all)

## Install
1. Use desktop Chrome 138+ (the model needs ~22 GB free disk and a capable GPU/CPU; see `chrome://on-device-internals`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the `extension/` folder.
3. Click the toolbar icon to open the panel. The first run downloads the model.

The extension requests access to all sites so it can read the open page and fetch URLs you supply. Long pages are truncated to fit the model's context window.
