'use strict';

const HEADER_COLORS = {
  text: '#AC8E68',
  link: '#0A84FF',
  code: '#2A2E37',
  image: '#64D2FF',
  file: '#FF9F0A',
};

const TYPE_LABELS = {
  text: 'Texto',
  link: 'Link',
  code: 'Código',
  image: 'Imagem',
  file: 'Arquivo',
};

const TYPE_TABS = [
  { key: 'favorites', label: 'Favoritos', dot: '#FFD60A' },
  { key: 'all', label: 'Tudo' },
  { key: 'text', label: 'Texto', dot: HEADER_COLORS.text },
  { key: 'image', label: 'Imagens', dot: HEADER_COLORS.image },
  { key: 'file', label: 'Arquivos', dot: HEADER_COLORS.file },
];

const ICONS = {
  pin: '<svg viewBox="0 0 16 16" fill="none"><path d="M9.5 2l4.5 4.5-2.2.55L8.6 10.3 8 14l-2.5-2.5L2 15l-1-1 3.5-3.5L2 8l3.7-.6 3.25-3.2L9.5 2z" fill="currentColor"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 11.5V14h2.5l7.5-7.5L9.5 4 2 11.5z" fill="currentColor"/><path d="M10.5 3l2.5 2.5 1-1c.4-.4.4-1 0-1.4L12.9 2c-.4-.4-1-.4-1.4 0l-1 1z" fill="currentColor"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  board: '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 2h9l5 5v15a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>',
};

const state = {
  clips: [],
  boards: [],
  caps: { xdotool: true },
  config: {},
  tab: 'all',
  query: '',
  focusIndex: 0,
  editingId: null,
  openPopId: null,
  capturing: false,
  pendingShortcut: 'Control+Alt+V',
};

const $ = (sel) => document.querySelector(sel);
const cardsEl = $('#cards');
const tabsEl = $('#tabs');
const searchEl = $('#search');
const editorEl = $('#editor');
const editorText = $('#editorText');
const boardModal = $('#boardModal');
const boardNameEl = $('#boardName');
const settingsEl = $('#settings');
const shortcutCaptureBtn = $('#shortcutCapture');
const setAutoPasteEl = $('#setAutoPaste');
const setPasteDelayEl = $('#setPasteDelay');
const setMaxItemsEl = $('#setMaxItems');

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function relTime(ts) {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 30) return 'agora';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

