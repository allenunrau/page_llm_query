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

let queries = [];        // newest first
let runningId = null;    // id of the query currently being run
let controller = null;   // AbortController for the active run

// ---------- storage ----------
async function load() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  queries = data[STORAGE_KEY] || [];
}
function save() {
  return chrome.storage.local.set({ [STORAGE_KEY]: queries });
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
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          progressEl.hidden = false;
          progressEl.value = e.loaded;
          setStatus(`Downloading model… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
    progressEl.hidden = true;
    setStatus('Generating…');
    for await (const chunk of session.promptStreaming(entry.prompt, { signal })) {
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
  const entry = {
    id: crypto.randomUUID(),
    prompt,
    response: '',
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
  };
  queries.unshift(entry);
  input.value = '';
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

// Keep multiple open panels in sync (never overwrite the entry we're streaming into).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY] || runningId) return;
  queries = changes[STORAGE_KEY].newValue || [];
  render();
});

(async () => {
  await load();
  render();
  checkAvailability();
})();
