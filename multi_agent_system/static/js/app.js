// Agent — Frontend

let messagesEl, emptyEl;
let conversation = [];
let pendingFiles  = [];
let currentSessionId = null;
let currentAbort = null;
let msgCounter = 0;
let allCodeBlocks = [];

// ── INLINE TASK TRACKING ──
// Each running task is tracked by its DOM elements — no global panel needed.
// task_id → { barEl, dotEl, labelEl, timerEl, stopBtn, startTime, intervalId }
const _taskMap = new Map();

function _startInlineTask(task_id, barEl, dotEl, labelEl, timerEl, stopBtn) {
  const startTime = Date.now();
  barEl.style.display = 'flex';

  function tick() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60);
    timerEl.textContent = m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }
  const intervalId = setInterval(tick, 1000);
  tick();

  stopBtn.addEventListener('click', () => stopInlineTask(task_id));
  _taskMap.set(task_id, { barEl, dotEl, labelEl, timerEl, stopBtn, startTime, intervalId });
}

function _finishInlineTask(task_id, stopped = false) {
  const t = _taskMap.get(task_id);
  if (!t) return;
  clearInterval(t.intervalId);
  t.dotEl.className = 'task-dot task-dot-done';
  t.labelEl.textContent = stopped ? 'Stopped' : 'Done';
  t.labelEl.className = 'task-label ' + (stopped ? 'task-stopped' : 'task-done');
  t.stopBtn.style.display = 'none';
  _taskMap.delete(task_id);
}

async function stopInlineTask(task_id) {
  try {
    await fetch(`/api/tasks/${task_id}/stop`, { method: 'POST' });
    _finishInlineTask(task_id, true);
    showToast('Task stopped');
  } catch (e) { showToast('Failed to stop: ' + e.message); }
}

async function reconnectTask(task_id, contentEl, agentTag) {
  const bar = document.getElementById('reconnect-bar-' + task_id);
  if (bar) bar.remove();

  contentEl.innerHTML = '<span class="cursor"></span>';
  setStatus('Reconnecting...', 'thinking');

  try {
    const res = await fetch(`/api/tasks/${task_id}/stream`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', fullText = '', searchHtml = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6).trim());
          if (d.type === 'task_id') continue;
          if (d.type === 'agent' && d.agent) agentTag.textContent = d.agent.replace('Agent','').toLowerCase();
          if (d.type === 'content' && d.content) {
            fullText += d.content;
            contentEl.innerHTML = formatContent(fullText) + searchHtml + '<span class="cursor"></span>';
            scrollToBottom();
          }
          if (d.type === 'search_result' && d.results) {
            searchHtml = _buildSearchHtml(d.results);
            contentEl.innerHTML = formatContent(fullText) + searchHtml + '<span class="cursor"></span>';
            scrollToBottom();
          }
        } catch(_) {}
      }
    }
    const cursor = contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    if (!fullText && !searchHtml) contentEl.innerHTML = '<span style="color:var(--text3)">Task completed (no new output).</span>';
  } catch (e) {
    contentEl.innerHTML = `<span style="color:var(--orange)">Reconnect error: ${escapeHtml(e.message)}</span>`;
    const c = contentEl.querySelector('.cursor'); if (c) c.remove();
  } finally {
    setStatus('Ready', 'ready');
  }
}

function _buildSearchHtml(results) {
  let html = '<br><div class="search-header">WEB RESULTS</div>';
  results.forEach(r => {
    const url = r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">↗ ${escapeHtml(r.url.replace(/^https?:\/\//,'').slice(0,50))}</a>` : '';
    html += `<div class="search-result">
      <div class="search-result-title">${escapeHtml(r.title||'')}</div>
      <div class="search-result-snippet">${escapeHtml(r.snippet||'')}</div>
      ${url ? `<div class="search-result-url">${url}</div>` : ''}
    </div>`;
  });
  return html;
}

// ── GITHUB IMPORT ──
let _gitRepoContext = null;