function normalize(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function basename(p) {
  return String(p).split('/').filter(Boolean).pop() || p;
}

function visibleClips() {
  const q = normalize(state.query.trim());
  return state.clips.filter((c) => {
    if (state.tab === 'favorites') {
      if (!c.pinned) return false;
    } else if (state.tab.startsWith('board:')) {
      if (!c.boardIds.includes(state.tab.slice(6))) return false;
    } else if (state.tab !== 'all' && c.type !== state.tab) {
      return false;
    }
    if (!q) return true;
    const hay = normalize(c.preview + ' ' + (c.files || []).map(basename).join(' '));
    return hay.includes(q);
  });
}

// ---------- render ----------

function renderTabs() {
  let html = TYPE_TABS.map((t) => `
    <span class="glass-chip glass-chip--tab ${state.tab === t.key ? 'is-active' : ''}" data-tab="${t.key}">
      ${t.dot ? `<i class="dot" style="--dot:${t.dot}"></i>` : ''}${t.label}
    </span>`).join('');
  html += state.boards.map((b) => `
    <span class="glass-chip glass-chip--tab ${state.tab === 'board:' + b.id ? 'is-active' : ''}" data-tab="board:${b.id}">
      <i class="dot" style="--dot:${b.color}"></i>${escapeHtml(b.name)}
      <button class="tab-del" data-delboard="${b.id}" title="Apagar board">×</button>
    </span>`).join('');
  html += '<span class="glass-chip glass-chip--circle" id="newBoard" title="Novo board">+</span>';
  tabsEl.innerHTML = html;
}

function cardBody(c) {
  if (c.type === 'image') {
    return `<div class="clip-card__body clip-card__body--media">
      <div class="clip-card__thumb"><img src="clp://img/${c.id}" alt="" /></div>
      <span>${TYPE_LABELS.image} · ${relTime(c.createdAt)}</span>
    </div>`;
  }
  if (c.type === 'file') {
    const name = escapeHtml(basename(c.files[0]));
    const count = c.files.length > 1 ? ` +${c.files.length - 1}` : '';
    let inner;
    let label = TYPE_LABELS.file;
    if (c.fileKind === 'image') {
      inner = `<div class="clip-card__thumb"><img src="clp://file/${c.id}/0" alt="" /></div>`;
      label = name;
    } else if (c.fileKind === 'video') {
      // transparent windows don't composite the video layer — thumbs come from an offscreen canvas
      const cached = thumbCache.get(c.id);
      if (cached === 'ERR') {
        inner = `<div class="clip-card__file">${ICONS.doc}<span>${name}${count}</span></div>`;
      } else if (cached) {
        inner = `<div class="clip-card__thumb"><img src="${cached}" alt="" /></div>`;
      } else {
        inner = `<div class="clip-card__thumb" data-vthumb="clp://file/${c.id}/0" data-clip="${c.id}"></div>`;
      }
      label = name;
    } else {
      inner = `<div class="clip-card__file">${ICONS.doc}<span>${name}${count}</span></div>`;
    }
    return `<div class="clip-card__body clip-card__body--media">
      ${inner}
      <span title="${escapeHtml(c.files.join('\n'))}">${label}${count} · ${relTime(c.createdAt)}</span>
    </div>`;
  }
  if (c.type === 'link') {
    let host = c.preview;
    try { host = new URL(c.preview).host; } catch {}
    return `<div class="clip-card__body">
      <div>
        <p class="clip-card__link-host">${escapeHtml(host)}</p>
        <p class="clip-card__link-url">${escapeHtml(c.preview)}</p>
      </div>
      <span>${TYPE_LABELS.link} · ${relTime(c.createdAt)}</span>
    </div>`;
  }
  const content = c.type === 'code'
    ? `<pre>${escapeHtml(c.preview)}</pre>`
    : `<p>${escapeHtml(c.preview)}</p>`;
  return `<div class="clip-card__body">
    ${content}
    <span>${TYPE_LABELS[c.type]} · ${relTime(c.createdAt)}</span>
  </div>`;
}

function cardActions(c) {
  const editable = c.type === 'text' || c.type === 'link' || c.type === 'code';
  return `<div class="clip-card__actions">
    <button data-act="pin" title="${c.pinned ? 'Desafixar' : 'Fixar'}">${ICONS.pin}</button>
    ${editable ? `<button data-act="edit" title="Editar">${ICONS.edit}</button>` : ''}
    ${c.type === 'file' ? `<button data-act="open" title="Abrir arquivo">${ICONS.open}</button>` : ''}
    <button data-act="board" title="Boards">${ICONS.board}</button>
    <button data-act="del" class="danger" title="Apagar">${ICONS.del}</button>
  </div>`;
}

function boardPop(c) {
  if (state.openPopId !== c.id) return '';
  const items = state.boards.map((b) => `
    <label><input type="checkbox" data-board="${b.id}" ${c.boardIds.includes(b.id) ? 'checked' : ''} />
      <i class="dot" style="--dot:${b.color}"></i>${escapeHtml(b.name)}</label>`).join('');
  return `<div class="board-pop">${items || '<span class="none">Crie um board no “+”</span>'}</div>`;
}

function render() {
  renderTabs();
  const visible = visibleClips();
  if (state.focusIndex >= visible.length) state.focusIndex = Math.max(0, visible.length - 1);

  if (!visible.length) {
    cardsEl.innerHTML = `<span class="empty glass-chip">${
      state.clips.length ? 'Nenhum resultado' : 'Nada copiado ainda — copie algo com Ctrl+C'
    }</span>`;
    return;
  }

  cardsEl.innerHTML = visible.map((c, i) => `
    <article class="clip-card ${i === state.focusIndex ? 'is-focused' : ''}"
             draggable="true"
             data-id="${c.id}" style="--header:${HEADER_COLORS[c.type]}">
      <header></header>
      ${cardBody(c)}
      ${i < 9 ? `<span class="clip-card__shortcut">${i + 1}</span>` : ''}
      ${c.pinned ? `<span class="clip-card__pin">${ICONS.pin}</span>` : ''}
      ${cardActions(c)}
      ${boardPop(c)}
    </article>`).join('');

  const focused = cardsEl.children[state.focusIndex];
  if (focused) focused.scrollIntoView({ inline: 'nearest', block: 'nearest' });

  // CSP blocks inline handlers — wire media fallbacks here
  cardsEl.querySelectorAll('[data-vthumb]').forEach((el) => requestVideoThumb(el.dataset.vthumb, el.dataset.clip));
  cardsEl.querySelectorAll('img').forEach((m) => {
    m.addEventListener('error', () => brokenThumb(m), { once: true });
  });
}

const thumbCache = new Map();
const thumbPending = new Set();
const thumbFails = new Map();

function brokenThumb(el) {
  const thumb = el.closest('.clip-card__thumb');
  if (thumb) thumb.outerHTML = `<div class="clip-card__file">${ICONS.doc}<span>arquivo indisponível</span></div>`;
}

// one decode per clip, ever — re-renders reuse the cached data URL
function requestVideoThumb(src, id) {
  if (thumbPending.has(id) || thumbCache.has(id)) return;
  thumbPending.add(id);
  const v = document.createElement('video');
  const done = (result) => {
    thumbCache.set(id, result);
    thumbPending.delete(id);
    v.removeAttribute('src');
    v.load();
    render();
  };
  v.muted = true;
  v.preload = 'metadata';
  v.src = src;
  v.addEventListener('loadedmetadata', () => {
    // 10% in (capped at 3s) — frame 0 of many videos is blank
    try { v.currentTime = Math.min((v.duration || 1) * 0.1, 3); } catch {}
  }, { once: true });
  v.addEventListener('seeked', () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 320;
      canvas.height = v.videoHeight || 180;
      canvas.getContext('2d').drawImage(v, 0, 0);
      thumbFails.delete(id);
      done(canvas.toDataURL('image/jpeg', 0.75));
    } catch {
      fail();
    }
  }, { once: true });
  v.addEventListener('error', fail, { once: true });

  // hiding the panel mid-decode aborts the <video> — retry on later renders, give up after 3
  function fail() {
    console.log(`vthumb fail id=${id} err=${v.error && v.error.code}:${v.error && v.error.message} state=${v.readyState} net=${v.networkState}`);
    const n = (thumbFails.get(id) || 0) + 1;
    thumbFails.set(id, n);
    if (n >= 3) { done('ERR'); return; }
    thumbPending.delete(id);
    v.removeAttribute('src');
    v.load();
  }
}

