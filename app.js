'use strict';

const STORAGE_KEY = 'todo-app.tasks.v1';
const PREFS_KEY = 'todo-app.prefs.v1';
const PRIORITY = {
  high: { label: '高', rank: 0 },
  medium: { label: '中', rank: 1 },
  low: { label: '低', rank: 2 },
};
const FILTERS = ['all', 'active', 'done'];
const SORTS = ['created', 'due', 'priority'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- storage ----------

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('保存に失敗しました:', err);
  }
}

function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function normalizeTask(t) {
  return {
    id: String(t.id || uid()),
    title: String(t.title).slice(0, 200),
    done: Boolean(t.done),
    priority: Object.hasOwn(PRIORITY, t.priority) ? t.priority : 'medium',
    due: DATE_RE.test(t.due) ? t.due : '',
    createdAt: Number(t.createdAt) || Date.now(),
  };
}

function loadTasks() {
  const data = readJSON(STORAGE_KEY, []);
  if (!Array.isArray(data)) return [];
  return data
    .filter((t) => t && typeof t.title === 'string' && t.title.trim())
    .map(normalizeTask);
}

const prefs = readJSON(PREFS_KEY, {}) || {};

const state = {
  tasks: loadTasks(),
  filter: FILTERS.includes(prefs.filter) ? prefs.filter : 'all',
  sort: SORTS.includes(prefs.sort) ? prefs.sort : 'created',
  query: '',
  editingId: null,
};

// 直前の破壊的操作(削除)を取り消すためのスナップショット
let undoSnapshot = null;
let toastTimer = null;

function saveTasks() {
  writeJSON(STORAGE_KEY, state.tasks);
}

function savePrefs() {
  writeJSON(PREFS_KEY, { filter: state.filter, sort: state.sort });
}

// ---------- dates ----------

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function describeDue(due) {
  if (!due) return null;
  const today = parseDateStr(toDateStr(new Date()));
  const diff = Math.round((parseDateStr(due) - today) / DAY_MS);
  const date = parseDateStr(due);
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  if (diff < 0) return { text: `期限切れ (${md})`, cls: 'overdue' };
  if (diff === 0) return { text: '今日まで', cls: 'soon' };
  if (diff === 1) return { text: '明日まで', cls: 'soon' };
  if (diff <= 7) return { text: `あと${diff}日 (${md})`, cls: '' };
  const label = date.getFullYear() === today.getFullYear() ? md : `${date.getFullYear()}/${md}`;
  return { text: `${label} まで`, cls: '' };
}

// ---------- mutations ----------

function commit({ undoable = false, message = '' } = {}) {
  saveTasks();
  if (undoable) {
    showToast(message);
  } else {
    undoSnapshot = null;
    hideToast();
  }
  render();
}

function addTask(title, due, priority) {
  state.tasks.push(normalizeTask({ title, due, priority, createdAt: Date.now() }));
  commit();
}

function updateTask(id, changes) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  Object.assign(task, changes);
  commit();
}

function deleteTasks(predicate, message) {
  const remaining = state.tasks.filter((t) => !predicate(t));
  const removed = state.tasks.length - remaining.length;
  if (removed === 0) return;
  undoSnapshot = state.tasks;
  state.tasks = remaining;
  commit({ undoable: true, message: message(removed) });
}

function undo() {
  if (!undoSnapshot) return;
  state.tasks = undoSnapshot;
  undoSnapshot = null;
  commit();
}

// ---------- view ----------

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $('#new-task-form'),
  title: $('#new-title'),
  due: $('#new-due'),
  priority: $('#new-priority'),
  list: $('#task-list'),
  empty: $('#empty'),
  summary: $('#summary'),
  progress: $('#progress-bar'),
  search: $('#search'),
  sort: $('#sort'),
  clearDone: $('#clear-done'),
  filters: document.querySelectorAll('[data-filter]'),
  toast: $('#toast'),
  toastMsg: $('#toast-msg'),
  toastUndo: $('#toast-undo'),
  taskTpl: $('#task-template'),
  editTpl: $('#edit-template'),
};