async function importGitRepo() {
  const input  = document.getElementById('git-url-input');
  const btn    = document.getElementById('git-import-btn');
  const status = document.getElementById('git-import-status');
  const url    = input.value.trim();
  if (!url) { input.focus(); return; }

  btn.disabled = true;
  status.className = 'busy';
  status.textContent = 'Cloning...';

  try {
    const res  = await fetch('/api/import-github', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({ url })
    });
    const data = await res.json();

    if (!data.success) {
      status.className = 'err';
      status.textContent = data.error || 'Import failed';
      btn.disabled = false;
      return;
    }

    _gitRepoContext = data.context;
    status.className = 'ok';
    status.textContent = `✓ ${data.files_read} files · ${data.total_size_kb}KB`;
    showMessages();
    messagesEl.appendChild(_buildRepoCard(data));
    scrollToBottom();
    input.value = '';
    enableSend();

    const autoPrompt = `I just imported the repository "${data.repo_name}" from GitHub. It has ${data.files_read} files. Please explore the codebase and give me a high-level overview: what it does, the architecture, key files, dependencies, and anything interesting or notable.`;
    document.getElementById('chat-input').value = autoPrompt;
    document.getElementById('chat-input').dispatchEvent(new Event('input'));
    document.getElementById('chat-input').focus();
  } catch (e) {
    status.className = 'err';
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function _buildRepoCard(data) {
  const div = document.createElement('div');
  div.className = 'repo-import-card';
  const tree = data.file_tree.slice(0, 30).join('\n') + (data.file_tree.length > 30 ? `\n... and ${data.file_tree.length-30} more` : '');
  div.innerHTML = `
    <div class="repo-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
      </svg>
    </div>
    <div class="repo-card-body">
      <div class="repo-card-title">✓ Successfully imported from GitHub</div>
      <div class="repo-card-meta">
        <span class="repo-meta-item"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${data.files_read} files</span>
        <span class="repo-meta-item"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg> ${data.total_size_kb}KB</span>
        ${data.files_skipped ? `<span class="repo-meta-item" style="color:var(--text3)">${data.files_skipped} skipped</span>` : ''}
        <span class="repo-meta-item"><a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:11px">${escapeHtml(data.url)} ↗</a></span>
      </div>
      <div class="repo-card-tree">${escapeHtml(tree)}</div>
    </div>`;
  return div;
}

// ── HISTORY ──
const HISTORY_KEY = 'agent_history';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(h) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {} }

function saveSession(session) {
  const h = loadHistory();
  const idx = h.findIndex(s => s.id === session.id);
  if (idx >= 0) h[idx] = session; else h.unshift(session);
  saveHistory(h.slice(0, 100));
}
function deleteSession(id) {
  saveHistory(loadHistory().filter(s => s.id !== id));
  if (currentSessionId === id) { currentSessionId = null; }
  renderHistoryList();
}

function openHistory()  { renderHistoryList(); document.getElementById('history-drawer').classList.add('open'); document.getElementById('history-overlay').classList.add('open'); }
function closeHistory() { document.getElementById('history-drawer').classList.remove('open'); document.getElementById('history-overlay').classList.remove('open'); }
function newChat()      { closeHistory(); clearChat(); }

function loadSession(id) {
  const h = loadHistory();
  const session = h.find(s => s.id === id);
  if (!session) return;
  closeHistory();
  // Clear everything for this session — fully independent
  clearChat(false);
  currentSessionId = id;
  conversation = [...(session.conversation || [])];
  allCodeBlocks = [];
  _gitRepoContext = null;
  showMessages();
  (session.messages || []).forEach(m => {
    if (m.role === 'user') {
      _renderUserBubble(m.content, m.time, m.fileName);
    } else {
      const bubble = _renderAIBubble(m.content, m.time, m.agent || 'coordinator');
      // If this message had an unfinished background task, show reconnect option
      if (m.task_id && !m.task_done) {
        _addReconnectBar(bubble, m.task_id);
      }
    }
  });
  scrollToBottom();
}