// ---------- overlays ----------

async function openEditor(id) {
  state.editingId = id;
  editorText.value = await window.clp.getText(id);
  editorEl.hidden = false;
  editorText.focus();
}

function closeEditor() {
  state.editingId = null;
  editorEl.hidden = true;
  searchEl.focus();
}

async function saveEditor() {
  const id = state.editingId;
  if (id) await window.clp.update(id, editorText.value);
  closeEditor();
}

function openBoardModal() {
  boardNameEl.value = '';
  boardModal.hidden = false;
  boardNameEl.focus();
}

function closeBoardModal() {
  boardModal.hidden = true;
  searchEl.focus();
}

async function createBoard() {
  const name = boardNameEl.value.trim();
  if (name) {
    const board = await window.clp.createBoard(name);
    state.tab = 'board:' + board.id;
  }
  closeBoardModal();
}

const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };

function fmtAccel(a) {
  return String(a).replace('Control', 'Ctrl').replace('Super', 'Meta');
}

function openSettings() {
  const c = state.config || {};
  state.pendingShortcut = c.shortcut || 'Control+Alt+V';
  state.capturing = false;
  shortcutCaptureBtn.classList.remove('capturing');
  shortcutCaptureBtn.textContent = fmtAccel(state.pendingShortcut);
  setAutoPasteEl.checked = c.autoPaste !== false;
  setPasteDelayEl.value = c.pasteDelayMs != null ? c.pasteDelayMs : 150;
  setMaxItemsEl.value = c.maxItems != null ? c.maxItems : 500;
  settingsEl.hidden = false;
}

