const STORAGE_KEY = 'queries';
const LM_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

const $ = (id) => document.getElementById(id);
const form = $('query-form');
const input = $('query-input');
const runBtn = $('run-btn');
const stopBtn = $('stop-btn');
const statusEl = $('status');
const progressEl = $('download');
const historyEl = $('history');
const emptyEl = $('empty');
const countEl = $('count');
const urlInput = $('url-input');
const subjectEl = $('subject');

let queries = [];        // newest first
let runningId = null;    // id of the query currently being run
let controller = null;   // AbortController for the active run

// ---------- storage ----------
async function load() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  queries = data[STORAGE_KEY] || [];
}
// Serialized snapshots this panel wrote, so their onChanged echoes can be ignored.
const ownWrites = new Set();
function save() {
  const json = JSON.stringify(queries);
  ownWrites.add(json);
  if (ownWrites.size > 50) ownWrites.delete(ownWrites.values().next().value);
  return chrome.storage.local.set({ [STORAGE_KEY]: JSON.parse(json) });
}

// ---------- model ----------
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function checkAvailability() {
  if (typeof LanguageModel === 'undefined') {
    setStatus('Prompt API unavailable (needs Chrome 138+ desktop)', true);
    return 'unavailable';
  }
  try {
    const a = await LanguageModel.availability(LM_OPTIONS);
    const labels = {
      available: 'Model ready',
      downloadable: 'Model will download on first run',
      downloading: 'Model downloading…',
      unavailable: 'Model unavailable on this device',
    };
    setStatus(labels[a] || a, a === 'unavailable');
    return a;
  } catch (e) {
    setStatus('Availability check failed: ' + e.message, true);
    return 'unavailable';
  }
}

// ---------- page content ----------
const URL_RE = /https?:\/\/[^\s<>"')]+/i;
const SYSTEM_PROMPT =
  'You answer the user\'s question about a web page. The page content is provided in the message. ' +
  'Base your answer on that content and say so if it does not contain the answer.';

function isHttpUrl(u) {
  try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshSubject() {
  const tab = await getActiveTab().catch(() => null);
  subjectEl.textContent = urlInput.value.trim()
    ? 'Subject: the URL below'
    : tab?.url ? `Subject: ${tab.title || tab.url}` : 'Subject: (no page open)';
}

// Text of the page currently open in the active tab.
async function readActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id || !isHttpUrl(tab.url || '')) {
    throw new Error('The open page can\'t be read (only http/https pages are supported). Enter a URL instead.');
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      text: (window.getSelection().toString().trim() || document.body.innerText || '').trim(),
    }),
  });
  return { url: tab.url, title: res.result.title || tab.title || tab.url, text: res.result.text };
}

// Text of an arbitrary URL, fetched with the extension's host permission.
async function readUrl(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Fetching ${url} failed: HTTP ${resp.status}`);
  const type = resp.headers.get('content-type') || '';
  const body = await resp.text();
  if (!/html/i.test(type)) return { url, title: url, text: body.trim() };
  const doc = new DOMParser().parseFromString(body, 'text/html');
  doc.querySelectorAll('script, style, noscript, template, svg').forEach((n) => n.remove());
  const text = (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { url, title: doc.title || url, text };
}

// Resolve the subject for an entry: explicit URL, else URL in the query text, else the open page.
async function loadSubject(entry, signal) {
  const url = entry.url || entry.prompt.match(URL_RE)?.[0];
  return url ? readUrl(url, signal) : readActiveTab();
}

function buildPrompt(entry, page, session) {
  const header = `Page title: ${page.title}\nPage URL: ${page.url}\n\nPage content:\n"""\n`;
  const footer = `\n"""\n\nQuestion: ${entry.prompt}`;
  // inputQuota is in tokens; assume ~3 characters per token to stay safely under it.
  const budget = Math.max(1000, Math.floor((session.inputQuota - session.inputUsage) * 3) - 1200);
  const room = Math.max(0, budget - header.length - footer.length - SYSTEM_PROMPT.length);
  const truncated = page.text.length > room;
  const text = truncated ? page.text.slice(0, room) + '\n[…content truncated…]' : page.text;
  return header + text + footer;
}

// Runs a prompt against a fresh session (no carried-over history), streaming into the entry.
async function runQuery(entry) {
  if (runningId) return;
  runningId = entry.id;
  controller = new AbortController();
  const { signal } = controller;
  entry.response = '';
  entry.error = null;
  entry.lastRunAt = Date.now();
  entry.runCount = (entry.runCount || 0) + 1;
  setRunning(true);
  render();

  let session;
  try {
    if ((await checkAvailability()) === 'unavailable') {
      throw new Error('The on-device model is not available.');
    }
    session = await LanguageModel.create({
      ...LM_OPTIONS,
      signal,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          progressEl.hidden = false;
          progressEl.value = e.loaded;
          setStatus(`Downloading model… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
    progressEl.hidden = true;
    setStatus('Reading page…');
    const page = await loadSubject(entry, signal);
    entry.source = { url: page.url, title: page.title };
    render();
    if (!page.text) throw new Error('The page has no readable text.');
    setStatus('Generating…');
    for await (const chunk of session.promptStreaming(buildPrompt(entry, page, session), { signal })) {
      entry.response += chunk;
      updateResponse(entry);
    }
    setStatus('Done');
  } catch (e) {
    if (signal.aborted) {
      setStatus('Stopped');
    } else {
      entry.error = e.message || String(e);
      setStatus('Error', true);
    }
  } finally {
    session?.destroy();
    progressEl.hidden = true;
    runningId = null;
    controller = null;
    setRunning(false);
    await save();
    render();
  }
}