function visibleTasks() {
  const q = state.query.trim().toLowerCase();
  const list = state.tasks.filter((t) => {
    if (state.filter === 'active' && t.done) return false;
    if (state.filter === 'done' && !t.done) return false;
    return !q || t.title.toLowerCase().includes(q);
  });
  const newest = (a, b) => b.createdAt - a.createdAt;
  const comparators = {
    created: newest,
    due: (a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99') || newest(a, b),
    priority: (a, b) => PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || newest(a, b),
  };
  // 未完了を上、完了済みを下にまとめる
  return list.sort((a, b) => Number(a.done) - Number(b.done) || comparators[state.sort](a, b));
}

function renderTask(task) {
  const li = els.taskTpl.content.firstElementChild.cloneNode(true);
  li.dataset.id = task.id;
  li.dataset.priority = task.priority;
  li.classList.toggle('done', task.done);

  li.querySelector('.task-check').checked = task.done;
  li.querySelector('.task-title').textContent = task.title;

  const badge = li.querySelector('.priority');
  badge.textContent = `優先度 ${PRIORITY[task.priority].label}`;
  badge.classList.add(`priority-${task.priority}`);

  const dueEl = li.querySelector('.due');
  const due = describeDue(task.due);
  if (due) {
    dueEl.textContent = due.text;
    if (due.cls && !task.done) dueEl.classList.add(due.cls);
  } else {
    dueEl.remove();
  }
  return li;
}

function renderEditor(task) {
  const li = els.editTpl.content.firstElementChild.cloneNode(true);
  li.dataset.id = task.id;
  li.querySelector('.edit-title').value = task.title;
  li.querySelector('.edit-due').value = task.due;
  li.querySelector('.edit-priority').value = task.priority;
  return li;
}

function render() {
  const total = state.tasks.length;
  const doneCount = state.tasks.filter((t) => t.done).length;
  const remaining = total - doneCount;

  els.summary.textContent = total === 0
    ? 'タスクはまだありません'
    : remaining === 0
      ? `すべて完了しました 🎉 (${total}件)`
      : `残り ${remaining} 件 / 全 ${total} 件`;
  els.progress.style.width = total ? `${(doneCount / total) * 100}%` : '0';

  els.filters.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === state.filter));
  });
  els.sort.value = state.sort;
  els.clearDone.disabled = doneCount === 0;

  const tasks = visibleTasks();
  const frag = document.createDocumentFragment();
  for (const task of tasks) {
    frag.appendChild(task.id === state.editingId ? renderEditor(task) : renderTask(task));
  }
  els.list.replaceChildren(frag);

  els.empty.hidden = tasks.length > 0;
  if (tasks.length === 0) {
    els.empty.textContent = state.query.trim()
      ? `「${state.query.trim()}」に一致するタスクはありません`
      : { all: 'タスクを追加してみましょう', active: '未完了のタスクはありません', done: '完了したタスクはありません' }[state.filter];
  }

  if (state.editingId) {
    const input = els.list.querySelector('.edit-title');
    if (input && document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function startEdit(id) {
  state.editingId = id;
  render();
}

function stopEdit(focusId) {
  state.editingId = null;
  render();
  if (focusId) {
    els.list.querySelector(`[data-id="${CSS.escape(focusId)}"] .task-check`)?.focus();
  }
}

function showToast(message) {
  els.toastMsg.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    hideToast();
    undoSnapshot = null;
  }, 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  els.toast.hidden = true;
}

// ---------- events ----------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = els.title.value.trim();
  if (!title) {
    els.title.focus();
    return;
  }
  addTask(title, els.due.value, els.priority.value);
  els.title.value = '';
  els.due.value = '';
  els.priority.value = 'medium';
  els.title.focus();
});

els.list.addEventListener('change', (e) => {
  if (!e.target.classList.contains('task-check')) return;
  const id = e.target.closest('.task').dataset.id;
  updateTask(id, { done: e.target.checked });
});

els.list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('.task').dataset.id;
  switch (btn.dataset.action) {
    case 'edit':
      startEdit(id);
      break;
    case 'delete':
      if (state.editingId === id) state.editingId = null;
      deleteTasks((t) => t.id === id, () => 'タスクを削除しました');
      break;
    case 'cancel':
      stopEdit(id);
      break;
  }
});

els.list.addEventListener('dblclick', (e) => {
  const title = e.target.closest('.task-title');
  if (title) startEdit(title.closest('.task').dataset.id);
});

els.list.addEventListener('submit', (e) => {
  if (!e.target.classList.contains('edit-form')) return;
  e.preventDefault();
  const form = e.target;
  const id = form.closest('.task').dataset.id;
  const title = form.querySelector('.edit-title').value.trim();
  if (!title) return;
  state.editingId = null;
  updateTask(id, {
    title,
    due: form.querySelector('.edit-due').value,
    priority: form.querySelector('.edit-priority').value,
  });
  els.list.querySelector(`[data-id="${CSS.escape(id)}"] .task-check`)?.focus();
});

els.list.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.closest('.edit-form')) {
    e.preventDefault();
    stopEdit(state.editingId);
  }
});

els.filters.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    savePrefs();
    render();
  });
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  savePrefs();
  render();
});

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  render();
});

els.clearDone.addEventListener('click', () => {
  deleteTasks((t) => t.done, (n) => `完了済みのタスクを ${n} 件削除しました`);
});

els.toastUndo.addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  // 「/」で検索欄へ、Ctrl/Cmd+Z で削除の取り消し(入力中は除く)
  const typing = e.target.closest('input, textarea, select');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    els.search.focus();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !typing && undoSnapshot) {
    e.preventDefault();
    undo();
  }
});

// 日付が変わったら「今日まで」などの表示を更新する
let lastDay = toDateStr(new Date());
setInterval(() => {
  const today = toDateStr(new Date());
  if (today !== lastDay && !state.editingId) {
    lastDay = today;
    render();
  }
}, 60 * 1000);

// 別タブでの変更を反映する
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    state.tasks = loadTasks();
    if (!state.tasks.some((t) => t.id === state.editingId)) state.editingId = null;
    render();
  }
});

render();