function closeSettings() {
  settingsEl.hidden = true;
  state.capturing = false;
  searchEl.focus();
}

async function saveSettings() {
  await window.clp.setConfig({
    shortcut: state.pendingShortcut,
    autoPaste: setAutoPasteEl.checked,
    pasteDelayMs: Number(setPasteDelayEl.value),
    maxItems: Number(setMaxItemsEl.value),
  });
  closeSettings();
}

function overlayOpen() {
  return !editorEl.hidden || !boardModal.hidden || !settingsEl.hidden;
}

// ---------- events ----------

tabsEl.addEventListener('click', (e) => {
  const del = e.target.closest('[data-delboard]');
  if (del) { window.clp.deleteBoard(del.dataset.delboard); return; }
  if (e.target.closest('#newBoard')) { openBoardModal(); return; }
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  state.focusIndex = 0;
  render();
});

cardsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.clip-card');
  if (!card) return;
  const id = card.dataset.id;

  const boardCheck = e.target.closest('input[data-board]');
  if (boardCheck) {
    window.clp.assignBoard(id, boardCheck.dataset.board, boardCheck.checked);
    return;
  }
  if (e.target.closest('.board-pop')) return;

  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const clip = state.clips.find((c) => c.id === id);
    const act = btn.dataset.act;
    if (act === 'pin') window.clp.pin(id, !clip.pinned);
    else if (act === 'edit') openEditor(id);
    else if (act === 'open') window.clp.openFile(id);
    else if (act === 'del') { if (state.openPopId === id) state.openPopId = null; window.clp.remove(id); }
    else if (act === 'board') { state.openPopId = state.openPopId === id ? null : id; render(); }
    return;
  }

  window.clp.select(id);
});

document.addEventListener('click', (e) => {
  if (state.openPopId && !e.target.closest('.board-pop') && !e.target.closest('button[data-act="board"]')) {
    state.openPopId = null;
    render();
  }
  if (!overlayOpen() && !e.target.closest('input, textarea')) searchEl.focus();
});

cardsEl.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    cardsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  state.focusIndex = 0;
  render();
});