function setRunning(on) {
  runBtn.disabled = on;
  stopBtn.hidden = !on;
  document.querySelectorAll('li button[data-act="rerun"]').forEach((b) => (b.disabled = on));
}

// ---------- rendering ----------
function updateResponse(entry) {
  const el = historyEl.querySelector(`li[data-id="${entry.id}"] .a`);
  if (el) el.textContent = entry.response;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function render() {
  historyEl.replaceChildren();
  countEl.textContent = queries.length ? `(${queries.length})` : '';
  emptyEl.hidden = queries.length > 0;
  $('clear-btn').hidden = queries.length === 0;

  for (const q of queries) {
    const busy = q.id === runningId;
    const li = el('li', { className: busy ? 'running' : '' });
    li.dataset.id = q.id;

    const answer = el('div', { className: 'a' + (q.error ? ' err' : '') });
    answer.textContent = q.error ? 'Error: ' + q.error : q.response || (busy ? '…' : '(no response)');

    const when = new Date(q.lastRunAt || q.createdAt).toLocaleString();
    const meta = el('div', { className: 'meta', textContent: `Last run ${when} · ${q.runCount || 0} run(s)` });

    const rerun = el('button', { textContent: busy ? 'Running…' : 'Re-run', disabled: !!runningId });
    rerun.dataset.act = 'rerun';
    const edit = el('button', { textContent: 'Edit' });
    edit.dataset.act = 'edit';
    const copy = el('button', { textContent: 'Copy' });
    copy.dataset.act = 'copy';
    const del = el('button', { textContent: 'Delete', className: 'danger', disabled: busy });
    del.dataset.act = 'delete';

    li.append(
      el('div', { className: 'q', textContent: q.prompt }),
      el('div', { className: 'src', textContent: q.source ? `Page: ${q.source.title} — ${q.source.url}` : q.url ? `Page: ${q.url}` : 'Page: the open page when run' }),
      answer,
      meta,
      el('div', { className: 'actions' }, rerun, edit, copy, del),
    );
    historyEl.append(li);
  }
}

// ---------- events ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || runningId) return;
  if (urlInput.value.trim() && !isHttpUrl(urlInput.value.trim())) {
    setStatus('Enter a valid http(s) URL', true);
    return;
  }
  const entry = {
    id: crypto.randomUUID(),
    prompt,
    url: urlInput.value.trim() || null,
    response: '',
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
  };
  queries.unshift(entry);
  input.value = '';
  urlInput.value = '';
  refreshSubject();
  await save();
  runQuery(entry);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

stopBtn.addEventListener('click', () => controller?.abort());

historyEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const entry = queries.find((q) => q.id === id);
  if (!entry) return;

  switch (btn.dataset.act) {
    case 'rerun':
      runQuery(entry);
      break;
    case 'edit':
      input.value = entry.prompt;
      urlInput.value = entry.url || '';
      refreshSubject();
      input.focus();
      break;
    case 'copy':
      await navigator.clipboard.writeText(entry.response || '');
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1000);
      break;
    case 'delete':
      queries = queries.filter((q) => q.id !== id);
      await save();
      render();
      break;
  }
});

$('clear-btn').addEventListener('click', async () => {
  if (runningId || !confirm('Delete all saved queries?')) return;
  queries = [];
  await save();
  render();
});

// Keep multiple open panels in sync. Echoes of our own writes are ignored: they can arrive
// late with a stale snapshot and would replace the entries (and responses) held in memory.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY] || runningId) return;
  const next = changes[STORAGE_KEY].newValue || [];
  if (ownWrites.has(JSON.stringify(next))) return;
  queries = next;
  render();
});

urlInput.addEventListener('input', refreshSubject);
chrome.tabs.onActivated.addListener(refreshSubject);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.title || info.url) refreshSubject(); });
chrome.windows.onFocusChanged.addListener(refreshSubject);

(async () => {
  await load();
  refreshSubject();
  render();
  checkAvailability();
})();