function _addReconnectBar(bubbleEl, task_id) {
  const body = bubbleEl.querySelector('.msg-body');
  if (!body) return;
  const bar = document.createElement('div');
  bar.className = 'reconnect-bar';
  bar.id = 'reconnect-bar-' + task_id;
  bar.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>
    <span>Task may still be running</span>
    <button class="reconnect-btn" onclick="reconnectTaskFromHistory('${task_id}', this)">Reconnect</button>
  `;
  body.appendChild(bar);
}

function reconnectTaskFromHistory(task_id, btn) {
  const bar = btn.closest('.reconnect-bar');
  const body = bar?.parentElement;
  if (!body) return;
  bar.remove();
  // Find or create a content el in this bubble
  const contentEl = body.querySelector('.msg-content');
  const agentTag  = body.querySelector('.agent-tag');
  if (contentEl && agentTag) reconnectTask(task_id, contentEl, agentTag);
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  const h = loadHistory();
  if (!h.length) { list.innerHTML = '<div class="history-empty">No conversations yet.</div>'; return; }
  const today = new Date(); today.setHours(0,0,0,0);
  const yest  = new Date(today); yest.setDate(yest.getDate()-1);
  const groups = {};
  h.forEach(s => {
    const d = new Date(s.timestamp); d.setHours(0,0,0,0);
    const label = d.getTime() === today.getTime() ? 'Today' : d.getTime() === yest.getTime() ? 'Yesterday' : d.toLocaleDateString([],{month:'short',day:'numeric'});
    if (!groups[label]) groups[label] = [];
    groups[label].push(s);
  });
  let html = '';
  for (const [label, sessions] of Object.entries(groups)) {
    html += `<div class="history-section-label">${label}</div>`;
    sessions.forEach(s => {
      const active = s.id === currentSessionId ? ' active' : '';
      html += `<div class="history-item${active}" onclick="loadSession('${s.id}')">
        <div class="history-item-text">
          <div class="history-item-title">${escapeHtml(s.title||'Untitled')}</div>
          <div class="history-item-meta">${new Date(s.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <button class="history-item-del" onclick="event.stopPropagation();deleteSession('${s.id}')" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    });
  }
  list.innerHTML = html;
}

// ── FILE HANDLING ──
async function handleFileSelect(input) {
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length) return;
  const btn = document.querySelector('.attach-btn');
  btn.style.opacity = '0.5';
  for (const file of files) await uploadFile(file);
  btn.style.opacity = '';
  updateFileBar();
  enableSend();
}

async function uploadFile(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res  = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) pendingFiles.push(data);
  } catch (e) { console.error('Upload:', e); }
}

function updateFileBar() {
  const bar   = document.getElementById('file-bar');
  const chips = document.getElementById('file-chips');
  const btn   = document.querySelector('.attach-btn');
  if (!pendingFiles.length) { bar.style.display = 'none'; btn.classList.remove('has-files'); return; }
  bar.style.display = 'block';
  btn.classList.add('has-files');
  chips.innerHTML = pendingFiles.map((f, i) => {
    const icon = f.type === 'image' ? '🖼️' : f.ext === 'zip' ? '📦' : '📄';
    return `<div class="file-chip">
      <span>${icon}</span>
      <span class="file-chip-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
      <span style="color:var(--text3);font-size:11px">${formatBytes(f.size)}</span>
      ${f.type !== 'image' && f.saved_path ? `<button class="file-chip-action" onclick="runFile(${i})" title="Run file">▶</button>` : ''}
      <button class="file-chip-remove" onclick="removeFile(${i})">×</button>
    </div>`;
  }).join('');
}

function removeFile(idx) { pendingFiles.splice(idx, 1); updateFileBar(); enableSend(); }

async function runFile(idx) {
  const f = pendingFiles[idx];
  if (!f || !f.saved_path) return;
  showMessages();
  _renderUserBubble(`run: ${f.filename}`, ts(), f.filename);
  conversation.push({ role: 'user', content: `Run the file: ${f.filename}` });
  const streamEl = _createStreamEl();
  setStatus('Running...', 'thinking');
  try {
    const res = await fetch('/api/run-file', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: f.saved_path }) });
    const data = await res.json();
    const out = data.stdout || data.output || data.error || JSON.stringify(data);
    streamEl.contentEl.innerHTML = formatContent('```\n' + out + '\n```');
    streamEl.agentTag.textContent = 'shell';
    conversation.push({ role: 'assistant', content: out });
  } catch (e) {
    streamEl.contentEl.innerHTML = `<span style="color:var(--orange)">Error: ${escapeHtml(e.message)}</span>`;
  } finally { setStatus('Ready', 'ready'); }
}

// ── DRAG AND DROP ──
function initDragDrop() {
  const app = document.getElementById('app');
  app.addEventListener('dragover', e => { e.preventDefault(); app.classList.add('drag-over'); });
  app.addEventListener('dragleave', e => { if (!app.contains(e.relatedTarget)) app.classList.remove('drag-over'); });
  app.addEventListener('drop', async e => {
    e.preventDefault();
    app.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const btn = document.querySelector('.attach-btn');
    btn.style.opacity = '0.5';
    for (const file of files) await uploadFile(file);
    btn.style.opacity = '';
    updateFileBar();
    enableSend();
  });
}