document.addEventListener('keydown', (e) => {
  if (overlayOpen()) {
    if (state.capturing) {
      e.preventDefault();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape') {
        state.capturing = false;
        shortcutCaptureBtn.classList.remove('capturing');
        shortcutCaptureBtn.textContent = fmtAccel(state.pendingShortcut);
        return;
      }
      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (!mods.length) return; // require a modifier — bare keys would hijack that key globally
      const key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      state.pendingShortcut = [...mods, key].join('+');
      state.capturing = false;
      shortcutCaptureBtn.classList.remove('capturing');
      shortcutCaptureBtn.textContent = fmtAccel(state.pendingShortcut);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); closeBoardModal(); closeSettings(); }
    else if (e.key === 'Enter' && !boardModal.hidden) { e.preventDefault(); createBoard(); }
    else if (e.key === 'Enter' && e.ctrlKey && !editorEl.hidden) { e.preventDefault(); saveEditor(); }
    else if (e.key === 'Enter' && e.ctrlKey && !settingsEl.hidden) { e.preventDefault(); saveSettings(); }
    return;
  }

  const visible = visibleClips();

  if (e.key === 'Escape') {
    if (state.openPopId) { state.openPopId = null; render(); }
    else window.clp.hide();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (visible[state.focusIndex]) window.clp.select(visible[state.focusIndex].id);
    return;
  }
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !searchEl.value) {
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    if (visible.length) {
      state.focusIndex = (state.focusIndex + delta + visible.length) % visible.length;
      render();
    }
    return;
  }
  if (/^[1-9]$/.test(e.key) && (e.ctrlKey || !searchEl.value)) {
    const clip = visible[Number(e.key) - 1];
    if (clip) { e.preventDefault(); window.clp.select(clip.id); }
    return;
  }
  const focusedClip = visible[state.focusIndex];
  if (e.key.toLowerCase() === 'e' && !searchEl.value && focusedClip) {
    if (['text', 'link', 'code'].includes(focusedClip.type)) { e.preventDefault(); openEditor(focusedClip.id); }
    else if (focusedClip.type === 'file') { e.preventDefault(); window.clp.openFile(focusedClip.id); }
    return;
  }
  if (e.key === 'Delete' && focusedClip) {
    e.preventDefault();
    if (state.openPopId === focusedClip.id) state.openPopId = null;
    window.clp.remove(focusedClip.id);
  }
});

$('#editorSave').addEventListener('click', saveEditor);
$('#editorCancel').addEventListener('click', closeEditor);
$('#boardCreate').addEventListener('click', createBoard);
$('#boardCancel').addEventListener('click', closeBoardModal);
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsSave').addEventListener('click', saveSettings);
$('#settingsCancel').addEventListener('click', closeSettings);
shortcutCaptureBtn.addEventListener('click', () => {
  state.capturing = true;
  shortcutCaptureBtn.classList.add('capturing');
  shortcutCaptureBtn.textContent = 'Pressione as teclas…';
});

// drag a card out: image/file → real file (path in a terminal); text → one line
cardsEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.clip-card');
  if (!card) return;
  const clip = state.clips.find((c) => c.id === card.dataset.id);
  if (!clip) return;
  if (clip.type === 'image' || clip.type === 'file') {
    e.preventDefault();
    window.clp.startDrag(clip.id);
  } else {
    // ponytail: drags the 300-char preview, newlines→spaces (terminal-safe). full-text prefetch if users drag long clips
    e.dataTransfer.setData('text/plain', (clip.preview || '').replace(/\r?\n/g, ' '));
    e.dataTransfer.effectAllowed = 'copy';
  }
});

// ---------- wiring ----------

function applySnapshot(snap) {
  state.clips = snap.clips;
  state.boards = snap.boards;
  state.caps = snap.caps;
  state.config = snap.config;
  if (state.tab.startsWith('board:') && !snap.boards.some((b) => 'board:' + b.id === state.tab)) {
    state.tab = 'all';
  }
  $('#shortcutHint').textContent = snap.config.shortcut.replace('Control', 'Ctrl');
  let hint = document.querySelector('.hint');
  if (!snap.caps.xdotool && !hint) {
    hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Instale xdotool para colar automaticamente: sudo apt install xdotool';
    document.querySelector('.shelf').appendChild(hint);
  } else if (snap.caps.xdotool && hint) {
    hint.remove();
  }
  render();
}

window.clp.onChanged(applySnapshot);
window.clp.onSettings(() => openSettings());

window.clp.onShown(() => {
  state.query = '';
  searchEl.value = '';
  state.tab = 'all';
  state.focusIndex = 0;
  state.openPopId = null;
  state.capturing = false;
  editorEl.hidden = true;
  boardModal.hidden = true;
  settingsEl.hidden = true;
  cardsEl.scrollLeft = 0;
  searchEl.focus();
  render();
});

setInterval(() => {
  if (!state.openPopId && !overlayOpen()) render();
}, 30000);

window.clp.get().then(applySnapshot);
searchEl.focus();