// ── LIVE CODE PREVIEW ──
let _previewCode = '';
let _previewFullscreen = false;

function openPreview(id) {
  const el = document.getElementById(id);
  if (!el) return;
  _previewCode = el.innerText;
  _loadPreview(_previewCode);
  document.getElementById('preview-overlay').classList.add('open');
  document.getElementById('preview-modal').classList.add('open');
  document.getElementById('preview-label').textContent = 'Live Preview';
  setViewport('desktop', document.querySelector('.viewport-btn'));
}

function _loadPreview(html) {
  const iframe = document.getElementById('preview-iframe');
  iframe.srcdoc = html;
}

function closePreview() {
  document.getElementById('preview-overlay').classList.remove('open');
  document.getElementById('preview-modal').classList.remove('open');
  _previewFullscreen = false;
  document.getElementById('preview-modal').classList.remove('fullscreen');
  document.getElementById('preview-frame-wrap').classList.remove('padded');
}

function togglePreviewSize() {
  const modal = document.getElementById('preview-modal');
  _previewFullscreen = !_previewFullscreen;
  modal.classList.toggle('fullscreen', _previewFullscreen);
  const btn = document.getElementById('preview-resize-btn');
  btn.title = _previewFullscreen ? 'Restore' : 'Expand';
}

function setViewport(size, btn) {
  const iframe = document.getElementById('preview-iframe');
  const wrap   = document.getElementById('preview-frame-wrap');
  const dims   = document.getElementById('preview-dims');
  document.querySelectorAll('.viewport-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  iframe.classList.remove('mobile-view', 'tablet-view');
  if (size === 'mobile') {
    iframe.classList.add('mobile-view');
    wrap.classList.add('padded');
    dims.textContent = '390 × 844';
  } else if (size === 'tablet') {
    iframe.classList.add('tablet-view');
    wrap.classList.add('padded');
    dims.textContent = '768 × 1024';
  } else {
    wrap.classList.remove('padded');
    dims.textContent = 'Full width';
  }
}

function openPreviewTab() {
  const blob = new Blob([_previewCode], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadPreview() {
  downloadText(_previewCode, 'preview.html');
}

// ── HELPERS ──
function ts() { return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(t) { if (typeof t !== 'string') return ''; return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeHtmlRaw(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatBytes(b) { if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(1)+'MB'; }

function extForLang(lang) {
  return {
    python:'py', py:'py', javascript:'js', js:'js', typescript:'ts', ts:'ts',
    bash:'sh', sh:'sh', shell:'sh', html:'html', htm:'html', css:'css',
    json:'json', yaml:'yml', yml:'yml', sql:'sql', rust:'rs', go:'go',
    java:'java', cpp:'cpp', c:'c', php:'php', ruby:'rb', swift:'swift',
  }[lang.toLowerCase()] || 'txt';
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function generateLink(id, lang) {
  const el = document.getElementById(id);
  if (!el) return;
  const code = el.innerText;
  const ext = extForLang(lang);
  const isHtml = ['html','htm'].includes(ext);
  const mime = isHtml ? 'text/html' : 'text/plain';
  const blob = new Blob([code], { type: mime });
  const url = URL.createObjectURL(blob);
  const toast = document.createElement('div');
  toast.className = 'link-toast';
  toast.innerHTML = `
    <span>Link generated (session only):</span>
    <a href="${url}" target="_blank" rel="noopener">${isHtml ? 'Open in browser' : 'Open file'} ↗</a>
    <button onclick="navigator.clipboard.writeText('${url}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy URL',1500)})">Copy URL</button>
    <button onclick="this.parentElement.remove()" style="color:var(--text3)">✕</button>
  `;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 12000);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function downloadSessionZip() {
  if (!allCodeBlocks.length) { showToast('No code blocks to download yet.'); return; }
  try {
    const res = await fetch('/api/generate-zip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ files: allCodeBlocks })
    });
    if (!res.ok) throw new Error('Server error');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'agent_code.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch(e) {
    showToast('Downloading files individually...');
    allCodeBlocks.forEach(f => downloadText(f.content, f.filename));
  }
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'link-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),400); }, 3000);
}

// ── FORMAT CONTENT ──
function formatContent(text) {
  if (typeof text !== 'string') return '<pre>' + escapeHtml(JSON.stringify(text, null, 2)) + '</pre>';

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id   = 'cb' + Math.random().toString(36).slice(2,9);
    const l    = (lang || '').toLowerCase().trim();
    const ext  = extForLang(l || 'txt');
    const isHtml = ['html','htm','svg'].includes(l);
    const canRun = ['python','py','js','javascript','sh','bash','shell'].includes(l);
    const filename = `code_${id}.${ext}`;
    allCodeBlocks.push({ filename, content: code.trim(), lang: l });
    return `<div class="code-block">
      <div class="code-header">
        <span class="code-lang">${escapeHtml(l||'code')}</span>
        <div class="code-actions">
          <button class="code-btn copy-btn" onclick="copyCode('${id}',this)" title="Copy code">📋 Copy</button>
          <button class="code-btn" onclick="downloadText(document.getElementById('${id}').innerText,'${filename}')" title="Download file">⬇ Download</button>
          ${isHtml ? `<button class="code-btn code-preview" onclick="openPreview('${id}')" title="Preview HTML">👁 Preview</button>` : ''}
          <button class="code-btn" onclick="generateLink('${id}','${l}')" title="Generate link">🔗 Link</button>
          ${canRun ? `<button class="code-btn code-run" onclick="runCodeBlock('${id}','${l}')" title="Execute code">▶ Run</button>` : ''}
        </div>
      </div>
      <pre id="${id}"><code>${escapeHtmlRaw(code.trim())}</code></pre>
    </div>`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/(^|[\s])(https?:\/\/[^\s<>"]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  text = text.replace(/^[-*•] (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  text = text.replace(/^---+$/gm, '<hr>');
  text = text.replace(/\n/g, '<br>');
  return text;
}

async function copyCode(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.innerText;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copied!';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 1800);
  }
}

async function runCodeBlock(id, lang) {
  const el = document.getElementById(id);
  if (!el) return;
  const code = el.innerText;
  const ext = { python:'py', py:'py', js:'js', javascript:'js', sh:'sh', bash:'sh', shell:'sh' }[lang.toLowerCase()] || 'sh';
  const runBtn = el.closest('.code-block')?.querySelector('.code-run');
  if (runBtn) { runBtn.textContent = '⏳ Running...'; runBtn.disabled = true; }
  try {
    const res = await fetch('/api/run-code', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ code, lang: ext })
    });
    const data = await res.json();
    const out = data.stdout || data.output || data.error || 'No output';
    const returncode = data.returncode;
    const label = returncode === 0 ? '✅ Output' : '❌ Error (exit '+returncode+')';
    showMessages();
    _renderAIBubble(`**${label}:**\n\`\`\`\n${out}\n\`\`\``, ts(), 'shell');
    conversation.push({ role: 'assistant', content: 'Code output:\n' + out });
    scrollToBottom();
  } catch (e) {
    _renderAIBubble('Error running code: ' + e.message, ts(), 'error');
  } finally {
    if (runBtn) { runBtn.textContent = '▶ Run'; runBtn.disabled = false; }
  }
}

function scrollToBottom() { const a = document.getElementById('chat-area'); if (a) a.scrollTop = a.scrollHeight; }
function showMessages()   { if (emptyEl) emptyEl.style.display = 'none'; if (messagesEl) messagesEl.style.display = 'flex'; }
function setStatus(text, mode='ready') {
  const p = document.getElementById('status-pill'), l = document.getElementById('status-text');
  if (!p || !l) return; p.className = 'status-pill '+mode; l.textContent = text;
}
function enableSend() {
  const i = document.getElementById('chat-input'), b = document.getElementById('send-btn');
  if (b) b.disabled = !i?.value.trim() && !pendingFiles.length;
}

// ── RENDER BUBBLES ──
function _renderUserBubble(text, time, fileName) {
  const div = document.createElement('div');
  div.className = 'message user-msg';
  const fileHtml = fileName ? `<div class="file-attach-chip">📎 ${escapeHtml(fileName)}</div>` : '';
  div.innerHTML = `
    <div class="msg-avatar user-avatar">U</div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">You</span><span class="msg-time">${time||ts()}</span></div>
      <div class="msg-content">${fileHtml}${escapeHtml(text)}</div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function _renderAIBubble(content, time, agent) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div class="msg-avatar ai-avatar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">Agent</span>
        <span class="msg-time">${time||ts()}</span>
        <span class="agent-tag">${escapeHtml(agent||'coordinator')}</span>
      </div>
      <div class="msg-content">${formatContent(content)}</div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function _createStreamEl() {
  const id = 'stream' + (++msgCounter);
  const div = document.createElement('div');
  div.className = 'message';
  div.id = id;
  div.innerHTML = `
    <div class="msg-avatar ai-avatar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">Agent</span>
        <span class="msg-time">${ts()}</span>
        <span class="agent-tag" id="at${id}">thinking</span>
      </div>
      <div class="msg-content" id="sc${id}"><span class="cursor"></span></div>
      <div class="task-bar" id="tb${id}" style="display:none">
        <div class="task-dot task-dot-running" id="td${id}"></div>
        <span class="task-label task-running" id="tl${id}">Running</span>
        <span class="task-timer" id="tt${id}">0s</span>
        <button class="task-stop-btn" id="tsb${id}">■ Stop</button>
      </div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return {
    msgEl:     div,
    contentEl: div.querySelector(`#sc${id}`),
    agentTag:  div.querySelector(`#at${id}`),
    taskBarEl: div.querySelector(`#tb${id}`),
    taskDotEl: div.querySelector(`#td${id}`),
    taskLabelEl: div.querySelector(`#tl${id}`),
    taskTimerEl: div.querySelector(`#tt${id}`),
    taskStopBtn: div.querySelector(`#tsb${id}`),
  };
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'message typing-msg';
  div.innerHTML = `
    <div class="msg-avatar ai-avatar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">Agent</span></div>
      <div class="msg-content"><div class="typing-dots"><span></span><span></span><span></span></div></div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// ── SEND ──
async function sendMessage() {
  const input  = document.getElementById('chat-input');
  const text   = input.value.trim();
  if (!text && !pendingFiles.length) return;

  if (currentAbort) { currentAbort.abort(); currentAbort = null; }

  const userText    = text || '(files attached)';
  const msgTime     = ts();
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  updateFileBar();

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  let fileContext = null, fileNames = null, imageB64 = null, imageMime = null;
  if (filesToSend.length) {
    const textFiles  = filesToSend.filter(f => f.type !== 'image');
    const imageFiles = filesToSend.filter(f => f.type === 'image');
    if (textFiles.length)  { fileContext = textFiles.map(f => `=== ${f.filename} ===\n${f.content}`).join('\n\n'); fileNames = filesToSend.map(f=>f.filename).join(', '); }
    if (imageFiles.length) { imageB64 = imageFiles[0].b64; imageMime = imageFiles[0].mime; if (!fileNames) fileNames = imageFiles[0].filename; }
  }

  showMessages();
  _renderUserBubble(userText, msgTime, fileNames);
  setStatus('Thinking...', 'thinking');

  // Ensure this chat has a session ID — new session = clean slate
  if (!currentSessionId) {
    currentSessionId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  const typingEl = addTyping();

  let combinedFileContext = fileContext || '';
  if (_gitRepoContext) {
    combinedFileContext = _gitRepoContext + (combinedFileContext ? '\n\n' + combinedFileContext : '');
    _gitRepoContext = null;
  }

  // Send only THIS session's conversation — fully isolated
  const conversationToSend = conversation.slice(-30);

  let currentTaskId = null;
  let taskBarEl, taskDotEl, taskLabelEl, taskTimerEl, taskStopBtn, contentEl, agentTag;

  try {
    currentAbort = new AbortController();
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      signal: currentAbort.signal,
      body: JSON.stringify({
        message: userText,
        conversation: conversationToSend,
        file_context: combinedFileContext || null,
        image_b64: imageB64,
        image_mime: imageMime
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    typingEl.remove();

    const streamEl = _createStreamEl();
    contentEl  = streamEl.contentEl;
    agentTag   = streamEl.agentTag;
    taskBarEl  = streamEl.taskBarEl;
    taskDotEl  = streamEl.taskDotEl;
    taskLabelEl = streamEl.taskLabelEl;
    taskTimerEl = streamEl.taskTimerEl;
    taskStopBtn = streamEl.taskStopBtn;

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = '', fullText = '', lastAgent = 'coordinator', searchHtml = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw);

          // Receive task ID → start inline task status bar
          if (d.type === 'task_id' && d.task_id) {
            currentTaskId = d.task_id;
            _startInlineTask(d.task_id, taskBarEl, taskDotEl, taskLabelEl, taskTimerEl, taskStopBtn);
            continue;
          }

          if (d.type === 'agent' && d.agent) {
            lastAgent = d.agent.replace('Agent','').toLowerCase();
            agentTag.textContent = lastAgent;
          }
          if (d.type === 'content' && d.content) {
            fullText += d.content;
            contentEl.innerHTML = formatContent(fullText) + searchHtml + '<span class="cursor"></span>';
            scrollToBottom();
          }
          if (d.type === 'search_result' && d.results) {
            searchHtml = _buildSearchHtml(d.results);
            contentEl.innerHTML = formatContent(fullText) + searchHtml + '<span class="cursor"></span>';
            scrollToBottom();
          }
          if (d.done && currentTaskId) {
            _finishInlineTask(currentTaskId, false);
          }
          if (d.error) {
            contentEl.innerHTML += `<br><span style="color:var(--orange)">Error: ${escapeHtml(d.error)}</span>`;
          }
        } catch(_) {}
      }
    }

    if (currentTaskId) _finishInlineTask(currentTaskId, false);

    const cursor = contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    if (!fullText && !searchHtml) contentEl.innerHTML = '<span style="color:var(--text3)">No response received.</span>';

    if (allCodeBlocks.length > 0) {
      const zipBtn = document.createElement('button');
      zipBtn.className = 'zip-btn';
      zipBtn.innerHTML = '📦 Download all code as ZIP';
      zipBtn.onclick = downloadSessionZip;
      contentEl.appendChild(document.createElement('br'));
      contentEl.appendChild(zipBtn);
    }

    // Update THIS session's conversation only
    conversation.push({ role: 'user', content: userText + (fileContext ? '\n\n[Files: '+fileNames+']' : '') });
    conversation.push({ role: 'assistant', content: fullText });

    // Save session — includes task_id so reconnect is possible on reload
    const existingH = loadHistory();
    const existing  = existingH.find(s => s.id === currentSessionId);
    const msgs = existing ? [...(existing.messages||[])] : [];
    msgs.push({ role:'user', content:userText, time:msgTime, fileName:fileNames });
    msgs.push({ role:'assistant', content:fullText, time:ts(), agent:lastAgent, task_id: currentTaskId || null, task_done: true });
    saveSession({
      id: currentSessionId,
      title: existing?.title || userText.slice(0,60),
      timestamp: existing?.timestamp || Date.now(),
      conversation: conversation.slice(-60),
      messages: msgs.slice(-200)
    });

  } catch (err) {
    if (err.name === 'AbortError') return;
    if (currentTaskId) _finishInlineTask(currentTaskId, true);
    typingEl.remove();
    const errEl = _createStreamEl();
    errEl.contentEl.innerHTML = `<span style="color:var(--orange)">Connection error: ${escapeHtml(err.message)}</span>`;
    errEl.agentTag.textContent = 'error';
    const c = errEl.contentEl.querySelector('.cursor'); if (c) c.remove();
  } finally {
    currentAbort = null;
    setStatus('Ready', 'ready');
    document.getElementById('send-btn').disabled = false;
    document.getElementById('chat-input').focus();
  }
}

function insertAndSend(text) {
  const i = document.getElementById('chat-input');
  i.value = text; i.dispatchEvent(new Event('input')); sendMessage();
}

function clearChat(resetSession=true) {
  if (messagesEl) messagesEl.innerHTML = '';
  if (emptyEl)    emptyEl.style.display = 'flex';
  if (messagesEl) messagesEl.style.display = 'flex';
  setStatus('Ready', 'ready');
  pendingFiles = [];
  allCodeBlocks = [];
  _gitRepoContext = null;
  // Cancel all active inline tasks for this session
  _taskMap.forEach((t, id) => {
    clearInterval(t.intervalId);
  });
  _taskMap.clear();
  updateFileBar();
  if (resetSession) {
    currentSessionId = null;
    conversation = [];
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  messagesEl = document.getElementById('messages');
  emptyEl    = document.getElementById('empty-state');

  const input = document.getElementById('chat-input');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    enableSend();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('preview-modal').classList.contains('open')) closePreview();
      else closeHistory();
    }
  });

  initDragDrop();
  initTerminal();
  initGitImport();
  input.focus();
});

function initGitImport() {
  const inp = document.getElementById('git-url-input');
  if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); importGitRepo(); }
  });
}

// ══════════════════════════════════════════
// ── TERMINAL PANEL ──
// ══════════════════════════════════════════

let _termOpen    = false;
let _termHistory = [];
let _termHistIdx = -1;
let _termCwd     = '/home/runner/workspace';
let _termBusy    = false;

function initTerminal() {
  const ti = document.getElementById('terminal-input');
  if (!ti) return;

  ti.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      termSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_termHistory.length) {
        _termHistIdx = Math.min(_termHistIdx + 1, _termHistory.length - 1);
        ti.value = _termHistory[_termHistory.length - 1 - _termHistIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      _termHistIdx = Math.max(_termHistIdx - 1, -1);
      ti.value = _termHistIdx < 0 ? '' : (_termHistory[_termHistory.length - 1 - _termHistIdx] || '');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      termClear();
    }
  });

  document.getElementById('terminal-bar')?.addEventListener('dblclick', () => {
    const panel = document.getElementById('terminal-panel');
    panel.classList.toggle('tall');
  });

  termPrint('info', 'Terminal ready — type any shell command and press Enter or Run');
  termPrint('info', 'Ctrl+L to clear · Arrow keys for history · Double-click bar to resize');
}

function toggleTerminal() {
  _termOpen = !_termOpen;
  const panel = document.getElementById('terminal-panel');
  const btn   = document.getElementById('terminal-toggle-btn');
  panel.classList.toggle('open', _termOpen);
  btn.classList.toggle('active', _termOpen);
  if (_termOpen) {
    setTimeout(() => document.getElementById('terminal-input')?.focus(), 280);
  }
}

function termClear() {
  const out = document.getElementById('terminal-output');
  if (out) out.innerHTML = '';
}

function termPrint(type, text) {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  text.split('\n').forEach(line => {
    const p = document.createElement('p');
    p.className = `term-line ${type}`;
    p.textContent = line;
    out.appendChild(p);
  });
  out.scrollTop = out.scrollHeight;
}

async function termSubmit() {
  const ti  = document.getElementById('terminal-input');
  const cmd = ti.value.trim();
  if (!cmd || _termBusy) return;

  ti.value = '';
  _termHistIdx = -1;
  _termHistory.push(cmd);
  if (_termHistory.length > 200) _termHistory.shift();

  if (cmd.startsWith('cd ')) {
    const dir = cmd.slice(3).trim();
    const target = dir.startsWith('/') ? dir : _termCwd + '/' + dir;
    try {
      const r = await fetch('/api/shell', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ command: `cd "${target}" && pwd` })
      });
      const d = await r.json();
      if (d.stdout && d.stdout.trim()) {
        _termCwd = d.stdout.trim();
        const cwdEl = document.getElementById('term-cwd');
        if (cwdEl) cwdEl.textContent = _termCwd;
        termPrint('cmd', `$ ${cmd}`);
        termPrint('ok', _termCwd);
      } else {
        termPrint('cmd', `$ ${cmd}`);
        termPrint('err', d.stderr || 'cd failed');
      }
    } catch(e) { termPrint('err', e.message); }
    return;
  }

  if (cmd === 'clear' || cmd === 'cls') { termClear(); return; }

  termPrint('cmd', `$ ${cmd}`);
  _termBusy = true;
  const runBtn = document.querySelector('.term-run-btn');
  if (runBtn) runBtn.disabled = true;

  try {
    const r = await fetch('/api/shell', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ command: cmd, cwd: _termCwd })
    });
    const d = await r.json();
    if (d.stdout && d.stdout.trim()) termPrint('out', d.stdout.trimEnd());
    if (d.stderr && d.stderr.trim()) termPrint('err', d.stderr.trimEnd());
    if (!d.stdout?.trim() && !d.stderr?.trim()) termPrint('info', '(no output)');
    const rc = d.returncode ?? (d.success ? 0 : 1);
    if (rc !== 0) termPrint('err', `[exit ${rc}]`);
    if (/^(cd|pushd|popd)/.test(cmd)) {
      try {
        const cr = await fetch('/api/shell', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ command: 'pwd', cwd: _termCwd })
        });
        const cd = await cr.json();
        if (cd.stdout?.trim()) {
          _termCwd = cd.stdout.trim();
          const cwdEl = document.getElementById('term-cwd');
          if (cwdEl) cwdEl.textContent = _termCwd;
        }
      } catch(_) {}
    }
  } catch(e) {
    termPrint('err', `Request failed: ${e.message}`);
  } finally {
    _termBusy = false;
    if (runBtn) runBtn.disabled = false;
    document.getElementById('terminal-input')?.focus();
  }
}

function terminalRun(cmd) {
  if (!_termOpen) toggleTerminal();
  const ti = document.getElementById('terminal-input');
  if (ti) ti.value = cmd;
  setTimeout(termSubmit, 300);
}
