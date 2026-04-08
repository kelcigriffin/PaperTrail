// renderer.js
/* eslint-disable no-undef */

(() => {
  /** ---------------- Electron bridge with browser fallbacks ------------------ */
  const api = (() => {
    const ipc = window.electronAPI;

    const browserNotify = async ({ title, body }) => {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') {
        new Notification(title || 'PaperTrail', { body: body || '' });
        return true;
      }
      if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          new Notification(title || 'PaperTrail', { body: body || '' });
          return true;
        }
      }
      return false;
    };

    return {
      getAppInfo: ipc?.getAppInfo || (async () => ({ name: 'PaperTrail', version: '1.0.0', platform: 'browser' })),
      openExternal: ipc?.openExternal || (async (url) => { window.open(url, '_blank'); return true; }),
      notify: ipc?.notify || browserNotify,
      exportData: ipc?.exportData || (async (data) => {
        try {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `papertrail-backup-${new Date().toISOString().slice(0,10)}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          return { canceled: false, filePath: '(downloaded)' };
        } catch (e) {
          alert('Export failed: ' + (e?.message || String(e)));
          return { canceled: true, error: e?.message || String(e) };
        }
      }),
      importData: ipc?.importData || (async () => {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return resolve({ canceled: true });
            try {
              const text = await file.text();
              resolve({ canceled: false, data: JSON.parse(text) });
            } catch (e) {
              alert('Import failed: ' + (e?.message || String(e)));
              resolve({ canceled: true, error: e?.message || String(e) });
            }
          };
          input.click();
        });
      })
    };
  })();

  /** ---------------- Dialog polyfill (ensures showModal/close exist) -------- */
  function patchDialogs() {
    const dialogs = document.querySelectorAll('dialog');
    dialogs.forEach(d => {
      if (typeof d.showModal !== 'function') {
        d.showModal = function () {
          this.setAttribute('open', '');
          this.style.display = 'block';
          this.style.position = 'fixed';
          this.style.top = '10%';
          this.style.left = '50%';
          this.style.transform = 'translateX(-50%)';
          this.style.zIndex = '1000';
          if (!this._backdrop) {
            const bd = document.createElement('div');
            bd.style.position = 'fixed';
            bd.style.inset = '0';
            bd.style.background = 'rgba(0,0,0,0.25)';
            bd.style.zIndex = '999';
            bd.className = 'dialog-backdrop';
            if (this.id) bd.setAttribute('data-for', this.id);
            bd.addEventListener('click', () => this.close());
            document.body.appendChild(bd);
            this._backdrop = bd;
          } else {
            this._backdrop.style.display = 'block';
          }
        };
        d.close = function () {
          this.removeAttribute('open');
          this.style.display = 'none';
          if (this._backdrop) this._backdrop.style.display = 'none';
        };
      }
    });
  }

  /** ---------------- Backdrop cleanup (prevents stale overlays) -------------- */
  function removeZombieBackdrops(forDialogId = null) {
    const backs = document.querySelectorAll('.dialog-backdrop');
    backs.forEach(bd => {
      const matches = forDialogId ? (bd.getAttribute('data-for') === forDialogId) : true;
      if (!matches) return;
      const cs = getComputedStyle(bd);
      const isVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      if (isVisible && bd.parentNode) {
        bd.parentNode.removeChild(bd);
      }
    });
  }

  function activeFilterCount() {
  const f = cache.settings?.filters || { status:'all', priority:'all', sort:'due-asc' };
  let n = 0;
  if (f.status !== 'all') n++;
  if (f.priority !== 'all') n++;
  // We usually don't count 'sort' as a filter, but you can include it if you prefer:
  // if (f.sort !== 'due-asc') n++;
  return n;
}
function updateFiltersButtonLabel() {
  const btn = document.getElementById('btnFilters');
  if (!btn) return;
  const n = activeFilterCount();
  btn.textContent = n > 0 ? `Filters • ${n}` : 'Filters';
  btn.setAttribute('aria-expanded', document.getElementById('filtersPopover')?.style.display === 'block' ? 'true' : 'false');
}
function openFiltersPopover() {
  const pop = document.getElementById('filtersPopover');
  if (!pop) return;
  pop.style.display = 'block';
  updateFiltersButtonLabel();
}
function closeFiltersPopover() {
  const pop = document.getElementById('filtersPopover');
  if (!pop) return;
  pop.style.display = 'none';
  updateFiltersButtonLabel();
}
function rerenderCurrentView() {
  if (currentView?.type === 'today') {
    // Force Unified To‑Do to fully remount
    setView({ type: 'today' });
  } else {
    render();
  }
}
  /** ---------------- Review Page: state & helpers --------------------------- */
  const reviewState = {
    weekIndex: 0,          // 0 = current (to date); 1 = previous full week; etc.
    includeNotes: true,
    projectFilter: 'all'
  };

  function slugKey(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

  function startOfCurrentAnchorWeek(anchorWeekday) {
    const now = new Date();
    const d = new Date(now); d.setHours(0,0,0,0);
    const delta = ((d.getDay() - anchorWeekday + 7) % 7) || 7;
    d.setDate(d.getDate() - delta);
    return d;
  }
  function getWeekWindow(anchorWeekday, weekIndex = 0) {
    const start0 = startOfCurrentAnchorWeek(anchorWeekday);
    const start = new Date(start0);
    start.setDate(start.getDate() - 7 * weekIndex);
    let end;
    if (weekIndex === 0) {
      end = new Date(); // to-date
    } else {
      end = new Date(start);
      end.setDate(end.getDate() + 7);
      end.setHours(23,59,59,999);
    }
    const label = (weekIndex === 0)
      ? `This week (${fmt(start)} → ${fmt(end)})`
      : `${fmt(start)} → ${fmt(end)}`;
    return { start, end, label };
  }
  function getLastNWeekWindows(n, anchorWeekday) {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(getWeekWindow(anchorWeekday, i));
    return arr;
  }

  /** ---------------- IndexedDB minimal helper ------------------------------- */
  const DB_NAME = 'papertrail_db';
  const DB_VERSION = 3;
  const STORES = { projects: 'projects', tasks: 'tasks', notes: 'notes', completions: 'completions', settings: 'settings', metrics:'metrics' };
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.projects)) {
          const s = db.createObjectStore(STORES.projects, { keyPath: 'id' });
          s.createIndex('by_status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.tasks)) {
          const s = db.createObjectStore(STORES.tasks, { keyPath: 'id' });
          s.createIndex('by_project', 'projectId', { unique: false });
          s.createIndex('by_status', 'status', { unique: false });
          s.createIndex('by_type', 'type', { unique: false });
          s.createIndex('by_due', 'dueDate', { unique: false });
          s.createIndex('by_completed', 'completedDate', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.notes)) {
          const s = db.createObjectStore(STORES.notes, { keyPath: 'id' });
          s.createIndex('by_project', 'projectId', { unique: false });
          s.createIndex('by_created', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.completions)) {
          const s = db.createObjectStore(STORES.completions, { keyPath: 'id' });
          s.createIndex('by_task', 'taskId', { unique: false });
          s.createIndex('by_completedAt', 'completedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.settings)) {
          db.createObjectStore(STORES.settings, { keyPath: 'id' });
        }
        /* New: wellness metrics (sleep, mood, etc.) */
        if (!db.objectStoreNames.contains('metrics')) {
        const s = db.createObjectStore('metrics', { keyPath: 'id' });
        s.createIndex('by_date', 'date', { unique: false });
        s.createIndex('by_type', 'type', { unique: false });
        }

      };
      // req.onsuccess = () => resolve(req.result);

      req.onsuccess = () => {
    const database = req.result;
    // Defensive: if 'metrics' is missing (older/stale profile), do a one-step self-upgrade.
    if (!database.objectStoreNames.contains('metrics')) {
      try {
        const nextVersion = database.version + 1;
        database.close();
        const fix = indexedDB.open(DB_NAME, nextVersion);
        fix.onerror = () => {
          console.error('[DB] upgrade for metrics failed:', fix.error);
          // Fall back to existing handle to avoid blocking the app
          resolve(database);
        };
        fix.onupgradeneeded = () => {
          const db2 = fix.result;
          if (!db2.objectStoreNames.contains('metrics')) {
            const s = db2.createObjectStore('metrics', { keyPath: 'id' });
            s.createIndex('by_date', 'date', { unique: false });
            s.createIndex('by_type', 'type', { unique: false });
          }
        };
        fix.onsuccess = () => resolve(fix.result);
        return;
      } catch (e) {
        console.error('[DB] self-upgrade threw:', e);
      }
    }
    resolve(database);
  };

    });
  }
  function tx(storeNames, mode = 'readonly') {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    for (const s of (Array.isArray(storeNames) ? storeNames : [storeNames])) stores[s] = t.objectStore(s);
    return { t, stores };
  }
  const put = (store, val) => new Promise((res, rej) => { const r = store.put(val); r.onsuccess = () => res(val); r.onerror = () => rej(r.error); });
  const add = (store, val) => new Promise((res, rej) => { const r = store.add(val); r.onsuccess = () => res(val); r.onerror = () => rej(r.error); });
  const getAll = (store, idx = null, q = null) => new Promise((res, rej) => {
    const src = idx ? store.index(idx) : store;
    const r = src.getAll(q || null);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
  const delByKey = (store, key) => new Promise((res, rej) => { const r = store.delete(key); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });

  /** ---------------- Utils & State ----------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; const v = c === 'x' ? r : (r & 0x3) | 0x8; return v.toString(16); }); }

// Build a local YYYY-MM-DD without touching UTC
function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
  const todayISO = (d = new Date()) => ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
  const toISODate = (d) => (!d ? '' : ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate())));
  const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
  const addMonths = (date, n) => { const d = new Date(date); const m = d.getMonth() + n; const day = d.getDate(); d.setMonth(m); if (d.getDate() < day) d.setDate(0); return d; };
 
// ----- Month helpers (local time) -----
function firstDayOfMonth(d)        { return new Date(d.getFullYear(), d.getMonth(), 1); }
function firstDayOfNextMonth(d)    { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function lastCalendarDayOfMonth(y, m /* 0-based */) { return new Date(y, m + 1, 0); } // day 0 of next month
function lastAnchorWeekdayOfMonth(y, m, weekday /* 0..6, Sun=0 */) {
  const last = lastCalendarDayOfMonth(y, m);
  const diff = ((last.getDay() - weekday + 7) % 7);
  return new Date(y, m, last.getDate() - diff);
}

function getListVisibility(key) {
  return sessionStorage.getItem(key) !== 'hidden';
}

function setListVisibility(key, visible) {
  sessionStorage.setItem(key, visible ? 'visible' : 'hidden');
}

const fmt = (d, withTime = false) => {
  if (!d) return '';
  let dt;
  if (typeof d === 'string') {
    // If it's a date-only string, construct a local date to avoid UTC shifts
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split('-').map(Number);
      dt = new Date(y, m - 1, day); // local midnight
    } else {
      dt = new Date(d); // full ISO string with time -> let the browser parse
    }
  } else {
    dt = d;
  }
  return dt.toLocaleString(
    undefined,
    withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }
  );
};
  
  const clampToNextWeekday = (from, weekday) => {
  const d = new Date(from);
  const diff = ((weekday + 7 - d.getDay()) % 7) || 7; // roll forward; never 0
  d.setDate(d.getDate() + diff);
  return d;
};
const escapeHTML = (s) =>
  (s || '').replace(/[&<>'"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])
  );
const weekdayName = (n) =>
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number.isFinite(n) ? n : 0];

  let currentView = { type: 'dashboard', id: null };
  const PRIORITY_ORDER = { urgent:4, high:3, medium:2, low:1, '':0, null:0, undefined:0 };
  
let workWeekOffset = 0; // 0 = current week, -1 = previous, +1 = next
// --- Drag-to-reschedule state ---
let draggingTask = null;
// --- Drag-across-weeks helpers ---
let dragHoverTimer = null;
const WEEK_EDGE_HOVER_MS = 500;
let activeCalendarContainer = null;
let activeCalendarTasks = null;
let activeCalendarOpts = null;
function scheduleWeekShift(delta) {
  if (dragHoverTimer) return;

  dragHoverTimer = setTimeout(() => {
    workWeekOffset += delta;
    renderWorkWeekCalendar(
      activeCalendarContainer,
      activeCalendarTasks,
      activeCalendarOpts
    );
    dragHoverTimer = null;
  }, WEEK_EDGE_HOVER_MS);
}

function clearWeekShift() {
  if (dragHoverTimer) {
    clearTimeout(dragHoverTimer);
    dragHoverTimer = null;
  }
}
function getMondayOfWeek(offset = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const deltaToMonday = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + deltaToMonday + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

  const STATUS_ORDER = { 'todo':1, 'in-progress':2, 'blocked':3, 'done':4 };
  let cache = {
    projects: [],
    tasks: [],
    notes: [],
    settings: {
      id: 'main',
      anchorWeekday: 2,
      workdaysOnly: true,
      theme: 'light',
      filters: { status: 'all', priority: 'all', sort: 'due-asc' },
      notificationsEnabled: false,
      _lastNotifyKey: null,
      quickAddProjectId: null,
      focusModeEnabled: false,
      sidebarCollapsed: { views: true, projects: false, settings: true },
      compactDashboard: true,      
// renderer.js – defaults/seed (optional)
      singleTodoBeta: false

    }
  };
  // --- Estimated-time start window detection --------------------
function isTaskInStartWindow(task, now = new Date()) {
  if (!task) return false;
  if (!task.dueDate) return false;
  if (!Number.isFinite(task.estimatedMinutes)) return false;
  if (task.completedDate) return false;

  const due = new Date(task.dueDate);
  if (!Number.isFinite(due.getTime())) return false;

  const msNeeded = task.estimatedMinutes * 60_000;
  return (now.getTime() + msNeeded) >= due.getTime();
}
async function maybeNotifyStartNow(task) {
  if (!cache.settings.notificationsEnabled) return;
  if (!isTaskInStartWindow(task)) return;

  const key = startNowNotifyKey(task.id);
  if (cache.settings._lastNotifyKey === key) return;

  const dueText = task.dueDate ? fmt(task.dueDate, true) : 'soon';
  const estText = formatEstimatedMinutes(task.estimatedMinutes);

  await api.notify({
    title: '🦦 You otter start now',
    body: `"${task.title}" should be started now (${estText} needed before ${dueText}).`
  });

  await saveSettings({ _lastNotifyKey: key });
}

function renderStartNowChip(task) {
  if (!isTaskInStartWindow(task)) return '';

  const pri = task.priority ? `priority-${task.priority}` : '';

  return `
    <span class="chip start-now ${pri}"
          title="Based on estimated time, you should start this task now to meet its due date">
      <i class="ri-hourglass-2-fill"></i>Start Now
    </span>
  `;
}
  function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Transient UI state (not persisted): which task bundle panels are expanded
cache._expandedBundles = new Set();

// shape: { id: string, type: 'sleep' | 'mood' }
// Insights-local edit state (must survive re-renders)
 let editingSleepId = null;
 let editingMoodId  = null;

 // --- Estimated time helpers -----------------------------------
function minutesFromUnits({ days = 0, hours = 0, minutes = 0 }) {
  const total =
    (Number(days) || 0) * 8 * 60 +    // 1 workday = 8 hours
    (Number(hours) || 0) * 60 +
    (Number(minutes) || 0);
  return total > 0 ? total : null;
}

function unitsFromMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    return { days: '', hours: '', minutes: '' };
  }

  const days = Math.floor(totalMinutes / (8 * 60));
  const remAfterDays = totalMinutes - days * 8 * 60;
  const hours = Math.floor(remAfterDays / 60);
  const minutes = remAfterDays - hours * 60;

  return {
    days: days || '',
    hours: hours || '',
    minutes: minutes || ''
  };
}

function formatEstimatedMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '';
  const { days, hours, minutes } = unitsFromMinutes(totalMinutes);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(' ');
}
function sumEstimatedMinutes(tasks) {
  return tasks
    .map(t => t.estimatedMinutes)
    .filter(m => Number.isFinite(m) && m > 0)
    .reduce((a, b) => a + b, 0);
}
function countUnestimatedTasks(tasks) {
  return tasks.filter(t => !Number.isFinite(t.estimatedMinutes)).length;
}

 /** ---------------- Bulk-selection state ----------------------------------- */
  const selection = {
    ids: new Set(),          // selected task ids (global across lists)
    anchor: null,            // last anchor id for Shift-range
    orderByContainer: new WeakMap() // containerEl -> array of task ids in render order
  };
  // --- Bulk-selection state for NOTES (separate from tasks)
const noteSelection = {
  ids: new Set(),
};

  function clearSelection() {
    selection.ids.clear();
    selection.anchor = null;
    updateAllBulkbars();
// clear visuals in every rendered list
    document.querySelectorAll('.list').forEach(refreshContainerSelectionStyles);

  }

  function handleSelectionToggle(containerEl, taskId, { shiftKey = false } = {}) {
    const order = selection.orderByContainer.get(containerEl) || [];
    if (shiftKey && selection.anchor && order.includes(selection.anchor)) {
      const a = order.indexOf(selection.anchor);
      const b = order.indexOf(taskId);
      if (b !== -1) {
        const [start, end] = a < b ? [a, b] : [b, a];
        for (let i = start; i <= end; i++) selection.ids.add(order[i]);
      } else {
        // fallback to single toggle
        if (selection.ids.has(taskId)) selection.ids.delete(taskId); else selection.ids.add(taskId);
      }
    } else {
      if (selection.ids.has(taskId)) selection.ids.delete(taskId); else selection.ids.add(taskId);
      selection.anchor = taskId;
    }
    updateAllBulkbars();
    refreshContainerSelectionStyles(containerEl);
  }

  function ensureBulkBarFor(containerEl) {
    // Insert a bulkbar right before the list container
    const id = containerEl.id || ('list-' + Math.random().toString(36).slice(2));
    if (!containerEl.id) containerEl.id = id;
    const existing = containerEl.previousElementSibling;
    if (existing && existing.classList?.contains('bulkbar')) return existing;
    const bar = document.createElement('div');
    bar.className = 'bulkbar';
    bar.id = `bulk-${id}`;
    bar.innerHTML = `
      <div class="row">
        <span class="kbd" id="bulkCount-${id}">0 selected</span>
      </div>
      <div class="row">
        <button class="btn secondary" id="bulkDone-${id}">Mark done</button>
        <input type="date" id="bulkDue-${id}" />
        <span class="quickchip" id="bulkToday-${id}">Today</span>
        <span class="quickchip" id="bulkTomorrow-${id}">Tomorrow</span>
        <span class="quickchip" id="bulkNextWeek-${id}">Next week</span>
        <select id="bulkProject-${id}">
          <option value="">— No project</option>
        </select>
        <button class="btn ghost" id="bulkMove-${id}">Move</button>
        <button class="btn ghost" id="bulkClear-${id}">Clear</button>
        <button class="btn danger" id="bulkDelete-${id}">Delete</button>
      </div>
    `;
    containerEl.parentNode?.insertBefore(bar, containerEl);
    // Populate project select
    const sel = bar.querySelector(`#bulkProject-${id}`);
    if (sel) {
      for (const p of cache.projects) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      }
    }
    // Wire bulk actions
    bar.querySelector(`#bulkClear-${id}`)?.addEventListener('click', () => { clearSelection(); });
    bar.querySelector(`#bulkDelete-${id}`)?.addEventListener('click', async () => {
      const ids = idsInContainer(containerEl);
      if (ids.length === 0) return;
      if (!confirm(`Delete ${ids.length} task(s)?`)) return;
      const { stores } = tx(STORES.tasks, 'readwrite');
      for (const tid of ids) await delByKey(stores[STORES.tasks], tid);
      await loadAll(); render();
    });
    bar.querySelector(`#bulkDone-${id}`)?.addEventListener('click', async () => {
      const now = new Date().toISOString();
      const ids = idsInContainer(containerEl);
      if (ids.length === 0) return;
      const { stores } = tx(STORES.tasks, 'readwrite');
      for (const tid of ids) {
        const t = cache.tasks.find(x => x.id === tid);
        if (!t) continue;
        // Avoid changing recurring here to keep recurrence logic intact
        if (t.type === 'one-off' && t.status !== 'done') {
          await put(stores[STORES.tasks], { ...t, status: 'done', completedDate: now, updatedAt: now });
        }
      }
      await loadAll(); render();
    });
    const dateInput = bar.querySelector(`#bulkDue-${id}`);
    const setDue = async (ymd) => {
      const ids = idsInContainer(containerEl);
      if (ids.length === 0) return;
      const { stores } = tx(STORES.tasks, 'readwrite');
      const now = new Date().toISOString();
      for (const tid of ids) {
        const t = cache.tasks.find(x => x.id === tid);
        if (!t) continue;
        await put(stores[STORES.tasks], { ...t, dueDate: ymd, updatedAt: now });
      }
      await loadAll(); render();
    };
    dateInput?.addEventListener('change', (e) => { if (e.target.value) setDue(e.target.value); });
    bar.querySelector(`#bulkToday-${id}`)?.addEventListener('click', () => setDue(todayISO()));
    bar.querySelector(`#bulkTomorrow-${id}`)?.addEventListener('click', () => {
      const d = new Date(); d.setDate(d.getDate() + 1); setDue(todayISO(d));
    });
    bar.querySelector(`#bulkNextWeek-${id}`)?.addEventListener('click', () => {
      const d = new Date(); d.setDate(d.getDate() + 7); setDue(todayISO(d));
    });
    bar.querySelector(`#bulkMove-${id}`)?.addEventListener('click', async () => {
      const sel = bar.querySelector(`#bulkProject-${id}`);
      const projId = sel?.value || null;
      const ids = idsInContainer(containerEl);
      if (ids.length === 0) return;
      const { stores } = tx(STORES.tasks, 'readwrite');
      const now = new Date().toISOString();
      for (const tid of ids) {
      const t = cache.tasks.find(x => x.id === tid);      
        if (!t) continue;
        await put(stores[STORES.tasks], { ...t, projectId: projId, updatedAt: now });
      }
      await loadAll(); render();
    });
    return bar;
  }

  function idsInContainer(containerEl) {
    const visibleOrder = selection.orderByContainer.get(containerEl) || [];
    return visibleOrder.filter(id => selection.ids.has(id));
  }

  function updateAllBulkbars() {
    document.querySelectorAll('.bulkbar').forEach(bar => {
      const forId = bar.id.replace('bulk-','');
      const containerEl = document.getElementById(forId);
      if (!containerEl) return;
      const count = idsInContainer(containerEl).length;
      const countEl = bar.querySelector(`#bulkCount-${forId}`);
      if (countEl) countEl.textContent = `${count} selected`;
      bar.classList.toggle('show', count > 0);
    });
  }
  function renderNotesBulkBar(container, notes) {
  if (noteSelection.ids.size === 0) return null;

  const bar = document.createElement('div');
  bar.className = 'bulkbar show';

  bar.innerHTML = `
    <div class="row">
      <span class="kbd">${noteSelection.ids.size} selected</span>
    </div>
    <div class="row">
    <button class="btn ghost" id="bulkNoteSelectAll">Select all</button>
      <select id="bulkNoteProject">
        <option value="">— No project</option>
        ${cache.projects.map(p =>
          `<option value="${p.id}">${escapeHTML(p.name)}</option>`
        ).join('')}
      </select>

      <button class="btn ghost" id="bulkNoteMove">Move</button>
      <button class="btn danger" id="bulkNoteDelete">Delete</button>
      <button class="btn ghost" id="bulkNoteClear">Clear</button>
    </div>
  `;

  // ---- Wire actions ----
// Select all notes in this view
bar.querySelector('#bulkNoteSelectAll')?.addEventListener('click', () => {
  const visibleIds = getVisibleNoteIds(notes);

  const allAlreadySelected = visibleIds.every(id =>
    noteSelection.ids.has(id)
  );

  if (allAlreadySelected) {
    // toggle → clear
    noteSelection.ids.clear();
  } else {
    // select everything visible
    visibleIds.forEach(id => noteSelection.ids.add(id));
  }

  render(); // preserve scroll (as you already adjusted)
});
  // Clear selection
  bar.querySelector('#bulkNoteClear')?.addEventListener('click', () => {
    noteSelection.ids.clear();
    render();
  });

  // Delete selected notes
  bar.querySelector('#bulkNoteDelete')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${noteSelection.ids.size} note(s)?`)) return;
    const { stores } = tx(STORES.notes, 'readwrite');
    for (const id of noteSelection.ids) {
      await delByKey(stores[STORES.notes], id);
    }
    noteSelection.ids.clear();
    await loadAll();
    render();
  });

  // Move notes to a project
  bar.querySelector('#bulkNoteMove')?.addEventListener('click', async () => {
    const sel = bar.querySelector('#bulkNoteProject');
    const projectId = sel.value || null;
    const now = new Date().toISOString();
    const { stores } = tx(STORES.notes, 'readwrite');

    for (const id of noteSelection.ids) {
      const note = cache.notes.find(n => n.id === id);
      if (!note) continue;
      await put(stores[STORES.notes], {
        ...note,
        projectId,
        updatedAt: now
      });
    }

    noteSelection.ids.clear();
    await loadAll();
    render();
  });

  return bar;
}

  // Visually sync the .selected class for every item in a list container
  function refreshContainerSelectionStyles(containerEl) {
    if (!containerEl) return;
    containerEl.querySelectorAll('.item').forEach(row => {
      const id = row?.dataset?.id;
      if (!id) return;
      row.classList.toggle('selected', selection.ids.has(id));
    });
  }

  // ================ Deleting Projects ===================
function countProjectDependents(projectId) {
  const taskCount  = cache.tasks.filter(t => t.projectId === projectId).length;
  const notesCount = cache.notes.filter(n => n.projectId === projectId).length;
  return { taskCount, notesCount, total: taskCount + notesCount };
}

async function openDeleteProjectPrompt(project) {
  const { id, name } = project;
  const { taskCount, notesCount, total } = countProjectDependents(id);

  // Build a compact, accessible confirm dialog using the existing <dialog> polyfill
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <form method="dialog" class="panel" style="min-width: 320px;">
      <h2>Delete project</h2>
      <p>Are you sure you want to delete <b>${escapeHTML(name)}</b>?</p>
      <div class="sub" style="margin:.5rem 0;">
        Items affected: <b>${taskCount}</b> task(s), <b>${notesCount}</b> note(s).
      </div>
      <div class="field">
        <label for="delMode">What should happen to its items?</label>
        <select id="delMode">
          <option value="move">Move tasks & notes to Inbox</option>
          <option value="hard">Delete tasks & notes (destructive)</option>
        </select>
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
        <button class="btn secondary" value="cancel">Cancel</button>
        <button class="btn danger" value="ok">Delete project</button>
      </div>
    </form>
  `;

  document.body.appendChild(dlg);
  patchDialogs(); // ensure polyfill is active
  try { dlg.showModal(); } catch { dlg.setAttribute('open',''); dlg.style.display='block'; }

  dlg.addEventListener('close', async () => {
    const action = dlg.returnValue;
    const mode = dlg.querySelector('#delMode')?.value ?? 'move';
    dlg.remove();

    if (action !== 'ok') return;
    await deleteProject(id, { mode }); // mode: 'move' or 'hard'
  }, { once: true });
}

  /** ---------------- Recurrence & Filters ---------------------------------- */
  function nextDueForRecurring(task, completedAt = new Date()) {
    const base = new Date(completedAt);
    const pattern = task?.recurrence?.pattern || 'weekly';
    const weeklyDay = Number(task?.recurrence?.weeklyDay ?? NaN);
    switch (pattern) {
      case 'daily': return addDays(base, 1);
      case 'weekly': return Number.isNaN(weeklyDay) ? addDays(base, 7) : clampToNextWeekday(base, weeklyDay);
      case 'biweekly': return Number.isNaN(weeklyDay) ? addDays(base, 14) : addDays(clampToNextWeekday(base, weeklyDay), 7);
      case 'monthly': {
      // Next cycle starts on the 1st of next month; due at end of that next month (anchored if set)
      const nextStart = firstDayOfNextMonth(base);
      const y = nextStart.getFullYear(); const m = nextStart.getMonth();
      const aw = cache.settings?.anchorWeekday;
      const due = Number.isInteger(aw) ? lastAnchorWeekdayOfMonth(y, m, aw) : lastCalendarDayOfMonth(y, m);
      return due;
    }
      default: return addDays(base, 7);
    }
  }
  function getReviewRange(anchorWeekday) {
    const aw = typeof anchorWeekday === 'number' ? anchorWeekday : 2;
    const now = new Date(); const d = new Date(now);
    const delta = ((d.getDay() - aw + 7) % 7) || 7;
    d.setDate(d.getDate() - delta); d.setHours(0,0,0,0);
    return { start: d, end: now };
  }
  
  function applyGlobalFilters(tasks, opts = {}) {
  const { ignoreStatus = false } = opts;
  const filters = cache.settings?.filters ?? {
    status: 'all',
    priority: 'all',
    sort: 'due-asc'
  };

  let list = tasks.slice();

  // Status filter
  if (!ignoreStatus && filters.status !== 'all') {
    list = list.filter(t => t.status === filters.status);
  }

  // Priority filter
  if (filters.priority !== 'all') {
    list = list.filter(
      t => (t.priority ?? '').toLowerCase() === filters.priority
    );
  }

  // Sorting
  switch (filters.sort) {
    case 'due-asc':
      list.sort((a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
        a.title.localeCompare(b.title)
      );
      break;

    case 'due-desc':
      list.sort((a, b) =>
        (b.dueDate ?? '').localeCompare(a.dueDate ?? '') ||
        a.title.localeCompare(b.title)
      );
      break;

    case 'priority':
      list.sort((a, b) =>
        (PRIORITY_ORDER[b.priority] ?? 0) -
        (PRIORITY_ORDER[a.priority] ?? 0) ||
        a.title.localeCompare(b.title)
      );
      break;

    case 'status':
      list.sort((a, b) =>
        (STATUS_ORDER[a.status] ?? 0) -
        (STATUS_ORDER[b.status] ?? 0) ||
        a.title.localeCompare(b.title)
      );
      break;

    case 'title':
      list.sort((a, b) => a.title.localeCompare(b.title));
      break;
  }

  return list;
}

  /** ---------------- Load / Save ------------------------------------------- */
  async function loadAll() {
    const { stores } = tx([STORES.projects, STORES.tasks, STORES.notes, STORES.settings], 'readonly');
    const [projects, tasks, notes, settingsArr] = await Promise.all([
      getAll(stores[STORES.projects]),
      getAll(stores[STORES.tasks]),
      getAll(stores[STORES.notes]),
      getAll(stores[STORES.settings])
    ]);
    cache.projects = projects.sort((a,b)=> a.name.localeCompare(b.name));
    cache.tasks = tasks;

    // Fast task lookup for review aggregations
    cache._taskById = new Map();
    for (const t of cache.tasks) cache._taskById.set(t.id, t);

    cache.notes = notes.sort((a,b)=> (a.createdAt||'').localeCompare(b.createdAt||''));
    cache.settings = settingsArr[0] ? { ...cache.settings, ...settingsArr[0] } : cache.settings;

    document.documentElement.setAttribute('data-theme', cache.settings.theme || 'light');

    // Populate Quick Add project dropdown and select the saved choice
    const quickSel = document.getElementById('quickProject');
    if (quickSel) {
      refreshProjectOptions([quickSel]);
      const first = quickSel.querySelector('option[value=""]');
      if (first) first.textContent = 'Inbox';
      else {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = 'Inbox';
        quickSel.insertBefore(opt, quickSel.firstChild);
      }
      // Only set from settings if there is no current selection
      if (!quickSel.value) {
        quickSel.value = cache.settings.quickAddProjectId || '';
        if (!quickSel.value) quickSel.value = '';
      }
      setQuickAddPlaceholder();
    }

    const anchorSel = $('#anchorWeekday'); if (anchorSel) anchorSel.value = String(cache.settings.anchorWeekday || 2);
    const wd = $('#workdaysOnly'); if (wd) wd.checked = !!cache.settings.workdaysOnly;
    const en = $('#enableNotifications'); if (en) en.checked = !!cache.settings.notificationsEnabled;
    const cd = $('#compactDashboard');    if (cd) cd.checked = !!cache.settings.compactDashboard;
    const fs = $('#filterStatus'); if (fs) fs.value = cache.settings.filters?.status || 'all';
    const fp = $('#filterPriority'); if (fp) fp.value = cache.settings.filters?.priority || 'all';
    const so = $('#sortBy'); if (so) so.value = cache.settings.filters?.sort || 'due-asc';
// renderer.js – loadAll()
    const stb = $('#singleTodoBeta'); if (stb) stb.checked = !!cache.settings.singleTodoBeta;
    const themeSel = $('#themeSelect'); if (themeSel) themeSel.value = cache.settings.theme || 'light';
  }
  async function saveSettings(partial) {
    const settings = { ...cache.settings, ...partial, id: 'main' };
    const { stores } = tx(STORES.settings, 'readwrite');
    await put(stores[STORES.settings], settings);
    cache.settings = settings;
  }
  // Toggle and persist Compact Dashboard (default is true)
async function toggleCompactDashboard(force = null) {
  const next = (force === null) ? !cache.settings.compactDashboard : !!force;
  await saveSettings({ compactDashboard: next });
  render(); // re-render dashboard with the new mode
}
function getTodoSummaryCounts(tasks) {
  const t = todayISO();

  const open = tasks.filter(x => x.status !== 'done');
  const dueToday = open.filter(x => x.dueDate === t);

  return {
    open: open.length,
    dueToday: dueToday.length
  };
}
// --- Sidebar task counts (unified, unfiltered) ---
function getSidebarTaskCounts() {
  const t = todayISO();
  const open = cache.tasks.filter(x => x.status !== 'done');

  return {
    inbox: open.filter(x => !x.projectId).length,
    today: open.filter(x => x.dueDate === t).length,
    upcoming: open.filter(x => x.dueDate && x.dueDate > t).length,
    overdue: open.filter(x => x.dueDate && x.dueDate < t).length,
    all: open.length,
    recurring: open.filter(x => x.type === 'recurring').length,

    projects: Object.fromEntries(
      cache.projects.map(p => [
        p.id,
        open.filter(x => x.projectId === p.id).length
      ])
    )
  };
}
  /** ---------------- Rendering --------------------------------------------- */
  function renderSidebar() {
    const counts = getSidebarTaskCounts();
    const list = $('#projectsList'); if (!list) return;
    list.innerHTML = '';
    for (const p of cache.projects) {
      const li = document.createElement('li');
      li.className = 'nav-item';
      li.dataset.view = 'project';
      li.dataset.id = p.id;
      li.innerHTML = `
        <div class="row">
          <i class="ri-folder-line icon" aria-hidden="true"></i>
          <span>${escapeHTML(p.name)}</span>
        </div>
        <span class="count">${counts.projects[p.id] ?? 0}</span>
      `;
      // No per-item listeners here; we delegate at the list level.
      list.appendChild(li);
    }
    const t = todayISO();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    // set('countInbox',   cache.tasks.filter(x => !x.projectId && x.status !== 'done').length);
    // set('countToday',   cache.tasks.filter(x => x.status !== 'done' && x.dueDate === t).length);
    // set('countUpcoming',cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate > t).length);
    // set('countOverdue', cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate < t).length);
    // set('countRecurring', cache.tasks.filter(x => x.type === 'recurring').length);
    set('countInbox', counts.inbox);
    set('countToday', counts.all);
    set('countUpcoming', counts.upcoming);
    set('countOverdue', counts.overdue);
    set('countRecurring', counts.recurring);
    // Only clear 'active' from actual view items (data-view), not from arbitrary items
    $$('#viewsList .nav-item[data-view]').forEach(el => el.classList.remove('active'));
    const active = $(`#viewsList .nav-item[data-view="${currentView.type}"]`);
    if (active) active.classList.add('active');

// After you build the #projectsList…
const projectItems = $$('#projectsList .nav-item');
projectItems.forEach(el => el.classList.remove('active'));

if (currentView.type === 'project' && currentView.id) {
  const activeProject = $(`#projectsList .nav-item[data-id="${currentView.id}"]`);
  if (activeProject) activeProject.classList.add('active');
}


  }

  function render() {
    // Keep the sidebar visible on all views; focus-mode is a manual toggle only.
    renderSidebar();
    const main = $('#main'); if (!main) return;    
// Start new content from the top
    scrollToTopNow();
    main.innerHTML = '';
    switch (currentView.type) {
      case 'dashboard': return renderDashboard(main);
      case 'focus': return renderFocus(main);   
      case 'today':
        return renderUnifiedTodo(main, { initialScope: 'today' }); 
      case 'upcoming':
        return renderUnifiedTodo(main, { initialScope: 'week' });
      case 'overdue':
        return renderUnifiedTodo(main, { initialScope: 'overdue' });  
    //   case 'today': {
    //   if (cache.settings?.singleTodoBeta) return renderUnifiedTodo(main, { initialScope: 'today' });
    //   return renderList(main, { title: 'Due Today', filter: t => t.status !== 'done' && t.dueDate === todayISO() });
    // }
    //   case 'upcoming': {
    //   if (cache.settings?.singleTodoBeta) return renderUnifiedTodo(main, { initialScope: 'week' });
    //   return renderList(main, { title: 'Upcoming', filter: t => t.status !== 'done' && t.dueDate && t.dueDate > todayISO() });
    // }
    //   case 'overdue': {
    //   if (cache.settings?.singleTodoBeta) return renderUnifiedTodo(main, { initialScope: 'overdue' });
    //   return renderList(main, { title: 'Overdue', filter: t => t.status !== 'done' && t.dueDate && t.dueDate < todayISO() });
    // }
      case 'recurring': return renderRecurring(main);
      // case 'inbox': return renderList(main, { title: 'Inbox', filter: t => !t.projectId && t.status !== 'done', ignoreFilters: true });
      case 'inbox': {
  // Inbox is a structural view (not filterable)
  const items = cache.tasks.filter(
    t => !t.projectId && t.status !== 'done'
  );

  main.innerHTML = `
    <div class="panel">
      <div class="row" style="justify-content:space-between;">
        <h2>Inbox <span class="sub">(${items.length})</span></h2>
        <div class="row">
          <button id="btnAddTaskInbox" class="btn">+ New Task</button>
        </div>
      </div>
      <div id="inboxList" class="list"></div>
      ${items.length === 0
        ? `<div class="empty">Your inbox is clear 🎉</div>`
        : ''}
    </div>
  `;

  document
    .getElementById('btnAddTaskInbox')
    ?.addEventListener('click', () => openTaskDialog());

  renderTaskCollection(
    document.getElementById('inboxList'),
    items
  );

  return;
}
      case 'completed': return renderCompleted(main);
      case 'review': return renderReviewPage(main);
      case 'project': return renderProject(main, currentView.id);
      case 'insights': return renderInsights(main);
    }
  }
// --- Weekly productivity stats (shared by summary + dashboard viz) ---
async function getWeeklyProductivityStats() {
  const range = getWeekWindow(cache.settings?.anchorWeekday ?? 2, 0);
  const { start, end } = range;

  // One‑off task completions
  const oneOffCount = cache.tasks.filter(t =>
    t.type === 'one-off' &&
    t.completedDate &&
    new Date(t.completedDate) >= start &&
    new Date(t.completedDate) <= end
  ).length;

  // Recurring completion logs
  const { stores } = tx(STORES.completions, 'readonly');
  const logs = await getAll(stores[STORES.completions]);
  const recurringCount = logs.filter(c => {
    const d = new Date(c.completedAt);
    return d >= start && d <= end;
  }).length;

  // Notes created this week
  const notesCount = cache.notes.filter(n => {
    const d = new Date(n.createdAt);
    return d >= start && d <= end;
  }).length;

  return { oneOffCount, recurringCount, notesCount };
}
//COME BACK HERE AND UNCOMMENT IF YOU WANT PRODUCTIVITY CHIPS SUMMARY BACK IN HEATMAP CONTAINER
// function renderProductivityChips({ oneOffCount, recurringCount, notesCount }) {
//   return `
//     <div class="prod-chips">
//       <div class="sub">Completion Summary</div>
//       <span class="chip">
//         <i class="ri-checkbox-line"></i> ${oneOffCount} Tasks
//       </span>
//       <span class="chip">
//         <i class="ri-loop-right-fill"></i> ${recurringCount} Recurring
//       </span>
//       <span class="chip">
//         <i class="ri-sticky-note-add-line"></i> ${notesCount} Notes
//       </span>
//     </div>
//   `;
// }
  function renderDashboard(root) {
    const t = todayISO(); 
  // Micro summary panel (initial "loading" placeholder)
root.insertAdjacentHTML('beforeend', `
  <!-- Productivity panel -->
  <div class="panel has-actions">
    <div class="row" style="justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
      <div id="dashSummary" class="summary-line">
        <span class="kbd">Loading summary…</span>
      </div>

    </div>

 <div class="grid-2 prod-overview">
   <!-- Productivity heatmap -->
   <div>
     <h3 class="subhead">Productivity</h3>
     
  <div class="viz-box prod-inner">
  <div class="prod-heatmap-wrap">
    <div id="hmProductivity" class="prod-heatmap"></div>
  </div>
  <div id="prodChipsHost" class="prod-chips-wrap"></div>
  </div>

   </div>

   <!-- Trends -->
   <div>
     <h3 class="subhead">
       Trends <span class="sub">Last 8 weeks • weekly averages</span>
     </h3>

   <div class="viz-box">
     <div id="trendChart"></div>
   </div>
   <div id="trendInsight" class="sub" style="margin-top:8px;"></div>

   </div>
 </div>

 <div class="panel-actions">
   <button
     id="btnGoInsights"
     class="btn secondary"
     title="Log or edit sleep and mood">
     Log Insights
   </button>

   <button
     id="btnToggleCompact"
     class="btn secondary"
     title="Toggle dashboard density">
     ${cache.settings.compactDashboard ? 'Expand Dash' : 'Compact Dash'}
   </button>
 </div>
  </div>
  `);

  document.getElementById('btnGoInsights')?.addEventListener('click', () => {
   setView({ type: 'insights' });
 });
  // Populate asynchronously without blocking the rest of the dashboard 
 (async () => {
   try {
     const stats = await getWeeklyProductivityStats();

     // Summary line
     updateDashboardSummary(
       document.getElementById('dashSummary'),
       stats
     );

     // Productivity chips (inside heatmap container)
     const chipsHost = document.getElementById('prodChipsHost');
     if (chipsHost) {
       chipsHost.innerHTML = renderProductivityChips(stats);
     }
   } catch (err) {
     console.warn('[dashboard] weekly stats failed:', err);
   }
 })();

  

// Build & render all three heatmaps (Productivity + Sleep + Mood)
  (async () => {
    try {
      const act = await buildDailyActivityCells({ weeks: 8, includeNotes: false });
      renderHeatmap(document.getElementById('hmProductivity'), act);
    } catch (err) {
      console.warn('[dashboard] Productivity heatmap failed:', err);
    }
    try {
      const sleep = await buildMetricCells({ weeks: 8, type: 'sleep' });
      renderHeatmap(document.getElementById('hmSleep'), sleep);
    } catch (err) {
      console.warn('[wellness] Sleep heatmap failed:', err);
    }
    try {
      const mood = await buildMetricCells({ weeks: 8, type: 'mood' });
      renderHeatmap(document.getElementById('hmMood'), mood);
    } catch (err) {
      console.warn('[wellness] Mood heatmap failed:', err);
    }
  })();

 // === Weekly Trends Helpers =====================================
  function getRecentWeeks(weeks = 8) {
  const anchor = Number(cache.settings.anchorWeekday ?? 1);
  const today = new Date();
  const offset = (today.getDay() - anchor + 7) % 7;

  const lastWeekEnd = new Date(today);
  lastWeekEnd.setDate(today.getDate() - offset);

  const ranges = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(lastWeekEnd);
    end.setDate(lastWeekEnd.getDate() - i * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    ranges.push({
      start: ymd(start),
      end: ymd(end)
    });
  }
  return ranges;
}

// Productivity = total completions per week
async function getWeeklyProductivity(weeks = 8) {
  const ranges = getRecentWeeks(weeks);

  // Read directly from the completions store (same pattern as Review / Completed)
  const { stores } = tx(STORES.completions, 'readonly');
  const rows = await getAll(stores[STORES.completions]);

  return ranges.map(r => {
    return rows.filter(c => {
      const d = ymd(new Date(c.completedAt));
      return d >= r.start && d <= r.end;
    }).length;
  });
}


// Sleep or Mood = average per week
async function getWeeklyMetric(type, weeks = 8) {
  const result = await buildMetricCells({ weeks, type });
  const days = Array.isArray(result?.days) ? result.days : [];

  const ranges = getRecentWeeks(weeks); // { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  const buckets = Array.from({ length: weeks }, () => []);

  for (const d of days) {
    // ✅ normalize the metric day to YYYY-MM-DD
    const dayKey = ymd(new Date(d.date));

    // ✅ find the week this day belongs to
    const idx = ranges.findIndex(
      r => dayKey >= r.start && dayKey <= r.end
    );

    if (idx >= 0 && Number.isFinite(d.value)) {
      buckets[idx].push(Number(d.value));
    }
  }

  return buckets.map(vals =>
    vals.length
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : null
  );
}
// === Trend Chart Helpers =======================================

// Normalize an array of numbers (null-safe) to 0–100
function normalizeSeries(series) {
  const vals = series.filter(v => Number.isFinite(v));
  if (!vals.length) return series.map(() => null);

  const min = Math.min(...vals);
  const max = Math.max(...vals);

  if (min === max) {
    return series.map(v => (Number.isFinite(v) ? 50 : null));
  }
  return series.map(v =>
    Number.isFinite(v) ? ((v - min) / (max - min)) * 100 : null
  );
}

// Build an SVG path from normalized values
function buildLinePath(values, width, height, pad = 16) {
  const step = (width - pad * 2) / (values.length - 1);
  let d = '';

  values.forEach((v, i) => {
    if (v == null) return;
    const x = pad + i * step;
    const y = pad + ((100 - v) / 100) * (height - pad * 2);
    d += `${d ? 'L' : 'M'}${x},${y} `;
  });

  return d.trim();
}
function renderTrendChart({ productivity, sleep, mood }, weeks = 8) {
  const wrap = document.getElementById('trendChart');
  if (!wrap) return;

  wrap.innerHTML = '';

  const width = 640;
  const height = 220;
  const PAD_X = 24;
  const PAD_Y = 16;


  const prodN = normalizeSeries(productivity);
  const sleepN = normalizeSeries(sleep);
  const moodN  = normalizeSeries(mood);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);
  svg.style.display = 'block';

  const mkPath = (vals, color) => {
    const p = document.createElementNS(svg.namespaceURI, 'path');
    p.setAttribute('d', buildLinePath( vals, width - PAD_X * 2, height - PAD_Y * 2, PAD_X, PAD_Y));
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '2.25');
    p.setAttribute('opacity', '0.85');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    return p;
  };


const g = document.createElementNS(svg.namespaceURI, 'g');
g.setAttribute('transform', `translate(24, 16)`);

g.append(
  mkPath(prodN, 'var(--primary)'),
  mkPath(sleepN, '#5bbad5'),
  mkPath(moodN,  '#c26bb2')
);

svg.appendChild(g);


  wrap.appendChild(svg);

  // Accessibility fallback
  wrap.setAttribute('aria-label', 'Weekly trends: productivity, sleep, and mood');
}
function percentChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}
function compareByMedian(x, y) {
  const pairs = x
    .map((v, i) => [v, y[i]])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

  if (pairs.length < 4) return null; // avoid tiny samples

  const xs = pairs.map(p => p[0]).sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)];

  const low = pairs.filter(([a]) => a < median).map(p => p[1]);
  const high = pairs.filter(([a]) => a >= median).map(p => p[1]);

  if (low.length < 2 || high.length < 2) return null;

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    lowAvg: avg(low),
    highAvg: avg(high)
  };
}
function correlation(a, b) {
  const pairs = a
    .map((v, i) => [v, b[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  if (pairs.length < 3) return null;

  const xs = pairs.map(p => p[0]);
  const ys = pairs.map(p => p[1]);

  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const mx = mean(xs);
  const my = mean(ys);

  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const vx = xs[i] - mx;
    const vy = ys[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }

  const den = Math.sqrt(dx * dy);
  return den ? num / den : null;
}

function correlationLag(a, b, lag = 1) {
  return correlation(a.slice(lag), b.slice(0, -lag));
}
function generateTrendInsight({ productivity, sleep, mood }) {
  const insights = [];

  const strong = v => Number.isFinite(v) && Math.abs(v) >= 0.4;

  // --- Percent-based insights (preferred when available) ---

  const sleepProd = compareByMedian(sleep, productivity);
  if (sleepProd) {
    const pct = percentChange(sleepProd.lowAvg, sleepProd.highAvg);
    if (pct && Math.abs(pct) >= 10) {
      insights.push({
        strength: Math.abs(pct),
        text:
          pct > 0
            ? `In weeks with higher sleep, productivity was about ${Math.round(pct)}% higher on average.`
            : `Weeks with higher sleep saw about ${Math.round(Math.abs(pct))}% lower productivity on average.`
      });
    }
  }

  const prodMood = compareByMedian(productivity, mood);
  if (prodMood) {
    const pct = percentChange(prodMood.lowAvg, prodMood.highAvg);
    if (pct && Math.abs(pct) >= 10) {
      insights.push({
        strength: Math.abs(pct),
        text:
          pct > 0
            ? `Mood averaged about ${Math.round(pct)}% higher in higher‑productivity weeks.`
            : `Mood tended to be lower in higher‑productivity weeks by about ${Math.round(Math.abs(pct))}%.`
      });
    }
  }

  // --- Correlation & lag insights (used when % isn’t strong) ---

  const ps = correlation(productivity, sleep);
  if (strong(ps)) {
    insights.push({
      strength: Math.abs(ps) * 100,
      text:
        ps > 0
          ? 'Productivity and sleep generally rose and fell together.'
          : 'Productivity and sleep often moved in opposite directions.'
    });
  }

  const pmLag = correlationLag(productivity, mood, 1);
  if (strong(pmLag)) {
    insights.push({
      strength: Math.abs(pmLag) * 110, // slight tie‑breaker preference
      text:
        pmLag > 0
          ? 'Mood often improved in the week following higher productivity.'
          : 'Mood tended to dip in the week after higher productivity.'
    });
  }

  if (!insights.length) {
    return 'No strong relationship stood out over these weeks.';
  }

  insights.sort((a, b) => b.strength - a.strength);
  return insights[0].text;
}

    let today = cache.tasks.filter(x => x.status !== 'done' && x.dueDate === t);
    let week = cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate >= t &&
      (new Date(x.dueDate) - new Date())/(1000*60*60*24) <= 7);
    let overdue = cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate < t);
    let rec = cache.tasks.filter(x => x.type === 'recurring');

    today = applyGlobalFilters(today);
    week = applyGlobalFilters(week);
    overdue = applyGlobalFilters(overdue);
    rec = applyGlobalFilters(rec);

if (!cache.settings.compactDashboard) {
    root.insertAdjacentHTML('beforeend', `
      <div class="grid-2">
        <div class="panel"><h2><span class="notes-ico-wrap">
          <svg class="notes-ico" width="1.5em" height="1.5em" viewBox="0 0 24 24" aria-hidden="true"
          fill="currentColor" focusable="false">
          <path d="M17 3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H7V1H9V3H15V1H17V3ZM4 9V19H20V9H4ZM6 13H11V17H6V13Z"></path>
  </svg></span> Due Today <span class="sub">(${today.length})</span></h2><div id="dashToday" class="list"></div></div>
        <div class="panel"><h2><span class="notes-ico-wrap">
          <svg class="notes-ico" width="1.5em" height="1.5em" viewBox="0 0 24 24" aria-hidden="true"
          fill="currentColor" focusable="false">
          <path d="M4 2H20V6.45994L13.5366 12L20 17.5401V22H4V17.5401L10.4634 12L4 6.45994V2ZM16.2967 7L18 5.54007V4H6V5.54007L7.70326 7H16.2967ZM12 13.3171L6 18.4599V20H7L12 17L17 20H18V18.4599L12 13.3171Z"></path>
  </svg></span> This Week <span class="sub">(${week.length})</span></h2><div id="dashWeek" class="list"></div></div>
        <div class="panel"><h2><span class="notes-ico-wrap">
          <svg class="notes-ico" width="1.5em" height="1.5em" viewBox="0 0 24 24" aria-hidden="true"
          fill="currentColor" focusable="false">
          <path d="M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM11 15H13V17H11V15ZM11 7H13V13H11V7Z"></path>
  </svg></span> Overdue <span class="sub">(${overdue.length})</span></h2><div id="dashOverdue" class="list"></div></div>
        <div class="panel"><h2><span class="notes-ico-wrap">
          <svg class="notes-ico" width="1.5em" height="1.5em" viewBox="0 0 24 24" aria-hidden="true"
          fill="currentColor" focusable="false">
          <path d="M12 4C14.5905 4 16.8939 5.23053 18.3573 7.14274L16 9.5H22V3.5L19.7814 5.71863C17.9494 3.452 15.1444 2 12 2 6.47715 2 2 6.47715 2 12H4C4 7.58172 7.58172 4 12 4ZM20 12C20 16.4183 16.4183 20 12 20 9.40951 20 7.10605 18.7695 5.64274 16.8573L8 14.5 2 14.5V20.5L4.21863 18.2814C6.05062 20.548 8.85557 22 12 22 17.5228 22 22 17.5228 22 12H20Z"></path>
  </svg></span> Recurring <span class="sub">(${rec.length})</span></h2><div id="dashRecurring" class="list"></div></div>
      </div>
    `);
  }
  root.insertAdjacentHTML('beforeend', `
    <div class="panel">
        <h2>
        <span class="notes-ico-wrap">
          <svg class="notes-ico" width="1.5em" height="1.5em" viewBox="0 0 24 24" aria-hidden="true"
          fill="currentColor" focusable="false">
          <path d="M4 1V4H1V6H4V9H6V6H9V4H6V1H4ZM3 20.0066V11H5V19H13V14C13 13.45 13.45 13 14 13L19 12.999V5H11V3H20.0066C20.5552 3 21 3.45576 21 4.00247V15L15 20.996L4.00221 21C3.4487 21 3 20.5551 3 20.0066ZM18.171 14.999L15 15V18.169L18.171 14.999Z"></path>
  </svg></span>Notes</h2>
        <div class="row"><button id="btnAddNote" class="btn secondary">+ Note</button></div>
        <div id="notesList" class="list" style="margin-top:8px; color: var(--text); font-size: 14px; font-weight: lighter;"></div>
      </div>
    `);
    
if (!cache.settings.compactDashboard) {
    renderTaskCollection($('#dashToday'), today);
    renderTaskCollection($('#dashWeek'), week);
    renderTaskCollection($('#dashOverdue'), overdue);
    renderTaskCollection($('#dashRecurring'), rec);
  }
    // renderNotes($('#notesList'), cache.notes.slice().reverse().slice(0,10));
    // Dashboard Notes = unassigned (Inbox) notes only
const dashboardNotes = cache.notes
  .filter(n => !n.projectId)
  .slice()
  .reverse()
  .slice(0, 10);

renderNotes($('#notesList'), dashboardNotes);
    
// Wire the toggle
  document.getElementById('btnToggleCompact')?.addEventListener('click', () => toggleCompactDashboard());

// === Trends (Phase 2: SVG line chart) ==========================
(async () => {
  try {
    const prod = await getWeeklyProductivity(8);
    const sleep = await getWeeklyMetric('sleep', 8);
    const mood  = await getWeeklyMetric('mood', 8);

    renderTrendChart({
      productivity: prod,
      sleep,
      mood
    });

const insight = document.getElementById('trendInsight');
if (insight) {
  insight.textContent = generateTrendInsight({
    productivity: prod,
    sleep,
    mood
  });
}

  } catch (err) {
    console.warn('[trends] failed to render chart', err);
  }
})();

  }

  function renderFocus(root) {
    const t = todayISO();
    const overdue = cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate < t);
    const dueToday = cache.tasks.filter(x => x.status !== 'done' && x.dueDate === t);
    const inProg = cache.tasks.filter(x => x.status === 'in-progress' && (!x.startDate || x.startDate <= t));
    const map = new Map(); [...overdue, ...dueToday, ...inProg].forEach(x => map.set(x.id, x));
    const items = applyGlobalFilters(Array.from(map.values()));
    const totalEst = sumEstimatedMinutes(items);
    const estText = totalEst > 0
  ? formatEstimatedMinutes(totalEst)
  : null;
    const unestimatedCount = countUnestimatedTasks(items);
    let summaryText = '';

if (totalEst > 0) {
  summaryText = `${formatEstimatedMinutes(totalEst)} estimated`;

  if (unestimatedCount > 0) {
    summaryText += ` · ${unestimatedCount} unestimated`;
  }
} else if (unestimatedCount === items.length && items.length > 0) {
  summaryText = 'no estimates entered';
}
    root.insertAdjacentHTML('beforeend', `
      <div class="panel">
        <div class="row" style="justify-content:space-between;">
<h2>
  Today's Focus</h2>
  <div class="sub">
    ${items.length} task${items.length === 1 ? '' : 's'}
    ${summaryText ? ` · ${summaryText}` : ''}
  </div>


          <div class="row">
            <button id="btnAddTaskFocus" class="btn">+ New Task</button>
            <button id="btnAddNoteFocus" class="btn secondary">+ Note</button>
          </div>
        </div>
        <div id="focusList" class="list"></div>
        ${items.length === 0 ? `<div class="empty">You're all set for now. 🌿</div>` : ''}
      </div>
    `);
    $('#btnAddTaskFocus')?.addEventListener('click', () => openTaskDialog());
    $('#btnAddNoteFocus')?.addEventListener('click', () => openNoteDialog());
    renderTaskCollection($('#focusList'), items);
  }

  
  function renderList(root, { title, filter, ignoreStatus = false, ignoreFilters = false }) {
   // --- Work-week calendar panel (always visible) ---
root.insertAdjacentHTML('beforeend', `
  <div class="panel">
    <h2>Week Overview</h2>
    <div id="workWeekCalendar"></div>
  </div>
`);
  let items = cache.tasks.filter(filter);
  
if (!ignoreFilters) {
  items = applyGlobalFilters(items, { ignoreStatus });
}

  // Render the work-week calendar using the same filtered tasks
const cal = document.getElementById('workWeekCalendar');
if (cal) {
  renderWorkWeekCalendar(cal, baseTasks);
}
    root.insertAdjacentHTML('beforeend', `
      <div class="panel">
        <div class="row" style="justify-content:space-between;">
          <h2>${title} <span class="sub">(${items.length})</span></h2>
          <div class="row">
            <button id="btnAddTaskList" class="btn">+ New Task</button>
            <button id="btnAddNoteList" class="btn secondary">+ Note</button>
          </div>
        </div>
        <div id="genericList" class="list"></div>
        ${items.length === 0 ? `<div class="empty">Nothing here yet — 🎉</div>` : ''}
      </div>
    `);
    $('#btnAddTaskList')?.addEventListener('click', () => openTaskDialog());
    $('#btnAddNoteList')?.addEventListener('click', () => openNoteDialog());
    renderTaskCollection($('#genericList'), items, title.includes('Recurring'));
  }

  // --- Unified To‑Do (beta) ---
function renderUnifiedTodo(root, { initialScope = 'today' } = {}) {
  // Keep local UI state (in-memory; resets when you leave)
  let showCalendar = true;
  let quick = { dueSoon: false, high: false };
  // let showList = true;
  const LIST_KEY = 'todo:listVisibility';
  let showList = getListVisibility(LIST_KEY);

  const t = todayISO();
  const withinWeek = (due) => due && (new Date(due) - new Date())/(1000*60*60*24) <= 7 && due >= t;

  // Construct the shell
  root.insertAdjacentHTML('beforeend', `
    <div class="panel">
      <div class="row" style="align-items:flex-start; justify-content:space-between;">
        <h2>To‑Do <span class="sub"></span></h2>

        <div class="scopebar" id="todoScopeBar">

        </div>
      </div>
      <div class="panel">
  <h2></h2>
  <div id="workWeekCalendar">
    <div class="sub">Calendar loading…</div>
  </div>
</div>
      
<div class="row" style="justify-content:flex-end;">
  <button
    id="btnToggleTodoList"
    class="btn ghost sm"
    title="Show or hide the task list"
  >
    ▤ Hide List
  </button>
</div>

      <div id="todoUnifiedList" class="list"></div>
      <div id="todoEmpty" class="empty" style="display:none;">Nothing matches this scope.</div>
    </div>
  `);

  const $bar = document.getElementById('todoScopeBar');
  const $list = document.getElementById('todoUnifiedList');
  const $empty = document.getElementById('todoEmpty');
  // Render the list based on current scope + quick chips
  function compute() {
  // Base task set: all open tasks (calendar uses this, unfiltered)
const baseTasks = cache.tasks.filter(tk => tk.status !== 'done');
const summary = getTodoSummaryCounts(baseTasks);
// List task set: starts from baseTasks, then filters are applied
 let listTasks = baseTasks.slice(); // all open tasks by default
  $bar.querySelectorAll('.pill[data-view="calendar"]').forEach(p => {
  p.classList.toggle('active', showCalendar);
});
// If no global filters are active, listTasks should show all open one-off tasks by default
listTasks = applyGlobalFilters(listTasks);

// Quick filters (list only)
if (quick.dueSoon) {
  listTasks = listTasks.filter(x => withinWeek(x.dueDate));
}

if (quick.high) {
  const lvl = (x) => (x?.priority || '').toLowerCase();
  listTasks = listTasks.filter(x => lvl(x) === 'high' || lvl(x) === 'urgent');
}

if ($list) {
  $list.style.display = showList ? '' : 'none';
}
if (btnToggle) {
  btnToggle.textContent = showList ? '▤ Hide List' : '▤ Show List';
}
    // Paint
    $list.innerHTML = '';
    if (listTasks.length === 0) {
      $empty.style.display = '';
    } else {
      $empty.style.display = 'none';
      renderTaskCollection($list, listTasks);

    }
// --- Work-week calendar render (always visible) ---
const cal = document.getElementById('workWeekCalendar');
if (cal) {
  renderWorkWeekCalendar(cal, baseTasks);
}
    // UI state on the pills
    $bar.querySelectorAll('.pill[data-scope]')?.forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-scope') === scope);
    });
    $bar.querySelectorAll('.pill[data-qf]')?.forEach(p => {
      const key = p.getAttribute('data-qf');
      p.classList.toggle('active', !!quick[key]);
    });
    
    const h2 = root.querySelector('h2');
const sub = h2?.querySelector('.sub');
if (sub) {
  sub.textContent =
    summary.dueToday > 0
      ? `${summary.open} open · ${summary.dueToday} due today`
      : `${summary.open} open`;
}

  }
const btnToggle = document.getElementById('btnToggleTodoList');
btnToggle?.addEventListener('click', () => {
  showList = !showList;
  setListVisibility(LIST_KEY, showList);
  compute();
});

  // Wire
  $bar.addEventListener('click', (e) => {
    const el = e.target?.closest?.('.pill');
    if (!el) return;
    if (el.hasAttribute('data-scope')) {
      scope = el.getAttribute('data-scope');
      compute();
      
    } 
   else if (el.hasAttribute('data-view') && el.getAttribute('data-view') === 'calendar') {
  showCalendar = !showCalendar;
  workWeekOffset = 0; // reset to current week
  compute();
}
      else if (el.hasAttribute('data-qf')) {
      const key = el.getAttribute('data-qf');
      quick[key] = !quick[key];
      compute();
    }
  });

  compute();
}

  function renderProject(root, projectId) {
    const project = cache.projects.find(p => p.id === projectId);
    if (!project) { root.innerHTML = `<div class="empty">Project not found.</div>`; return; }
    let items = cache.tasks.filter(t => t.projectId === projectId && t.status !== 'done');
    items = applyGlobalFilters(items);
    const notes = cache.notes.filter(n => n.projectId === projectId).slice().reverse();

    root.insertAdjacentHTML('beforeend', `
      <div class="panel">
        <div class="row" style="align-items:flex-start;justify-content:space-between;">
          <div>
            <h2 style="--proj-color:${project.color || '#7c9cc0'}"><i class="icon ri-folder-fill project-ico" aria-hidden="true"></i>${escapeHTML(project.name)}</h2>
            <div class="sub">Status: <b>${project.status}</b> ${project.dueDate ? ` • Due: ${fmt(project.dueDate)}` : ''}</div>
          </div>
          <div class="row">
            <button class="btn" id="btnAddTaskProject">+ Task</button>
            <button class="btn secondary" id="btnAddNoteProject">+ Note</button>
            <button class="btn ghost" id="btnEditProject">Edit</button>
            <button class="btn danger" id="btnDeleteProject">Delete</button>
          </div>
        </div>
          <div class="panel">
    <h2></h2>
    <div id="projectWeekCalendar"></div>
  </div>
  
      </div>
    
      <div class="grid-2">
        <div class="panel"><h2>Tasks <span class="sub">(${items.length})</span></h2><div id="projectTaskList" class="list"></div>${items.length===0?`<div class="empty">No open tasks.</div>`:''}</div>
        <div class="panel"><h2>Notes</h2><div id="projectNotes" class="list"></div>${notes.length===0?`<div class="empty">No notes.</div>`:''}</div>
      </div>
    `);
const cal = document.getElementById('projectWeekCalendar');
if (cal) {
  workWeekOffset = 0; // reset when entering project
  renderWorkWeekCalendar(cal, items, { projectId });
}
    $('#btnAddTaskProject')?.addEventListener('click', () => openTaskDialog({ projectId }));
    $('#btnAddNoteProject')?.addEventListener('click', () => openNoteDialog({ projectId }));
    $('#btnEditProject')?.addEventListener('click', () => openProjectDialog(project));
    $('#btnDeleteProject')?.addEventListener('click', () => openDeleteProjectPrompt(project));

    renderTaskCollection($('#projectTaskList'), items);
    renderNotes($('#projectNotes'), notes);
  }
  
function renderTaskCollection(container, tasks, opts = {}) {
  // Back-compat: if a boolean was passed earlier, interpret it as recurringView
  if (typeof opts === 'boolean') opts = { recurringView: opts };
  const {
    recurringView = false,
    lastCompletedMap = new Map(),  // taskId -> completion {completedAt, note, ...}
    hideDoneForRecurring = true   // ← default: hide Done/Undo for ALL recurring tasks
  } = opts;
    if (!container) return;
    container.innerHTML = '';  
// Keep order for Shift-range selection
  const order = [];

    tasks.forEach(task => {
      order.push(task.id);
      const statusClass = task.status === 'done' ? 'status-done' :
                          task.status === 'in-progress' ? 'status-in' :
                          task.status === 'blocked' ? 'status-blocked' : 'status-todo';
      const proj = cache.projects.find(p => p.id === task.projectId);
      const typeChip = task.type === 'recurring' ? `<span class="chip"><i class="ri-loop-right-fill"></i> ${task.recurrence?.pattern || 'weekly'}</span>` : '';      
      const due = task.dueDate
  ? `<span class="chip">Due ${fmt(task.dueDate)}</span>${renderStartNowChip(task)}`
  : '';
     
// Monthly bundle progress (if present)
    let bundleChip = '';
    let bundlePanel = '';
if (task.type === 'recurring' && task.bundle?.type === 'monthly') {
  const now = new Date();
  const ym  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const source  = task.bundle.items ?? [];
  const current = (task.bundle.history?.[ym] ?? []).reduce((m, it) => (m[it.key] = it, m), {});
  const done    = source.filter(it => current[it.key]?.doneAt).length;
  const total   = source.length;

  bundleChip = `<span class="chip" title="Monthly bundle">${done}/${total} uploaded</span>`;

  const rows = source.map(it => {
    const hit   = current[it.key];
    const isOn  = !!hit?.doneAt;
    const stamp = isOn
      ? ` (${fmt(hit.doneAt, true)}${hit?.note ? ' — ' + escapeHTML(hit.note) : ''})`
      : '';
    return `
      <label class="bundle-item">
        <input type="checkbox" class="bundle-check" data-key="${escapeHTML(it.key)}" ${isOn ? 'checked' : ''} />
        <span class="label">${escapeHTML(it.label)}</span>
        <span class="meta">${isOn ? `<i class="ri-checkbox-line icon"></i>${escapeHTML(stamp)}` : ''}</span>
      </label>`;
  }).join('');

  bundlePanel = `
    <div class="bundle-panel" id="bundle-${task.id}" style="display:none; margin-top:6px; border-top:1px dashed var(--border); padding-top:6px;">
      ${rows || '<div class="sub">No items configured.</div>'}
    </div>`;
}

    // Recurring: add "Last completed" chip if we know it
      const lastObj = lastCompletedMap?.get(task.id);
    // keep the timestamp in the lower meta line
      const lastChip = (recurringView && lastObj)
      ? `<span class="chip">Last ${fmt(lastObj.completedAt, true)}</span>` : '';
    // move the COMMENT inline with the title (top line)
      const titleNoteChip = (recurringView && lastObj?.note)
      ? `<span class="note-chip" title="${escapeHTML(lastObj.note)}"><i class="ri-sticky-note-add-line"></i> ${escapeHTML(lastObj.note)}</span>` : '';


      const pri = task.priority ? `<span class="chip">Priority: ${task.priority}</span>` : '';
      const projChip = proj ? `<span class="chip"><span class="project-chip" style="background:${proj.color || '#7c9cc0'}"></span> ${escapeHTML(proj.name)}</span>` : `<span class="chip">Inbox</span>`;
      const blocked = task.status === 'blocked' ? `<span class="chip">⛔ Blocked</span>` : '';
      const completed = task.status === 'done' && task.completedDate ? `<span class="chip">Completed ${fmt(task.completedDate)}</span>` : '';
      
      const item = document.createElement('div');
      item.className = 'item task-row';
      item.draggable = true;

item.addEventListener('dragstart', (e) => {
  draggingTask = task;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', task.id);
});

item.addEventListener('dragend', () => {
  draggingTask = null;
});
      item.dataset.id = task.id;
      item.innerHTML = `
      <div class="selbox" title="Select (Shift for range)"></div>
      <div class="status-dot ${statusClass}"></div>
      <div class="content">
        <div class="title-line">
          <div class="title">${escapeHTML(task.title)}</div>
          ${titleNoteChip}
          ${task.bundle?.type === 'monthly'
          ? `<button class="btn-bundle-toggle icon-only" type="button" aria-expanded="false" title="Show bundle details">
          <i class="ri-arrow-right-s-line caret-ico" aria-hidden="true"></i>
        </button>`
          : ''}
        </div>
         <div class="row"><div class="meta">${projChip}${pri}${typeChip}</div></div>
         <div class="row"><div class="meta">${blocked}${due}${completed}${lastChip}${bundleChip}</div></div>
        ${bundlePanel}

      </div>
      <div class="actions">
        ${task.type === 'recurring' ? `<button class="btn secondary sm btn-log">Log</button>` : ''}
        ${task.type === 'recurring'
          ? ''   /* hide Done/Undo for recurring globally */
          : (task.status !== 'done'
              ? `<button class="btn ghost sm btn-done">Done</button>`
              : `<button class="btn ghost sm btn-undo">Undo</button>`)}
        <button class="btn ghost sm btn-edit">Edit</button>
        <button class="btn ghost sm btn-del">Delete</button>
      </div>
    `;

 // Reflect current selection
    if (selection.ids.has(task.id)) item.classList.add('selected');

// If this task's bundle was expanded previously, restore it (and the caret state)
  if (cache._expandedBundles && cache._expandedBundles.has(task.id)) {
  const panel = item.querySelector('.bundle-panel');
  const btn   = item.querySelector('.btn-bundle-toggle');
  if (panel) panel.style.display = '';
  if (btn)   btn.setAttribute('aria-expanded', 'true');
}

    // Selection handlers (on the square)
    item.querySelector('.selbox')?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleSelectionToggle(container, task.id, { shiftKey: e.shiftKey });
    });

      item.querySelector('.btn-edit')?.addEventListener('click', () => openTaskDialog(task));
      item.querySelector('.btn-del')?.addEventListener('click', () => deleteTask(task.id));
      item.querySelector('.btn-done')?.addEventListener('click', () => markTaskDone(task));
      item.querySelector('.btn-undo')?.addEventListener('click', () => undoTask(task));
      item.querySelector('.btn-log')?.addEventListener('click', () => {
      // Open inline comment input under this row's content area
      openInlineLogEditor(item, task, (note) => logRecurringCompletion(task, note));
    });



if (task.bundle?.type === 'monthly') {
  const panel = item.querySelector('.bundle-panel');
  const btn   = item.querySelector('.btn-bundle-toggle');
  if (btn && panel) {
    // Initialize per current visibility
    const initiallyOpen = panel.style.display !== 'none';
    btn.setAttribute('aria-expanded', initiallyOpen ? 'true' : 'false');
    if (initiallyOpen) cache._expandedBundles.add(task.id);

    btn.addEventListener('click', () => {
      const open = panel.style.display !== 'none';
      const nextOpen = !open;
      panel.style.display = nextOpen ? '' : 'none';
      btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      if (nextOpen) cache._expandedBundles.add(task.id);
      else          cache._expandedBundles.delete(task.id);
    });

   }


  // Checkbox behavior:
  //  - checking opens the inline editor (same note flow), then logs via markMonthlyBundleItem(...)
  //  - unchecking asks to confirm, then clears via clearMonthlyBundleItem(...)
  item.querySelectorAll('.bundle-check').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const key = chk.getAttribute('data-key');
      if (!key) return;

      // Uncheck → confirm and clear (unmark) or revert if canceled
      
 // Optional power-user path: Shift+click to add a note (kept for convenience)
    if (e.shiftKey && chk.checked) {
      openInlineLogEditor(item, task, async (note) => {
        await markMonthlyBundleItem(task, key, note);
      });
      return;
    }

    // Uncheck → confirm and clear (no editor)
    if (!chk.checked) {
      if (confirm('Unmark this item for this month?')) {
        clearMonthlyBundleItem(task, key);
      } else {
        chk.checked = true; // revert uncheck if canceled
      }
      return;
    }

    // Check → log immediately with no note
    markMonthlyBundleItem(task, key, null);

    });
  });

  // (Optional) Re-log when clicking label on an already-checked row
  item.querySelectorAll('.bundle-item').forEach(row => {
    const c = row.querySelector('.bundle-check');
    const label = row.querySelector('.label');
    const key = c?.getAttribute('data-key');
    if (!c || !label || !key) return;

    label.addEventListener('click', (e) => {
      if (!c.checked) return; // unchecked → 'change' will handle when checking
      e.preventDefault();
      openInlineLogEditor(item, task, async (note) => {
        await markMonthlyBundleItem(task, key, note);
      });
    });
  });
}

      container.appendChild(item);
    });
    
// Store latest order for this container and show/update the bulk bar
  selection.orderByContainer.set(container, order);
  const bar = ensureBulkBarFor(container);
  updateAllBulkbars();
// Make sure row highlights match current selection state
  refreshContainerSelectionStyles(container);


  }

// --- Work-week calendar (Monday–Friday) ------------------------
function renderWorkWeekCalendar(container, tasks, opts = {}) {
  const { projectId = null } = opts;
  if (!container) return;

  container.innerHTML = '';
  // Remember active calendar context for cross-week dragging
  activeCalendarContainer = container;
  activeCalendarTasks = tasks;
  activeCalendarOpts = opts;
// Project scoping (calendar only)
  const visibleTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;
  const monday = getMondayOfWeek(workWeekOffset);

  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      date: d,
      key: ymdLocal(d),
      label: weekdayName(d.getDay())
    });
  }

  const header = document.createElement('div');
  header.className = 'week-header';
  header.innerHTML = `
    <button class="btn ghost sm" id="btnWeekPrev">◀</button>
    <div class="week-range">
      ${fmt(days[0].date)} – ${fmt(days[4].date)}
    </div>
    <button class="btn ghost sm" id="btnWeekNext">▶</button>
  `;

  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'week-grid';
  grid.addEventListener('dragover', (e) => {
  if (!draggingTask) return;

  const rect = grid.getBoundingClientRect();
  const edgeBuffer = 48;

  if (e.clientX - rect.left < edgeBuffer) {
    scheduleWeekShift(-1);
  } else if (rect.right - e.clientX < edgeBuffer) {
    scheduleWeekShift(1);
  } else {
    clearWeekShift();
  }
});

  const byDay = new Map(days.map(d => [d.key, []]));

  visibleTasks.forEach(task => {
    if (!task.dueDate) return;
    if (byDay.has(task.dueDate)) {
      byDay.get(task.dueDate).push(task);
    }
  });

  for (const list of byDay.values()) {
    list.sort((a, b) =>
      (PRIORITY_ORDER[b.priority] ?? 0) -
      (PRIORITY_ORDER[a.priority] ?? 0) ||
      a.title.localeCompare(b.title)
    );
  }

  days.forEach(day => {
    const col = document.createElement('div');
    col.className = 'week-col';
col.addEventListener('dragover', (e) => {
  e.preventDefault(); // required to allow drop
  col.classList.add('drop-target');
});

col.addEventListener('dragleave', () => {
  col.classList.remove('drop-target');
});

col.addEventListener('drop', async (e) => {
  e.preventDefault();
  col.classList.remove('drop-target');

  if (!draggingTask) return;

  const newDue = day.key; // YYYY-MM-DD from calendar logic

  // Avoid unnecessary writes
  if (draggingTask.dueDate === newDue) return;

  await createOrUpdateTask({
    ...draggingTask,
    dueDate: newDue
  });

  draggingTask = null;
});
    col.innerHTML = `
      <div class="week-col-header">
        <div class="day">${day.label}</div>
        <div class="date sub">${fmt(day.date)}</div>
      </div>
      <div class="week-col-body"></div>
    `;

    const body = col.querySelector('.week-col-body');
    const items = byDay.get(day.key) ?? [];

    if (!items.length) {
      body.innerHTML = `<div class="empty sub">—</div>`;
    } else {
      items.forEach(task => {
        const card = document.createElement('div');
        const pri = task.priority || 'medium';
        const est = formatEstimatedMinutes(task.estimatedMinutes);

        card.className = `week-task priority-${pri}`;
        if (isTaskInStartWindow(task)) card.classList.add('start-now');
        card.draggable = true;

card.addEventListener('dragstart', (e) => {
  draggingTask = task;
  card.classList.add('dragging');

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', task.id);
});

card.addEventListener('dragend', () => {
  draggingTask = null;
  card.classList.remove('dragging');
});

        card.innerHTML = `
          <div class="title">${escapeHTML(task.title)}</div>
          <div class="meta sub">
            ${task.type === 'recurring' ? '<div><i class="ri-loop-right-fill"></i></div>' : ''}
            ${est ? `<div><i class="ri-timer-line"></i>${est}</div>` : ''}
            ${isTaskInStartWindow(task) ? '<div><i class="ri-hourglass-2-fill"></i>Start Now</div>' : ''}

          </div>
        `;

        card.addEventListener('click', () => openTaskDialog(task));
        body.appendChild(card);
      });
    }

    grid.appendChild(col);
  });

  container.appendChild(grid);

  document.getElementById('btnWeekPrev')?.addEventListener('click', () => {
    workWeekOffset--;
    renderWorkWeekCalendar(container, tasks);
  });

  document.getElementById('btnWeekNext')?.addEventListener('click', () => {
    workWeekOffset++;
    renderWorkWeekCalendar(container, tasks);
  });
}
function getVisibleNoteIds(notes) {
  return notes.map(n => n.id);
}
function renderNotes(container, notes) {
  if (!container) return;
  // const isSelectingNotes = noteSelection.ids.size > 0;
  container.innerHTML = '';
// ---- Notes bulk action bar ----
  const bulkBar = renderNotesBulkBar(container, notes);
  if (bulkBar) {
    container.appendChild(bulkBar);
  }

  // Ensure only one inline editor is open at a time
  let editingId = null;

  const enterInlineEdit = (card, note) => {
    editingId = note.id;
    // Left panel (content)
    const content = card.querySelector('.note-content');
    
const meta = document.createElement('div');
    meta.className = 'sub';
    const proj = cache.projects.find(p => p.id === note.projectId);
    meta.innerHTML = `
      ${fmt(note.createdAt, true)}
      ${proj ? ` • <span class="chip"><span class="project-chip" style="background:${proj.color || '#7c9cc0'}"></span> ${escapeHTML(proj.name)}</span>` : ''}
    `;
    // (2) Add a small "Editing" chip while in edit mode
    const editingChip = document.createElement('span');
    editingChip.className = 'chip';
    editingChip.textContent = 'Editing...';
    editingChip.style.marginLeft = '6px';
    meta.appendChild(editingChip);

    const textarea = document.createElement('textarea');
    textarea.value = note.text || '';
    textarea.style.width = '100%';
    textarea.style.minHeight = '72px';
    textarea.style.overflow = 'hidden';
    textarea.style.resize = 'none';

    const row = document.createElement('div');
    row.className = 'row';
    const sel = makeProjectSelect(note.projectId);
    // Prevent editor interactions from re-triggering note click handlers
sel.addEventListener('click', e => e.stopPropagation());
sel.addEventListener('mousedown', e => e.stopPropagation());
sel.addEventListener('change', e => e.stopPropagation());
    const btnSave = document.createElement('button');
    btnSave.className = 'btn'; btnSave.textContent = 'Save';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn secondary'; btnCancel.textContent = 'Cancel';
    row.appendChild(sel);
    row.appendChild(btnSave);
    row.appendChild(btnCancel);
    btnSave.addEventListener('click', e => e.stopPropagation());
    btnCancel.addEventListener('click', e => e.stopPropagation());

    // Replace content area with editor
    content.innerHTML = '';
    content.appendChild(meta);
    content.appendChild(textarea);
    textarea.addEventListener('click', e => e.stopPropagation());
    textarea.addEventListener('mousedown', e => e.stopPropagation());
    content.appendChild(row);
    
// Focus & place caret at the end
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

    // (1) Auto-expand textarea to fit content (with a soft max)
    const autoSize = () => {
      textarea.style.height = 'auto';
      // Set a soft max height to avoid overly tall cards; tweak as desired
      const max = 320; // px
      textarea.style.height = Math.min(max, textarea.scrollHeight) + 'px';
    };
    textarea.addEventListener('input', autoSize);
    // First paint
    setTimeout(autoSize, 0);


    // Save handlers
    const doSave = async () => {
      const payload = {
        id: note.id,
        projectId: sel.value || null,
        text: textarea.value.trim(),
        createdAt: note.createdAt // preserve
      };
      await createOrUpdateNote(payload);
      editingId = null;
    };
    const doCancel = () => {
      // Re-render just this card by forcing a full list re-render (simple & safe)
      renderNotes(container, notes);
      editingId = null;
    };
    btnSave.addEventListener('click', doSave);
    btnCancel.addEventListener('click', doCancel);
    textarea.addEventListener('keydown', (e) => {
      // (3) Keyboard: Esc = cancel; Ctrl/Cmd+Enter = save; Shift+Enter = newline
      if (e.key === 'Escape') { e.preventDefault(); doCancel(); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); return; }
      // If Shift+Enter: allow natural newline (no need to preventDefault)
      // If plain Enter: also allow newline (textarea default)
      // Auto-size on Enter after DOM updates
      if (e.key === 'Enter') {
        // Defer to next frame so scrollHeight reflects the new line
        requestAnimationFrame(autoSize);
      }
    });
  };

  notes.forEach(n => {
    const proj = cache.projects.find(p => p.id === n.projectId);
    const el = document.createElement('div');
    el.className = 'item note-row';
    el.dataset.id = n.id;
    el.innerHTML = `
      <input
  type="checkbox"
  class="note-checkbox"
  aria-label="Select note"
  ${noteSelection.ids.has(n.id) ? 'checked' : ''}
/>
<div class="note-content" style="grid-column: 2 / span 2; cursor: text;">

        <div class="sub">
          ${fmt(n.createdAt, true)}
          ${proj ? ` • <span class="chip"><span class="project-chip" style="background:${proj.color || '#7c9cc0'}"></span> ${escapeHTML(proj.name)}</span>` : ''}
        </div>
        <div class="title" style="margin-top:4px;">${escapeHTML(n.text)}</div>
        <span class="chip start-now note-hint">
        <i class="ri-edit-line"></i>Click to edit
        </span>

      <div class="row">
        <button class="btn ghost btn-note-del"><i class="ri-delete-bin-6-line icon"></i></button>
      </div>
    `;

    // Click-to-edit on the content area
    // el.querySelector('.note-content')?.addEventListener('click', () => {
    //   if (editingId && editingId !== n.id) return; // allow one editor at a time
    //   enterInlineEdit(el, n);
    // });
 // Checkbox-driven note selection
const checkbox = el.querySelector('.note-checkbox');
checkbox?.addEventListener('click', (e) => {
  e.stopPropagation(); // don't trigger edit
});


checkbox?.addEventListener('change', () => {
  editingId = null;

  if (checkbox.checked) {
    noteSelection.ids.add(n.id);
  } else {
    noteSelection.ids.delete(n.id);
  }

  const main = document.getElementById('main');
  const scrollTop = main?.scrollTop ?? 0;

  render();

  // Restore scroll position on next frame
  requestAnimationFrame(() => {
    if (main) main.scrollTop = scrollTop;
  });
});

if (noteSelection.ids.has(n.id)) {
  el.classList.add('selected');
}   
el.querySelector('.note-content')?.addEventListener('click', (e) => {
  // If this note is already being edited, do nothing
  if (editingId === n.id) return;

  if (editingId && editingId !== n.id) return;
  enterInlineEdit(el, n);
});

    // Delete button
    el.querySelector('.btn-note-del')?.addEventListener('click', () => deleteNote(n.id));

    container.appendChild(el);
  });
}

  /** ---------------- CRUD & Actions ---------------------------------------- */
  async function createOrUpdateProject(data) {
    const now = new Date().toISOString();
    const p = data?.id ? data : { ...data, id: uuid(), createdAt: now };
    p.updatedAt = now;
    const { stores } = tx(STORES.projects, 'readwrite');
    await put(stores[STORES.projects], p);
    await loadAll(); render();
    return p;
  }
  async function createOrUpdateTask(data) {
    const now = new Date().toISOString();
    const t = data?.id ? data : { ...data, id: uuid(), createdAt: now };
    t.updatedAt = now;
    const { stores } = tx(STORES.tasks, 'readwrite');
    await put(stores[STORES.tasks], t);
    await loadAll(); render();
  }
  async function deleteTask(id) {
    if (!confirm('Delete this task?')) return;
    const { stores } = tx(STORES.tasks, 'readwrite');
    await delByKey(stores[STORES.tasks], id);
    await loadAll(); render();
  }
  async function markTaskDone(task) {
    if (task.type === 'recurring') { await logRecurringCompletion(task); return; }
    const now = new Date().toISOString();
    await createOrUpdateTask({ ...task, status: 'done', completedDate: now });
  }
  async function undoTask(task) {
    await createOrUpdateTask({ ...task, status: 'todo', completedDate: null });
  }

async function logRecurringCompletion(task, note = null) {
  const completedAt = new Date();
  const pattern = task?.recurrence?.pattern || 'weekly';
  const aw = cache.settings?.anchorWeekday;

  // Determine current cycle window (for logs) and next cycle boundaries (for the task)
  let periodStart = null, periodEnd = null, nextStart = null, nextDue = null;
  if (pattern === 'monthly') {
    // Current cycle is the month of 'completedAt'
    periodStart = firstDayOfMonth(completedAt);
    periodEnd   = Number.isInteger(aw)
      ? lastAnchorWeekdayOfMonth(completedAt.getFullYear(), completedAt.getMonth(), aw)
      : lastCalendarDayOfMonth(completedAt.getFullYear(), completedAt.getMonth());
    nextStart = firstDayOfNextMonth(completedAt);
    nextDue   = nextDueForRecurring(task, completedAt); // end of next month (anchored if set)
  } else {
    // Existing behavior for daily/weekly/biweekly
    nextDue = nextDueForRecurring(task, completedAt);
  }
    const completion = {
    id: uuid(),
    taskId: task.id,
    completedAt: completedAt.toISOString(),
    periodStart: periodStart ? periodStart.toISOString() : (task.dueDate ? new Date(task.dueDate).toISOString() : null),
    periodEnd:   periodEnd   ? periodEnd.toISOString()   : nextDue.toISOString(),
    note: note && note.trim() ? note.trim() : null
  };
  const updatedTask = {
    ...task,
    completedDate: completedAt.toISOString(),
    startDate: (pattern === 'monthly' && nextStart) ? toISODate(nextStart) : (task.startDate || null),
    dueDate: toISODate(nextDue),

    updatedAt: new Date().toISOString()
  };
  const { stores } = tx([STORES.tasks, STORES.completions], 'readwrite');
  await put(stores[STORES.tasks], updatedTask);
  await add(stores[STORES.completions], completion);
  await loadAll();
  render();
}

async function deleteProject(projectId, { mode = 'move' } = {}) {
  // mode: 'move' = move dependents to Inbox (projectId=null)
  //       'hard' = delete dependents too (destructive)

  const now = new Date().toISOString();
  const { t, stores } = tx([STORES.projects, STORES.tasks, STORES.notes], 'readwrite');

  if (mode === 'move') {
    // Re-home tasks & notes to Inbox (projectId = null)
    const tasks = cache.tasks.filter(x => x.projectId === projectId);
    for (const task of tasks) {
      await put(stores[STORES.tasks], { ...task, projectId: null, updatedAt: now });
    }
    const notes = cache.notes.filter(x => x.projectId === projectId);
    for (const note of notes) {
      await put(stores[STORES.notes], { ...note, projectId: null, updatedAt: now });
    }
  } else if (mode === 'hard') {
    // Permanently delete tasks & notes for this project
    const tasks = cache.tasks.filter(x => x.projectId === projectId);
    for (const task of tasks) await delByKey(stores[STORES.tasks], task.id);
    const notes = cache.notes.filter(x => x.projectId === projectId);
    for (const note of notes) await delByKey(stores[STORES.notes], note.id);
  }

  // Finally, delete the project
  await delByKey(stores[STORES.projects], projectId);

  // Complete transaction then refresh in one go
  await new Promise(res => t.oncomplete = res);
  await loadAll();

  // If we were viewing that project, bounce to Dashboard (or Projects root)
  if (currentView.type === 'project' && currentView.id === projectId) {
    setView({ type: 'dashboard' });
  } else {
    render();
  }
}

// Mark one item in a monthly bundle for *this month*, stamping doneAt and optional note.
async function markMonthlyBundleItem(task, key, note) {
  if (!(task?.bundle?.type === 'monthly')) return;
  const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const source = Array.isArray(task.bundle.items) ? task.bundle.items : [];
  if (!source.find(it => it.key === key)) return;
  const history = { ...(task.bundle.history || {}) };
  const row = (history[ym] || []).slice();
  const idx = row.findIndex(it => it.key === key);
  const payload = { key, doneAt: now.toISOString(), note: note && note.trim() ? note.trim() : null };
  if (idx >= 0) row[idx] = payload; else row.push(payload);
  history[ym] = row;
  const updated = { ...task, bundle: { ...task.bundle, history }, updatedAt: new Date().toISOString() };
  const label = (source.find(it => it.key === key)?.label ?? key);

  // Write task update + a completion log entry (so Weekly Review / Completed pick it up)
  const { stores } = tx([STORES.tasks, STORES.completions], 'readwrite');
  await put(stores[STORES.tasks], updated);
  await add(stores[STORES.completions], {
    id: uuid(),
    taskId: task.id,
    completedAt: now.toISOString(),
    note: payload.note ? `Bundle • ${label} — ${payload.note}` : `Bundle • ${label}`,
    // harmless extra fields for filtering/debugging
    bundleKey: key,
    bundleLabel: label,
    kind: 'bundle'
  });
  await loadAll(); render();
}

async function loadAllCompletions() {
  const { stores } = tx(STORES.completions, 'readonly');
  return await getAll(stores[STORES.completions]);
}

// Map taskId -> latest completion *object* (includes .completedAt and .note)
async function getLastCompletionByTaskId() {
  const all = await loadAllCompletions();
  const last = new Map();
  for (const c of all) {
    const prev = last.get(c.taskId);
    if (!prev || new Date(c.completedAt) > new Date(prev.completedAt)) last.set(c.taskId, c);
  }
  return last;
}

// Clear one item in the current month’s bundle history (unmark)
async function clearMonthlyBundleItem(task, key) {
  if (!(task?.bundle?.type === 'monthly')) return;
  const now = new Date();
  const ym  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const history = { ...(task.bundle.history ?? {}) };
  const row = (history[ym] ?? []).filter(it => it.key !== key);

  if (row.length === 0) {
    delete history[ym];
  } else {
    history[ym] = row;
  }

  const updated = { ...task, bundle: { ...task.bundle, history }, updatedAt: new Date().toISOString() };
  
const { stores } = tx([STORES.tasks, STORES.completions], 'readwrite');
  await put(stores[STORES.tasks], updated);

  // Delete the completion(s) for this task+bundleKey in the same month (ym)
  const all = await getAll(stores[STORES.completions]);
  const toDelete = all.filter(c => {
    if (c.taskId !== task.id) return false;
    if (c.bundleKey !== key) return false;
    if (!c.completedAt) return false;
    const d = new Date(c.completedAt);
    const y2 = d.getFullYear();
    const m2 = String(d.getMonth() + 1).padStart(2,'0');
    return `${y2}-${m2}` === ym;
  });
  for (const c of toDelete) await delByKey(stores[STORES.completions], c.id);

  await loadAll(); render();
}
async function renderRecurring(root) {
  // 1) Collect recurring tasks
  const items = cache.tasks.filter(t => t.type === 'recurring');

  // 2) Paint panel shell (header + list container)
  root.insertAdjacentHTML('beforeend', `
    <div class="panel">
      <div class="row" style="justify-content:space-between;">
        <h2>Recurring <span class="sub">(${items.length})</span></h2>
        <div class="row">
          <button id="btnAddTaskRecurring" class="btn">+ New Task</button>
          <button id="btnAddNoteRecurring" class="btn secondary">+ Note</button>
        </div>
      </div>
      <div id="recurringList" class="list"></div>
      ${items.length === 0 ? `<div class="empty">No recurring tasks yet.</div>` : ''}
    </div>
  `);

  // 3) Wire header buttons
  document.getElementById('btnAddTaskRecurring')?.addEventListener('click', () => openTaskDialog());
  document.getElementById('btnAddNoteRecurring')?.addEventListener('click', () => openNoteDialog());

  // 4) Build 'last completed' lookup from completions store
  const lastMap = await getLastCompletionByTaskId();

  // 5) Render list with:
  //    - recurringView=true => add 'Last …' chip
  //    - lastCompletedMap   => provide timestamps
  //    - hideDoneForRecurring=true => only show Log/Edit/Delete for recurring rows
  const listEl = document.getElementById('recurringList');
  const filtered = applyGlobalFilters(items); // keep your Priority/Sort filters
  renderTaskCollection(listEl, filtered, {
    recurringView: true,
    lastCompletedMap: lastMap,
    hideDoneForRecurring: true
  });
}


async function renderCompleted(root) {
    // One-off tasks that are done
    let oneOffs = cache.tasks.filter(t => t.type === 'one-off' && t.status === 'done');
    oneOffs = applyGlobalFilters(oneOffs, { ignoreStatus: true }).sort((a,b) =>
      (b.completedDate || '').localeCompare(a.completedDate || '')
    );

    // Recurring completion logs (instances)
    const allLogs = await loadAllCompletions();
    const rows = allLogs
      .map(c => {
        const t = cache._taskById?.get(c.taskId) || cache.tasks.find(x => x.id === c.taskId);
        if (!t) return null;
        return { id: c.id, title: t.title, projectId: t.projectId, completedAt: c.completedAt, note: c.note || '' };
      })
      .filter(Boolean)
      .sort((a,b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

// Side‑by‑side containers (uses existing .grid-2 which already collapses on small screens)
  root.insertAdjacentHTML('beforeend', `
    <div class="grid-2">
      <div class="panel">
        <h2>Completed — One‑off <span class="sub">(${oneOffs.length})</span></h2>
        <div id="completedOneOff" class="list"></div>
        ${oneOffs.length === 0 ? `<div class="empty">No one‑off tasks completed yet.</div>` : ''}
      </div>
      <div class="panel">
        <h2>Completed — Recurring logs <span class="sub">(${rows.length})</span></h2>
        <div id="completedRecurring" class="list"></div>
        ${rows.length === 0 ? `<div class="empty">No recurring logs yet.</div>` : ''}
      </div>
    </div>
  `);

    // Reuse task row renderer for one‑offs (read-only actions still appear; that's fine)
    renderTaskCollection(document.getElementById('completedOneOff'), oneOffs);

    // Build a simple list for recurring logs
    const list = document.getElementById('completedRecurring');
    if (list) {
      list.innerHTML = '';
      rows.forEach(r => {
        const proj = cache.projects.find(p => p.id === r.projectId);
        
  // Detect bundle note shape: "Bundle • <label>" or "Bundle • <label> — <extra>"
      let bundleLabel = null, bundleExtra = null;
      if (typeof r.note === 'string' && r.note.startsWith('Bundle')) {
        const m = r.note.match(/^Bundle\s*•\s*([^—]+?)(?:\s*—\s*(.+))?$/);
        if (m) { bundleLabel = m[1]?.trim() || null; bundleExtra = m[2]?.trim() || null; }
      }
      // Compose project-chip text: plain "<Project>" OR "<Project> 📝 label[- note]" for bundle logs
      const projectName = proj ? proj.name : 'Inbox';
      const projectChipText = bundleLabel
        ? `${projectName} 📝 ${bundleLabel}${bundleExtra ? ' - ' + bundleExtra : ''}`
        : projectName;

        const el = document.createElement('div');
        el.className = 'item task-row';
        el.innerHTML = `
        <!-- visual-only selbox so grid matches one-off rows -->
        <div class="selbox" aria-hidden="true" style="opacity:.25; pointer-events:none;"></div>
        <div class="content">
          <div class="title-line">
            <div class="title">${escapeHTML(r.title)}</div>
          </div>
          <div class="row"><div class="meta">
            <span class="chip">
              ${proj ? `<span class="project-chip" style="background:${proj.color ?? '#7c9cc0'}"></span>` : ''}
              ${escapeHTML(projectChipText)}
            </span>
          </div></div>
          <div class="row"><div class="meta">
            <span class="chip">Completed ${fmt(r.completedAt, true)}</span>
            ${(!bundleLabel && r.note) ? `<span class="chip"><i class="ri-sticky-note-add-line"></i> ${escapeHTML(r.note)}</span>` : ''}
           
          </div></div>
        </div>
        <div class="actions">
          <button class="btn ghost sm btn-del-log" title="Delete log">Delete</button>
        </div>
      `;

        el.querySelector('.btn-del-log')?.addEventListener('click', async () => {
          if (!confirm('Delete this recurring log entry?')) return;
          await deleteCompletion(r.id);
        });

        list.appendChild(el);
      });
    }
  }

async function deleteCompletion(id) {
  const { stores } = tx(STORES.completions, 'readwrite');
  await delByKey(stores[STORES.completions], id);
  await loadAll(); render();
}
async function renderInsights(root) {

  root.innerHTML = '';

  root.insertAdjacentHTML('beforeend', `
    <div class="panel">
      <h2>Insights</h2>
      <div class="sub">
        Your sleep and mood entries, shown over time.
      </div>
      
    <div class="grid-2" style="margin-top:12px;">
      <div class="item">
        <div class="title">Avg Sleep (7 days)</div>
        <div id="insightAvgSleep" class="chip">—</div>
      </div>

      <div class="item">
        <div class="title">Avg mood (7 days)</div>
        <div id="insightAvgMood" class="chip">—</div>
      </div>
    </div>

    </div>

    <div class="grid-2" style="margin-top:12px;">

    <div class="panel">
      <h2><i class="ri-moon-fill"></i>Sleep</h2>

      <!-- Sleep logging -->
      <div class="metric-form">
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
          <label class="kbd">(hrs)</label>
          <input id="sleepValue" type="number" min="0" max="24" step="0.25" />
          <input id="sleepDate" type="date" />
          <button class="btn primary" id="btnSleepLog">Log</button>
          <button class="btn secondary" id="btnSleepCancel" disabled>Cancel</button>
        </div>
      </div>

      <div class="divider"></div>

      <div id="insightSleepList" class="list"></div>
    </div>

    <div class="panel">
     <h2><i class="ri-brain-2-fill"></i>Mood</h2>
      <!-- Mood logging -->
      <div class="metric-form">
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
          <label class="kbd">(1–5)</label>
          <input id="moodValue" type="number" min="1" max="5" step="1" />
         <input id="moodDate" type="date" />
          <button class="btn primary" id="btnMoodLog">Log</button>
          <button class="btn secondary" id="btnMoodCancel" disabled>Cancel</button>
        </div>
      </div>

      <div class="divider"></div>

      <div id="insightMoodList" class="list"></div>
    </div>

    </div>
  `);
  const today = todayISO();
  const sd = document.getElementById('sleepDate');
  const md = document.getElementById('moodDate');
  if (sd && !sd.value) sd.value = today;
  if (md && !md.value) md.value = today;
  // Load data asynchronously (same pattern as Completed)
  try {
    const [sleepRows, moodRows] = await Promise.all([
      getAllMetricsOfType('sleep'),
      getAllMetricsOfType('mood')
    ]);
  const days7 = new Set(lastNDaysISO(7));

  const sleep7 = sleepRows
    .filter(r => days7.has(r.date))
    .map(r => Number(r.value))
    .filter(Number.isFinite);

  const mood7 = moodRows
    .filter(r => days7.has(r.date))
    .map(r => Number(r.value))
    .filter(Number.isFinite);

  const avgSleep = average(sleep7);
  const avgMood  = average(mood7);

  const sleepEl = document.getElementById('insightAvgSleep');
  const moodEl  = document.getElementById('insightAvgMood');

  if (sleepEl) {
    sleepEl.textContent =
      avgSleep == null ? '—' : `${avgSleep.toFixed(1)} h`;
  }

  if (moodEl) {
    moodEl.textContent =
      avgMood == null ? '—' : `${avgMood.toFixed(1)} / 5`;
  }
  // --- Sleep logging ---
  document.getElementById('btnSleepLog')?.addEventListener('click', async () => {
    const value = Number(document.getElementById('sleepValue')?.value);
    const date  = document.getElementById('sleepDate')?.value;

    if (!Number.isFinite(value) || value < 0 || value > 24) {
      alert('Enter sleep in hours (0–24).');
      return;
    }
    if (!date) return;

    await upsertMetric({
    id: editingSleepId ?? uuid(),
    type: 'sleep',
    value,
    date
  });

  editingSleepId = null;

    // reset inputs
    document.getElementById('sleepValue').value = '';
    document.getElementById('sleepDate').value = todayISO();
    document.getElementById('btnSleepLog').textContent = 'Log';
    document.getElementById('btnSleepCancel').disabled = true;
  
  document.getElementById('btnSleepCancel')?.addEventListener('click', () => {
   editingSleepId = null;
   document.getElementById('sleepValue').value = '';
   document.getElementById('sleepDate').value  = todayISO();
   document.getElementById('btnSleepLog').textContent = 'Log';
   document.getElementById('btnSleepCancel').disabled = true;
   renderInsights(document.getElementById('main'));
 });


    renderInsights(document.getElementById('main'));
  });
  
  // --- Mood logging ---
  document.getElementById('btnMoodLog')?.addEventListener('click', async () => {
    const value = Number(document.getElementById('moodValue')?.value);
    const date  = document.getElementById('moodDate')?.value;

    if (!Number.isFinite(value) || value < 1 || value > 5) {
      alert('Enter mood from 1 to 5.');
      return;
    }
    if (!date) return;


  await upsertMetric({
    id: editingMoodId ?? uuid(),
    type: 'mood',
    value,
    date
  });

  editingMoodId = null;


    // reset inputs
    document.getElementById('moodValue').value = '';
    document.getElementById('moodDate').value = todayISO();
    document.getElementById('btnMoodLog').textContent = 'Log';
    document.getElementById('btnMoodCancel').disabled = true;
 
  document.getElementById('btnMoodCancel')?.addEventListener('click', () => {
   editingSleepId = null;
   document.getElementById('moodValue').value = '';
   document.getElementById('moodDate').value  = todayISO();
   document.getElementById('btnMoodLog').textContent = 'Log';
   document.getElementById('btnMoodCancel').disabled = true;
   renderInsights(document.getElementById('main'));
 });

    renderInsights(document.getElementById('main'));
  });
``
 renderMetricList(
  document.getElementById('insightSleepList'),
  sleepRows,
  {
    label: 'Sleep',
    formatValue: v => `${v} hours`,
    onDelete: async (id) => {
      await deleteMetric(id);
    }
  }
);

renderMetricList(
  document.getElementById('insightMoodList'),
  moodRows,
  {
    label: 'Mood',
    formatValue: v => `Mood ${v} / 5`,
    onDelete: async (id) => {
      await deleteMetric(id);
    }
  }
);

  } catch (err) {
    console.warn('[insights] failed to load metrics', err);
  }
}
  function startSleepEdit(entry) {
    editingSleepId = entry.id;
    document.getElementById('sleepValue').value = entry.value;
    document.getElementById('sleepDate').value  = entry.date;
    document.getElementById('btnSleepLog').textContent = 'Save';
    document.getElementById('btnSleepCancel').disabled = false;
  }

  function startMoodEdit(entry) {
    editingMoodId = entry.id;
    document.getElementById('moodValue').value = entry.value;
    document.getElementById('moodDate').value  = entry.date;
    document.getElementById('btnMoodLog').textContent = 'Save';
    document.getElementById('btnMoodCancel').disabled = false;
  }
 function average(arr) {
   if (!arr.length) return null;
   return arr.reduce((a, b) => a + b, 0) / arr.length;
 }

 function lastNDaysISO(n) {
   const res = [];
   const d = new Date();
   for (let i = 0; i < n; i++) {
     res.push(todayISO(d));
     d.setDate(d.getDate() - 1);
   }
   return res;
 }
async function getAllMetricsOfType(type) {
  const { stores } = tx(STORES.metrics, 'readonly');
  const all = await getAll(stores[STORES.metrics]);
  return all
    .filter(m => m.type === type)
    .sort((a, b) => b.date.localeCompare(a.date));
}
function renderMetricList(container, rows, { label, formatValue, onDelete }) {
  if (!container) return;
  container.innerHTML = '';

  if (rows.length === 0) {
    container.innerHTML = `<div class="empty">No ${label.toLowerCase()} logs yet.</div>`;
    return;
  }

  rows.forEach(r => {
    const el = document.createElement('div');
    el.className = 'item';

  if (label === 'Sleep' && editingSleepId === r.id) {
    el.classList.add('editing');
  }
  if (label === 'Mood' && editingMoodId === r.id) {
    el.classList.add('editing');
  }
  el.querySelector('.btn-edit')?.addEventListener('click', () => {
    if (label === 'Sleep') startSleepEdit(r);
    if (label === 'Mood') startMoodEdit(r);
  });

    el.innerHTML = `
      <div class="content">
        <div class="title">${formatValue(r.value)}</div>
        <div class="sub">${fmt(r.date)}</div>
      </div>
      <div class="actions">
        <button class="btn ghost sm btn-edit">Edit</button>
        <button class="btn ghost sm btn-delete">Delete</button>
      </div>
    `;
    el.querySelector('.btn-edit')?.addEventListener('click', () => {
  if (label === 'Sleep') {
    editingSleepId = r.id;

    document.getElementById('sleepValue').value = r.value;
    document.getElementById('sleepDate').value  = r.date;

    document.getElementById('btnSleepLog').textContent = 'Save';
    document.getElementById('btnSleepCancel').disabled = false;
  }
});
document.getElementById('btnSleepCancel')?.addEventListener('click', () => {
  editingSleepId = null;

  document.getElementById('sleepValue').value = '';
  document.getElementById('sleepDate').value  = todayISO();

  document.getElementById('btnSleepLog').textContent = 'Log';
  document.getElementById('btnSleepCancel').disabled = true;
});
el.querySelector('.btn-edit')?.addEventListener('click', () => {
  if (label === 'Mood') {
    editingMoodId = r.id;

    document.getElementById('moodValue').value = r.value;
    document.getElementById('moodDate').value  = r.date;

    document.getElementById('btnMoodLog').textContent = 'Save';
    document.getElementById('btnMoodCancel').disabled = false;
  }
});
document.getElementById('btnMoodCancel')?.addEventListener('click', () => {
  editingSleepId = null;

  document.getElementById('moodValue').value = '';
  document.getElementById('moodDate').value  = todayISO();

  document.getElementById('btnMoodLog').textContent = 'Log';
  document.getElementById('btnMoodCancel').disabled = true;
});

    // ✅ DELETE — already working
    el.querySelector('.btn-delete')?.addEventListener('click', async () => {
      if (!confirm(`Delete this ${label.toLowerCase()} entry?`)) return;
      await onDelete(r.id);
      render();
    });

    container.appendChild(el);
  });
}

// ================= Notes (inline edit) =================
async function createOrUpdateNote(data) {
  const now = new Date().toISOString();
  // If updating: keep id/createdAt, bump updatedAt
  const n = data?.id
    ? { ...data, updatedAt: now }
    : { ...data, id: uuid(), createdAt: now, updatedAt: now };
  const { stores } = tx(STORES.notes, 'readwrite');
  await put(stores[STORES.notes], n);
  await loadAll(); render();
  return n;
}

async function deleteNote(id) {
  if (!confirm('Delete this note?')) return;
  const { stores } = tx(STORES.notes, 'readwrite');
  await delByKey(stores[STORES.notes], id);
  await loadAll(); render();
}

function makeProjectSelect(selectedId) {
  const sel = document.createElement('select');
  sel.className = 'inline-note-project';
  // Placeholder / no-project
  const optNone = document.createElement('option');
  optNone.value = ''; optNone.textContent = '— No project';
  sel.appendChild(optNone);
  // Existing projects
  for (const p of cache.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = selectedId || '';
  return sel;
}
async function deleteMetric(id) {
  const { stores } = tx(STORES.metrics, 'readwrite');
  await delByKey(stores[STORES.metrics], id);
}

  /** ---------------- Dialogs (robust versions) ----------------------------- */
  function refreshProjectOptions(selectEls = [$('#taskProject'), $('#noteProject')]) {
    selectEls.forEach(sel => {
      if (!sel) return;
      const preserve = sel.value;
      if (sel.id === 'taskProject') {
        sel.innerHTML = `<option value="">— No project (Inbox)</option>`;
      } else if (sel.id === 'quickProject') {
        sel.innerHTML = `<option value="">Inbox</option>`;
      } else {
        sel.innerHTML = `<option value="">— No project</option>`;
      }
      for (const p of cache.projects) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      }
      if (sel.id === 'quickProject') {
        const newOpt = document.createElement('option');
        newOpt.value = '_new';
        newOpt.textContent = '➕ New Project';
        sel.appendChild(newOpt);
      }
      sel.value = preserve || sel.value || '';
    });
    setQuickAddPlaceholder();
  }

  function openProjectDialog(project = null) {
    const dlg = $('#dlgProject'); if (!dlg) return;
    $('#dlgProjectTitle').textContent = project ? 'Edit Project' : 'New Project';
    $('#projName').value = project?.name || '';
    $('#projStatus').value = project?.status || 'active';
    $('#projColor').value = project?.color || '#3aa6a0';
    $('#projDue').value = project?.dueDate || '';

// Ensure visible for native <dialog> on subsequent opens
    dlg.style.display = '';
    wireDateLabelPickers(dlg);  // ✅ add this line if it isn’t already here
    dlg.showModal();

    $('#btnProjectCancel')?.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); dlg.close();
    }, { once: true });

    const form = $('#formProject');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const action = e.submitter?.value || 'ok';
      if (action === 'cancel') { dlg.close(); return; }
      await createOrUpdateProject({
        id: project?.id,
        name: $('#projName').value.trim(),
        status: $('#projStatus').value,
        color: $('#projColor').value,
        dueDate: $('#projDue').value || null
      });
      dlg.close();
    };
  }
  function wireDateLabelPickers(root = document) {
  // Accept either a Document or an Element (e.g., a <dialog>)
  const scopeEl = (root instanceof Element || root instanceof Document) ? root : document;
  const q = (sel) => scopeEl.querySelector(sel);
  const escId = (s) => (window.CSS && typeof CSS.escape === 'function' ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  scopeEl.querySelectorAll('.field').forEach(field => {
    const icon  = field.querySelector('.label-ico');
    const label = field.querySelector('label[for]');
    if (!icon || !label) return;
    const inputId = label.getAttribute('for');
    // If scope is an Element (dialog), use querySelector; it doesn't have getElementById
    const input   = inputId ? (scopeEl instanceof Document ? scopeEl.getElementById(inputId) : q(`[id="${escId(inputId)}"]`)) : null;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'date') return;
    if (icon._ptBound) return;
    icon._ptBound = true;
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof input.showPicker === 'function') {
          input.showPicker();
        } else {
          input.focus();
          const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
          input.dispatchEvent(evt);
        }
      } catch {
        input.focus();
      }
    });
  });
}

  function openTaskDialog(taskOrOpts) {
    const isEdit = taskOrOpts && taskOrOpts.id;
    const presetProjectId = (!isEdit && taskOrOpts && taskOrOpts.projectId) ? taskOrOpts.projectId : null;
    const task = isEdit ? taskOrOpts : null;

    const dlg = $('#dlgTask'); if (!dlg) return;
    $('#dlgTaskTitle').textContent = isEdit ? 'Edit Task' : 'New Task';

    const title = $('#taskTitle'); const proj = $('#taskProject'); const type = $('#taskType');
    const recWrap = $('#recurrenceWrap'); const recSel = $('#taskRecurrence');
    const weeklyWrap = $('#weeklyDayWrap'); const weeklyDaySel = $('#taskWeeklyDay');
    const bundleWrap = $('#bundleWrap'); const bundleItems = $('#bundleItems');
    const status = $('#taskStatus'); const priority = $('#taskPriority');
    const start = $('#taskStart'); const due = $('#taskDue');
    // Estimated time inputs
    const estDays = $('#taskEstDays');
    const estHours = $('#taskEstHours');
    const estMinutes = $('#taskEstMinutes');


    refreshProjectOptions([proj]);
    title.value = task?.title || '';
    proj.value = task?.projectId || presetProjectId || '';
    type.value = task?.type || 'one-off';
    status.value = task?.status || 'todo';
    priority.value = task?.priority || 'medium';
    start.value = task?.startDate || '';
    due.value = task?.dueDate || '';
    due.value = task?.dueDate || '';

// Prefill estimated time
if (task?.estimatedMinutes) {
  const units = unitsFromMinutes(task.estimatedMinutes);
  if (estDays) estDays.value = units.days;
  if (estHours) estHours.value = units.hours;
  if (estMinutes) estMinutes.value = units.minutes;
} else {
  if (estDays) estDays.value = '';
  if (estHours) estHours.value = '';
  if (estMinutes) estMinutes.value = '';
}

    const showRec = type.value === 'recurring';
    recWrap.style.display = showRec ? '' : 'none';
    weeklyWrap.style.display = showRec ? '' : 'none';
    recSel.value = task?.recurrence?.pattern || 'daily';
    weeklyDaySel.value = String(task?.recurrence?.weeklyDay ?? '');
    
// Prefill monthly bundle editor (if the task already has one)
  if (task?.bundle?.type === 'monthly') {
    const lines = (task.bundle.items || []).map(it => it.label).join('\n');
    if (bundleItems) bundleItems.value = lines;
  } else if (bundleItems) {
    bundleItems.value = '';
  }
  // Show/hide the monthly bundle editor based on current settings
  const updateBundleVisibility = () => {
    const recurring = (type.value === 'recurring');
    const isMonthly = (recSel.value === 'monthly');
    if (bundleWrap) bundleWrap.style.display = (recurring && isMonthly) ? '' : 'none';
    // Weekly day only applies to weekly/biweekly
    weeklyWrap.style.display = recurring ? '' : 'none';
    if (recSel.value === 'weekly' || recSel.value === 'biweekly') {
      weeklyWrap.style.display = '';
    } else {
      weeklyWrap.style.display = 'none';
    }
  };
  updateBundleVisibility();

   
type.onchange = () => {
    const rec = type.value === 'recurring';
    recWrap.style.display = rec ? '' : 'none';
    updateBundleVisibility();
  };
  recSel.onchange = updateBundleVisibility;


// Ensure visible for native <dialog> on subsequent opens
    dlg.style.display = '';   
 // Wire calendar label icons inside this dialog
    wireDateLabelPickers(dlg);

    dlg.showModal();

    $('#btnTaskCancel')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dlg.close(); }, { once: true });

    const form = $('#formTask');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const action = e.submitter?.value || 'ok';
      if (action === 'cancel') { dlg.close(); return; }
      const payload = {
        id: task?.id,
        title: title.value.trim(),
        projectId: proj.value || null,
        type: type.value,
        status: status.value,
        priority: priority.value,
        startDate: start.value || null,
        dueDate: due.value || null,
        completedDate: task?.completedDate || null,
        estimatedMinutes: minutesFromUnits({
        days: estDays?.value,
        hours: estHours?.value,
        minutes: estMinutes?.value
  })

      };
      if (payload.type === 'recurring') {
        payload.recurrence = {
          pattern: recSel.value,
          weeklyDay: weeklyDaySel.value ? Number(weeklyDaySel.value) : null
        };
        if (!payload.dueDate) payload.dueDate = todayISO();
        
 // Build or update the monthly bundle if Monthly is selected
      if (recSel.value === 'monthly') {
        const lines = (bundleItems?.value || '')
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean);
        if (lines.length > 0) {
          // Preserve existing history if editing
          const prevHistory = (task?.bundle?.type === 'monthly') ? (task.bundle.history || {}) : {};
          const items = lines.map(label => ({ key: slugKey(label), label }));
          payload.bundle = { type: 'monthly', items, history: prevHistory };
        } else {
          // No lines entered → remove bundle if it existed
          if (task?.bundle) payload.bundle = undefined;
        }
      } else {
        // Not monthly: ensure no stray bundle is carried over
        if (task?.bundle) payload.bundle = undefined;
      }

      } else {
        payload.recurrence = null;
        if (task?.bundle) payload.bundle = undefined;
      }
      await createOrUpdateTask(payload);
      dlg.close();
    };
  }


// (Keep the dialog available for future workflows, but inline edit is primary now)
function openNoteDialog(noteOrOpts = {}) {
  const dlg = $('#dlgNote'); if (!dlg) return;
  const editing = noteOrOpts && noteOrOpts.id;
  const note = editing ? noteOrOpts : null;
  const opts = editing ? {} : (noteOrOpts || {});
  const sel = $('#noteProject'); const text = $('#noteText');
  refreshProjectOptions([sel]);
  sel.value = editing ? (note.projectId || '') : (opts.projectId || '');
  text.value = editing ? (note.text || '') : '';
  dlg.style.display = '';
  dlg.showModal();
  $('#btnNoteCancel')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dlg.close(); }, { once: true });
  const form = $('#formNote');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter?.value || 'ok';
    if (action === 'cancel') { dlg.close(); return; }
    const payload = {
      id: editing ? note.id : undefined,
      projectId: sel.value || null,
      text: text.value.trim(),
      createdAt: editing ? note.createdAt : undefined
    };
    await createOrUpdateNote(payload);
    dlg.close();
  };
}


  /** ---------------- Weekly review & copy/export ---------------------------- */
  function buildReviewEmailText(start, end, grouped) {
    const lines = [`Weekly Summary (${fmt(start)} → ${fmt(end)})`, ''];
    Object.keys(grouped).forEach(k => {
      const proj = cache.projects.find(p => p.id === k);
      lines.push(proj ? `${proj.name}:` : 'Inbox / General:');
      grouped[k].forEach(item => lines.push(`  • ${item}`));
      lines.push('');
    });
    lines.push('— Sent from PaperTrail');
    return lines.join('\n');
  }
  function buildReviewTeamsMarkdown(start, end, grouped) {
    const lines = [`**Weekly Summary** _(${fmt(start)} → ${fmt(end)})_`, ''];
    Object.keys(grouped).forEach(k => {
      const proj = cache.projects.find(p => p.id === k);
      lines.push(proj ? `**${proj.name}**` : '**Inbox / General**');
      grouped[k].forEach(item => lines.push(`- ${item}`));
      lines.push('');
    });
    lines.push('_Sent from PaperTrail_');
    return lines.join('\n');
  }

  async function aggregateReviewData(range, opts = {}) {
    const { includeNotes = true, projectFilter = 'all' } = opts;

    const oneOffs = cache.tasks.filter(t =>
      t.type === 'one-off' &&
      t.completedDate &&
      new Date(t.completedDate) >= range.start &&
      new Date(t.completedDate) <= range.end
    );

    const { stores } = tx(STORES.completions, 'readonly');
    const allLogs = await getAll(stores[STORES.completions]);
    const recurringLogs = allLogs.filter(c => {
      const d = new Date(c.completedAt);
      return d >= range.start && d <= range.end;
    });

    const noted = includeNotes ? cache.notes.filter(n => {
      const d = new Date(n.createdAt);
      return d >= range.start && d <= range.end;
    }) : [];

    const grouped = {};
    const push = (pid, line) => {
      const key = pid || '_inbox';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(line);
    };

    oneOffs.forEach(t => push(t.projectId, `☑️ ${t.title} (${t.priority})`));
    
const byId = taskById();
    recurringLogs.forEach(log => {
      const t = byId.get(log.taskId);
      if (t) push(
        t.projectId,
        `🔁 ${t.title} — ${fmt(log.completedAt, true)}${log.note ? ' — ' + escapeHTML(log.note) : ''}`
      );
    });


    noted.forEach(n => {
      const s = n.text.length > 160 ? n.text.slice(0,160) + '…' : n.text;
      push(n.projectId, `📝 ${s}`);
    });

    const filtered = (projectFilter === 'all') ? grouped : Object.fromEntries(
      Object.entries(grouped).filter(([k]) => k === projectFilter)
    );

    const stats = {
      oneOffCount: oneOffs.length,
      recurringCount: recurringLogs.length,
      notesCount: noted.length,
      topProjectId: (() => {
        let best = null, max = -1;
        for (const [k, lines] of Object.entries(grouped)) {
          if (lines.length > max && k !== '_inbox') { max = lines.length; best = k; }
        }
        return best;
      })()
    };
    return { grouped: filtered, stats };
  }

  async function buildWeeklyActivitySeries(weeks, { projectFilter = 'all' } = {}) {
    const { stores } = tx(STORES.completions, 'readonly');
    const allLogs = await getAll(stores[STORES.completions]);
    const byId = taskById();

    const series = new Array(weeks.length).fill(0);
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      const ones = cache.tasks.filter(t =>
        t.type === 'one-off' &&
        t.completedDate &&
        new Date(t.completedDate) >= w.start &&
        new Date(t.completedDate) <= w.end &&
        (projectFilter === 'all' ? true : t.projectId === projectFilter)
      ).length;
      const recCount = allLogs.filter(c => {
        const d = new Date(c.completedAt);
        if (d < w.start || d > w.end) return false;
        const t = byId.get(c.taskId);
        if (!t) return false;
        return (projectFilter === 'all') ? true : t.projectId === projectFilter;
      }).length;
      series[i] = ones + recCount;
    }
    return series;
  }

  function buildSparklineSVG(points, { width = 320, height = 54, pad = 6, color = 'var(--primary)' } = {}) {
    if (!points || points.length === 0) {
      return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
    }
    const n = points.length;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = Math.max(1, max - min);
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    const xAt = (i) => pad + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
    const yAt = (v) => pad + innerH - ((v - min) / span) * innerH;
    const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`).join(' ');
    const lastX = xAt(n - 1).toFixed(2);
    const lastY = yAt(points[n - 1]).toFixed(2);
    const midY = yAt(min + span / 2).toFixed(2);
    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="12-week trend">
        <path d="M ${pad} ${midY} L ${width - pad} ${midY}" stroke="var(--border)" stroke-dasharray="3 4" fill="none"/>
        <path d="${path}" stroke="${color}" stroke-width="2" fill="none" />
        <circle cx="${lastX}" cy="${lastY}" r="3.5" fill="${color}" stroke="white" stroke-width="1"/>
      </svg>
    `;
  }
   
// ---------- Wellness metrics (sleep / mood) ----------
// Simple upsert + read helpers (reuses existing tx/put/getAll helpers)
async function upsertMetric({ id = uuid(), date, type, value, note = null }) {
  const { stores } = tx(STORES.metrics, 'readwrite');
  await put(stores[STORES.metrics], { id, date, type, value, note });
}
async function getMetrics({ type, start, end }) {
  const { stores } = tx(STORES.metrics, 'readonly');
  const all = await getAll(stores[STORES.metrics]);
  return all.filter(m => m.type === type && m.date >= start && m.date <= end);
}

// Build a 7-row (Sun..Sat) daily series across the same weeks window used by activity heatmap
async function buildMetricCells({ weeks = 8, type = 'sleep' } = {}) {
  const anchor = cache.settings?.anchorWeekday ?? 2; // Tue default
  const clamp0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const startOfWeek = (wday) => {
    const now = clamp0(new Date());
    const d = new Date(now); const delta = ((d.getDay() - wday + 7) % 7);
    d.setDate(d.getDate() - delta); d.setHours(0,0,0,0); return d;
  };
  const end = clamp0(new Date());
  const start = new Date(startOfWeek(anchor)); start.setDate(start.getDate() - (weeks - 1) * 7);
  const ymd = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };
  // init buckets
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push({ ymd: ymd(d), value: 0, date: new Date(d) });
  }
  const byYmd = new Map(days.map(x => [x.ymd, x]));
  // fetch metrics
  const metrics = await getMetrics({ type, start: ymd(start), end: ymd(end) });

  for (const m of metrics) {
  const cell = byYmd.get(m.date);
  if (cell) {
    const v = Number(m.value) ?? 0;
    cell.value = v;
    cell.count = v; // tooltip uses 'count'; reuse same number
  }
 }

  // map values to 0..4 levels (same philosophy as activity heatmap)
  const max = Math.max(0, ...days.map(d => d.value));
  const step = max <= 1 ? 1 : Math.ceil(max / 4);
  days.forEach(d => { d.level = d.value === 0 ? 0 : Math.min(4, Math.ceil(d.value / step)); });
  return { start, end, weeks, days };
}

// ---- Dashboard Heatmap (last 8 weeks) -------------------------------------
function clampToLocalDate(d) {  // midnight local
  const dt = new Date(d); return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

// Build an array of day cells from start->end with counts per day
async function buildDailyActivityCells({ weeks = 8, includeNotes = false } = {}) {
  const anchor = cache.settings?.anchorWeekday ?? 2; // Tue default
  // Start at beginning of current anchor week, then back (weeks-1)
  const startOfWeek = (wday) => {
    const now = clampToLocalDate(new Date());
    const d = new Date(now); const delta = ((d.getDay() - wday + 7) % 7);
    d.setDate(d.getDate() - delta); d.setHours(0,0,0,0); return d;
  };
  const end = clampToLocalDate(new Date());
  const start = new Date(startOfWeek(anchor)); start.setDate(start.getDate() - (weeks - 1) * 7);

  // Prepare day buckets
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push({ ymd: ymdLocal(d), count: 0, date: new Date(d) });
  }
  const byYmd = new Map(days.map(x => [x.ymd, x]));

  // One-off task completions
  cache.tasks.forEach(t => {
    if (t.type !== 'one-off' || !t.completedDate) return;
    const d = clampToLocalDate(new Date(t.completedDate));
    if (d < start || d > end) return;
    const y = ymdLocal(d); const cell = byYmd.get(y); if (cell) cell.count += 1;
  });

  // Recurring logs
  const logs = await loadAllCompletions();
  logs.forEach(c => {
    const d = clampToLocalDate(new Date(c.completedAt));
    if (d < start || d > end) return;
    const y = ymdLocal(d); const cell = byYmd.get(y); if (cell) cell.count += 1;
  });

  // (Optional) include Notes created per day
  if (includeNotes) {
    cache.notes.forEach(n => {
      const d = clampToLocalDate(new Date(n.createdAt));
      if (d < start || d > end) return;
      const y = ymdLocal(d); const cell = byYmd.get(y); if (cell) cell.count += 1;
    });
  }

  // Map to 5 levels (0..4) using simple thresholds (robust + fast)
  const max = Math.max(0, ...days.map(d => d.count));
  const step = max <= 1 ? 1 : Math.ceil(max / 4);   // avoid division by 0 and overbucketing
  days.forEach(d => { d.level = d.count === 0 ? 0 : Math.min(4, Math.ceil(d.count / step)); });
  return { start, end, weeks, days }; // linear array from start..end (rows=weekday)
}

function renderHeatmap(container, cells) {
  if (!container) return;
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'heatmap-wrap';
  const grid = document.createElement('div');
  grid.className = 'heatmap';

  // We want 7 rows (Sun..Sat). Build column by column (weeks).
  // cells.days is linear start..end; add filler days at the end-of-grid (future days) to complete the last week column.
  const days = cells.days.slice(); // copy
  const lastDate = days.length ? days[days.length - 1].date : null;
  const today = clampToLocalDate(new Date());
// Pad so that (lastDate + pad + 1) lands on the anchor weekday -> neat weekly columns
  const anchor = cache.settings?.anchorWeekday ?? 2; // Tue default
  const trailing = lastDate ? ( (anchor - ((lastDate.getDay() + 1) % 7) + 7) % 7 ) : 0; // (GitHub-like; still works with any anchor)
  for (let i = 0; i < trailing; i++) days.push({ ymd: '', count: 0, level: 0, future: true });

  days.forEach(d => {
    const cell = document.createElement('div');
    cell.className = 'cell ' + (d.future ? '' : ('hm-l' + d.level));
    if (!d.future) {
      const label = `${d.ymd} — ${d.count} item${d.count===1?'':'s'}`;
      cell.setAttribute('title', label);
    } else {
      cell.style.opacity = '.3';
    }
    grid.appendChild(cell);
  });

  // Legend
  const legend = document.createElement('div'); legend.className = 'hm-legend';
  legend.innerHTML = `
    <span>Less</span>
    <span class="swatch"></span>
    <span class="swatch l1"></span>
    <span class="swatch l2"></span>
    <span class="swatch l3"></span>
    <span class="swatch l4"></span>
    <span>More</span>
  `;
  wrap.appendChild(grid);
  wrap.appendChild(legend);
  container.appendChild(wrap);
}

// --- Dashboard micro summary (this week so far) ---
async function updateDashboardSummary(containerEl, stats = null) {
  if (!containerEl) return;
  // 1) Determine "this week" window using your anchor weekday
  const range = getWeekWindow(cache.settings?.anchorWeekday ?? 2, 0);
  const { start, end } = range;

  // 2) One-off tasks completed in range
  const oneOffCount = cache.tasks.filter(t =>
    t.type === 'one-off' &&
    t.completedDate &&
    new Date(t.completedDate) >= start &&
    new Date(t.completedDate) <= end
  ).length;

  // 3) Recurring logs in range (completions store)
  const { stores } = tx(STORES.completions, 'readonly');
  const allLogs = await getAll(stores[STORES.completions]);
  const recurringCount = allLogs.filter(c => {
    const d = new Date(c.completedAt);
    return d >= start && d <= end;
  }).length;

  // 4) Notes added in range
  const notesCount = cache.notes.filter(n => {
    const d = new Date(n.createdAt);
    return d >= start && d <= end;
  }).length;

  // 5) Paint calm, chip-based sentence
  containerEl.innerHTML = `
    <span class="chip label-chip">This Week</span>
    <span class="chip"><i class="ri-checkbox-line"></i> ${oneOffCount} Tasks</span>
    <span class="chip"><i class="ri-loop-right-fill"></i> ${recurringCount} Recurring</span>
    <span class="chip"><i class="ri-sticky-note-add-line"></i> ${notesCount} Notes</span>
  `;
}

  async function exportWeekCSV(range, { includeNotes = true, projectFilter = 'all' } = {}) {
    const rows = [];
    const pName = (pid) => {
      const p = cache.projects.find(px => px.id === pid);
      return p ? p.name : 'Inbox';
    };

    // One-offs
    cache.tasks.forEach(t => {
      if (t.type !== 'one-off' || !t.completedDate) return;
      const d = new Date(t.completedDate);
      if (d < range.start || d > range.end) return;
      if (projectFilter !== 'all' && t.projectId !== projectFilter) return;
      rows.push({ date: d.toISOString(), kind: 'one-off', project: pName(t.projectId), title: t.title, extra: t.priority || '' });
    });

    // Recurring
    const { stores } = tx(STORES.completions, 'readonly');
    const logs = await getAll(stores[STORES.completions]);
    logs.forEach(c => {
      const d = new Date(c.completedAt);
      if (d < range.start || d > range.end) return;
      const t = cache._taskById?.get(c.taskId);
      if (!t) return;
      if (projectFilter !== 'all' && t.projectId !== projectFilter) return;
      rows.push({ 
        date: d.toISOString(), 
        kind: 'recurring', 
        project: pName(t.projectId), 
        title: t.title, 
        extra: c.note || '' });
    });

    // Notes
    if (includeNotes) {
      cache.notes.forEach(n => {
        const d = new Date(n.createdAt);
        if (d < range.start || d > range.end) return;
        if (projectFilter !== 'all' && n.projectId !== projectFilter) return;
        rows.push({ date: d.toISOString(), kind: 'note', project: pName(n.projectId), title: n.text.replace(/\s+/g, ' ').trim(), extra: '' });
      });
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));

    const esc = (s) => {
      s = (s ?? '').toString();
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = ['date', 'kind', 'project', 'title', 'extra'];
    const csv = [header.join(',')].concat(rows.map(r => header.map(k => esc(r[k])).join(','))).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeLabel = (range.label || `${fmt(range.start)} → ${fmt(range.end)}`).replace(/[^\w]+/g, '_');
    a.href = url; a.download = `papertrail-week-${safeLabel}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  function safeOpenReviewDialog() {
  const dlg = document.getElementById('dlgReview');
  if (!dlg) return;
  // make sure it's visible for native <dialog>
  dlg.style.display = '';
  // remove any stray polyfill backdrops for this dialog
  if (typeof removeZombieBackdrops === 'function') {
    removeZombieBackdrops(dlg.id || null);
  }
  try { dlg.showModal(); } catch (_) {
    // fallback for polyfill
    dlg.setAttribute('open', '');
    dlg.style.display = 'block';
  }
}

async function renderReviewPage(root) {
  const weeks = getLastNWeekWindows(12, cache.settings?.anchorWeekday ?? 2);
  const current = weeks[reviewState.weekIndex] || weeks[0];
  const projectOptions = [{ value: 'all', label: 'All projects' }]
    .concat((cache.projects || []).map(p => ({ value: p.id, label: p.name })));

root.insertAdjacentHTML('beforeend', `
    <div class="panel">
      <div class="row" style="justify-content:flex-start; align-items:center; gap:12px; flex-wrap:wrap;">
        <h2>Weekly Review</h2>
        <div class="week-controls">
          <button id="btnWeekPrev" class="btn ghost" title="Previous week">◀</button>
          <select id="selWeek" class="week-select" title="Select week">
            ${weeks.map((w,i)=> `<option value="${i}" ${i===reviewState.weekIndex?'selected':''}>${w.label}</option>`).join('')}
          </select>
          <button id="btnWeekNext" class="btn ghost" title="Next (newer) week">▶</button>
        </div>
      </div>
      
  <div class="row" style="margin-top:8px; align-items:center; gap:12px; flex-wrap:wrap;">
  <!-- Left group: filters + outputs -->
    <div class="row" style="gap:8px; flex-wrap:wrap;">
          <div class="row">
            <label class="kbd" for="selReviewProject">Project:</label>
            <select id="selReviewProject">
              ${projectOptions.map(o => `<option value="${o.value}" ${o.value===reviewState.projectFilter?'selected':''}>${o.label}</option>`).join('')}
            </select>
          </div>
          <div class="row">
            <label class="kbd" for="chkIncludeNotes">Include notes</label>
            <input type="checkbox" id="chkIncludeNotes" ${reviewState.includeNotes?'checked':''}/>
          </div>
          <div class="row">
            <button id="btnCopyWeekEmail" class="btn">Copy</button>
            <button id="btnExportWeekCSV" class="btn secondary">Export</button>
            </div>
<!-- Spacer pushes the dialog action right -->
  <div class="flex-spacer"></div>

            <button id="btnOpenCurrentDialog" class="btn secondary" title="Open current-week dialog">Open Dialog</button>
            </div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="panel" id="reviewStats"></div>
        <div class="panel">
          <h2>Activity</h2>
          <div id="reviewList" class="list"></div>
        </div>
      </div>
    `);


let grouped = {}, stats = { oneOffCount:0, recurringCount:0, notesCount:0, topProjectId:null };
  try {
    const res = await aggregateReviewData(current, {
      includeNotes: reviewState.includeNotes,
      projectFilter: reviewState.projectFilter
    });
    grouped = res.grouped || {};
    stats = res.stats || stats;
  } catch (err) {
    console.error('[Weekly Review] aggregate failed:', err);
    root.insertAdjacentHTML('beforeend', `
      <div class="panel">
        <h2>Weekly Review</h2>
        <div class="empty">Could not load weekly data.<br/><span class="kbd">${escapeHTML(String(err?.message || err))}</span></div>
      </div>
    `);
    return; // bail early but don’t crash the app
  }

    const topProj = stats.topProjectId ? cache.projects.find(p => p.id === stats.topProjectId) : null;
    
  let spark = '';
  try {
    const weeksAll = getLastNWeekWindows(12, cache.settings?.anchorWeekday ?? 2);
    const series = await buildWeeklyActivitySeries(weeksAll, { projectFilter: reviewState.projectFilter });
    spark = buildSparklineSVG((series || []).slice().reverse()); // newest on right
  } catch (err) {
    console.warn('[Weekly Review] sparkline failed:', err);
    spark = `<div class="kbd">Trend unavailable</div>`;
  }


    $('#reviewStats').innerHTML = `
      <h2>Stats</h2>
      <div class="list">
        <div class="item"><div class="title">☑️ One-off tasks completed</div><div class="chip">${stats.oneOffCount}</div></div>
        <div class="item"><div class="title">🔁 Recurring logs</div><div class="chip">${stats.recurringCount}</div></div>
        <div class="item"><div class="title">📝 Notes${reviewState.includeNotes?'':' (excluded)'}</div><div class="chip">${stats.notesCount}</div></div>
        <div class="item"><div class="title">🌟 Top Project</div><div>${topProj ? `<span class="chip"><span class="project-chip" style="background:${topProj.color||'#7c9cc0'}"></span> ${escapeHTML(topProj.name)}</span>` : '—'}</div></div>
        <div class="item" style="grid-column: 1 / -1; display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div class="title">📈 Trends (last 12 weeks)</div>
          <div class="sparkline">${spark}</div>
        </div>
      </div>
    `;

    const list = $('#reviewList');
    list.innerHTML = '';
    const keys = Object.keys(grouped);
    if (keys.length === 0) {
      list.innerHTML = `<div class="empty">No activity in this window.</div>`;
    } else {
      keys.forEach(k => {
        const proj = (cache.projects || []).find(p => p.id === k);
        const card = document.createElement('div'); card.className = 'panel';
        card.innerHTML = `<h2>${proj ? `<span class="project-chip" style="background:${proj.color || '#7c9cc0'}"></span> ${escapeHTML(proj.name)}` : 'Inbox / General'}</h2><ul class="list"></ul>`;
        const ul = card.querySelector('ul');
        (grouped[k] || []).forEach(line => {
          const li = document.createElement('li'); li.className='item';
          li.innerHTML = `<div style="grid-column: span 3;">${escapeHTML(line)}</div>`;
          ul.appendChild(li);
        });
        list.appendChild(card);
      });
    }

    // Wire controls
    const weeksCount = weeks.length;
    $('#btnWeekPrev')?.addEventListener('click', () => { if (reviewState.weekIndex+1 < weeksCount) { reviewState.weekIndex++; render(); }});
    $('#btnWeekNext')?.addEventListener('click', () => { if (reviewState.weekIndex > 0) { reviewState.weekIndex--; render(); }});
    $('#selWeek')?.addEventListener('change', (e) => { reviewState.weekIndex = Number(e.target.value)||0; render(); });
    $('#selReviewProject')?.addEventListener('change', (e) => { reviewState.projectFilter = e.target.value || 'all'; render(); });
    $('#chkIncludeNotes')?.addEventListener('change', (e) => { reviewState.includeNotes = !!e.target.checked; render(); });

    // Copy / Export / Dialog
    $('#btnCopyWeekEmail')?.addEventListener('click', async () => {
      const data = await aggregateReviewData(current, { includeNotes: reviewState.includeNotes, projectFilter: reviewState.projectFilter });
      await navigator.clipboard.writeText(buildReviewEmailText(current.start, current.end, data.grouped));
      toastCopy('#btnCopyWeekEmail');
    });
    // $('#btnCopyWeekTeams')?.addEventListener('click', async () => {
     // const data = await aggregateReviewData(current, { includeNotes: reviewState.includeNotes, projectFilter: reviewState.projectFilter });
    //  await navigator.clipboard.writeText(buildReviewTeamsMarkdown(current.start, current.end, data.grouped));
    //  toastCopy('#btnCopyWeekTeams');
    //});
   // $('#btnExportWeek')?.addEventListener('click', async () => {
     // const data = await aggregateReviewData(current, { includeNotes: reviewState.includeNotes, projectFilter: reviewState.projectFilter });
    //  const payload = {
      //  range: { start: current.start.toISOString(), end: current.end.toISOString(), label: current.label },
        //grouped: data.grouped,
       // stats
    //  };
     // const blob = new Blob([JSON.stringify(payload,null,2)], { type: 'application/json' });
    //  const url = URL.createObjectURL(blob);
    //  const a = document.createElement('a'); a.href = url; a.download = `focusflow-week-${current.label.replace(/[^\w]+/g,'_')}.json`;
    //  document.body.appendChild(a); a.click(); a.remove();
    //  URL.revokeObjectURL(url);
   // });
    $('#btnExportWeekCSV')?.addEventListener('click', async () => {
      await exportWeekCSV(current, { includeNotes: reviewState.includeNotes, projectFilter: reviewState.projectFilter });
    });


// Open dialog for the *selected* week (current or previous)
const btnOpen = document.getElementById('btnOpenCurrentDialog');
if (btnOpen) {
  btnOpen.disabled = false; // allow any week
  btnOpen.addEventListener('click', (e) => {
    e.preventDefault();
    // 'current' is already the selected week window from the dropdown
    openReviewDialog(current);
  });
}


  }

  function toastCopy(sel) {
    const btn = $(sel); if (!btn) return; const prev = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = prev, 1500);
  }

  /** ---------------- Quick Add helpers (placeholder & reset) --------------- */
  function setQuickAddPlaceholder() {
    const input = document.getElementById('quickTask');
    const sel = document.getElementById('quickProject');
    if (!input || !sel) return;
    input.placeholder = (sel.value === '_new') ? 'New project name' : 'Quick add task (N)';
  }
  function resetQuickAddSelection() {
    const sel = document.getElementById('quickProject');
    if (!sel) return;
    sel.value = ''; // Inbox default
    setQuickAddPlaceholder();
    saveSettings({ quickAddProjectId: null }).catch(()=>{});
  }
  
  /** ---------------- Focus Mode toggle (hide/show sidebar) ------------------ */
  function applyFocusModeFromSettings() {
    document.body.classList.toggle('focus-mode', !!(cache.settings?.focusModeEnabled));
  }
  async function toggleTrueFocusMode(force = null) {
    const next = (force === null) ? !cache.settings.focusModeEnabled : !!force;
    await saveSettings({ focusModeEnabled: next });
    applyFocusModeFromSettings();
    const btn = document.getElementById('btnFocus');
    if (btn) btn.textContent = next ? 'Unfocus' : 'Focus';
  }

    // --- Scroll helpers: always start new views at the top ---
function scrollToTopNow() {
  // Reset the app's scrollable main pane
  const main = document.getElementById('main');
  if (main) {
    // Prefer element API if supported
 if (typeof main.scrollTo === 'function') main.scrollTo({ top: 0, left: 0, behavior: 'instant' /* or 'smooth' */ });
  }
  // Also reset the window/document just in case the outer page scrolled
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' /* or 'smooth' */ });
  const root = document.scrollingElement || document.documentElement;
  if (root) root.scrollTop = 0;
}

  /** ---------------- Search / View / Export / Theme / Notifications -------- */
  function applySearch(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) { render(); return; }
    let items = cache.tasks.filter(t => {
      const proj = cache.projects.find(p => p.id === t.projectId);
      return (t.title || '').toLowerCase().includes(q) ||
             (t.priority || '').toLowerCase().includes(q) ||
             (proj?.name || '').toLowerCase().includes(q);
    });
    items = applyGlobalFilters(items);
    const main = $('#main'); if (!main) return;
    main.innerHTML = `
      <div class="panel">
        <h2><i class="ri-search-line icon"></i> Search Results <span class="sub">(${items.length})</span></h2>
        <div id="searchResults" class="list"></div>
        ${items.length === 0 ? `<div class="empty">No matches</div>` : ''}
      </div>
    `;
    renderTaskCollection($('#searchResults'), items);
  }
  
    function setView(view) {
      clearSelection();
      noteSelection.ids.clear();
      closeInlineLogEditor();
      currentView = view;
      scrollToTopNow();   // <— ensure new pages start at the top
      render();
      workWeekOffset = 0;
}

  async function exportBackup() {
    const payload = { exportedAt: new Date().toISOString(), projects: cache.projects, tasks: cache.tasks, notes: cache.notes, settings: cache.settings };
    const res = await api.exportData(payload);
    if (res.canceled && res.error) alert('Export failed: ' + res.error);
    if (!res.canceled && res.filePath) alert('Exported to: ' + res.filePath);
  }
  async function importBackup() {
    const res = await api.importData();
    if (res.canceled) { if (res.error) alert('Import failed: ' + res.error); return; }
    const data = res.data || {};
    if (!confirm('Importing will replace your current data. Continue?')) return;
    const { t, stores } = tx([STORES.projects, STORES.tasks, STORES.notes, STORES.settings], 'readwrite');
    stores[STORES.projects].clear(); stores[STORES.tasks].clear(); stores[STORES.notes].clear(); stores[STORES.settings].clear();
    for (const p of (data.projects || [])) await put(stores[STORES.projects], p);
    for (const tsk of (data.tasks || [])) await put(stores[STORES.tasks], tsk);
    for (const n of (data.notes || [])) await put(stores[STORES.notes], n);
    if (data.settings) await put(stores[STORES.settings], data.settings);
    await new Promise(r => t.oncomplete = r);
    await loadAll(); setView({ type: 'dashboard' });
  }
  function toggleTheme() {
    const newTheme = (cache.settings.theme === 'dark') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    saveSettings({ theme: newTheme });
  }
  const notificationKey = (overdueCount, todayCount) => `${todayISO()}::${overdueCount}::${todayCount}`;
  const startNowNotifyKey = (taskId) =>
  `${todayISO()}::start-now::${taskId}`;
  async function checkAndNotify() {
    if (!cache.settings.notificationsEnabled) return;
    const t = todayISO();
    const overdueCount = cache.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate < t).length;
    const todayCount = cache.tasks.filter(x => x.status !== 'done' && x.dueDate === t).length; 
  // --- Start-now notifications (estimated time based) ---
  for (const task of cache.tasks) {
    try {
      await maybeNotifyStartNow(task);
    } catch (err) {
      console.warn('[notify] start-now failed:', err);
    }
  }
    const key = notificationKey(overdueCount, todayCount);
    if (cache.settings._lastNotifyKey === key) return;
    if (overdueCount + todayCount === 0) return;
    const body = [ overdueCount ? `⚠️ Overdue: ${overdueCount}` : null, todayCount ? `📅 Due Today: ${todayCount}` : null ].filter(Boolean).join(' • ');
    await api.notify({ title: 'PaperTrail — Today', body });
    await saveSettings({ _lastNotifyKey: key });
  }
  let notifyIntervalId = null;
  function startNotificationLoop() {
    if (notifyIntervalId) clearInterval(notifyIntervalId);
    if (!cache.settings.notificationsEnabled) return;
    checkAndNotify().catch(()=>{});
    notifyIntervalId = setInterval(() => checkAndNotify().catch(()=>{}), 15 * 60 * 1000);
  }

  /** ---------------- Quick Add (Enter-to-submit) ---------------------------- */
  async function submitQuickAdd() {
    const input = document.getElementById('quickTask');
    const title = (input?.value || '').trim();
    if (!title) return;

    const quickSel = document.getElementById('quickProject');
    const selVal = quickSel?.value || '';

    if (selVal === '_new') {
      // Quick Add a PROJECT
      const created = await createOrUpdateProject({
        name: title,
        status: 'active',
        color: '#3aa6a0',
        dueDate: null
      });
      if (quickSel && created?.id) quickSel.value = created.id;
      if (created?.id) await saveSettings({ quickAddProjectId: created.id });
      setQuickAddPlaceholder(); // back to task mode
    } else {
      // Quick Add a TASK (Inbox or selected project)
      const projectId = selVal || null;
      await createOrUpdateTask({
        title,
        projectId,
        type: 'one-off',
        status: 'todo',
        priority: 'medium',
        startDate: null,
        dueDate: todayISO()
      });
      await saveSettings({ quickAddProjectId: projectId });
    }

    if (input) input.value = '';
  }

  /** ---------------- Keyboard Shortcuts (guarded) --------------------------- */
  function wireShortcuts() {
    window.addEventListener('keydown', (e) => {
      const key = (e.key || '').toLowerCase();

      const active = document.activeElement;
      const isEditable = active && (
        active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' || active.isContentEditable
      );
      const anyDialogOpen = Array.from(document.querySelectorAll('dialog'))
        .some(d => d.hasAttribute('open') && d.style.display !== 'none');

      if (isEditable || anyDialogOpen) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      
      if (key === 'escape') {
        // Close inline log editor if open
        if (__openLogEditor) { closeInlineLogEditor(); return; }

        // Clear bulk selection quickly
        if (selection.ids.size > 0) { clearSelection(); return; }
      } else if (key === 'n') {
        e.preventDefault(); openTaskDialog();
      } else if (e.key === '/') {
        e.preventDefault(); document.getElementById('searchInput')?.focus();
      } else if (key === 't') {
        e.preventDefault(); openReviewDialog();
      } else if (key === 'f') {
        e.preventDefault(); setView({ type: 'focus' });
      }
    });
  }

  /** ---------------- Sidebar collapse/expand helpers ------------------------ */
  function applySidebarCollapse() {
    const map = [
      { key: 'views',    section: '#sectionViews',    header: '#toggleViews' },
      { key: 'projects', section: '#sectionProjects', header: '#toggleProjects' },
      { key: 'settings', section: '#sectionSettings', header: '#toggleSettings' },
    ];
    map.forEach(({ key, section, header }) => {
      const collapsed = !!(cache.settings?.sidebarCollapsed?.[key]);
      const sec = document.querySelector(section);
      const hdr = document.querySelector(header);
      if (sec) sec.classList.toggle('collapsed', collapsed);
      if (hdr) hdr.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }
  function toggleSectionCollapse(key) {
    const current = !!(cache.settings?.sidebarCollapsed?.[key]);
    const next = !current;
    const sidebarCollapsed = { ...(cache.settings?.sidebarCollapsed || {}), [key]: next };
    const sec = document.querySelector(`#section${key[0].toUpperCase()+key.slice(1)}`);
    const hdr = document.querySelector(`#toggle${key[0].toUpperCase()+key.slice(1)}`);
    if (sec) sec.classList.toggle('collapsed', next);
    if (hdr) hdr.setAttribute('aria-expanded', next ? 'false' : 'true');
    saveSettings({ sidebarCollapsed }).catch(()=>{});
  }

  /** ---------------- Open Review Dialog (robust close path) ----------------- */
  
// Accepts: optional 'range' => { start: Date, end: Date, label?: string }

// Accepts: optional 'range' => { start: Date, end: Date, label?: string }
async function openReviewDialog(range = null) {
    const reviewSideEl = document.querySelector('#viewsList .nav-item[data-view="review"]');
    const setReviewActive = (on) => reviewSideEl?.classList.toggle('active', !!on);

 
// Use the provided range (selected week) or fall back to the current to‑date window
  let used = range;
  if (!used) {
    const cur = getReviewRange(cache.settings.anchorWeekday);
    used = { start: cur.start, end: cur.end, label: `This week (${fmt(cur.start)} → ${fmt(cur.end)})` };
  }
    const { start, end, label } = used;
    const doneOneOffs = cache.tasks.filter(t => t.type === 'one-off' && t.completedDate && new Date(t.completedDate) >= start && new Date(t.completedDate) <= end);
    const { stores } = tx(STORES.completions, 'readonly');
    const logs = await getAll(stores[STORES.completions]);
    const recurringLogs = logs.filter(c => { const d = new Date(c.completedAt); return d >= start && d <= end; });
    const notes = cache.notes.filter(n => { const d = new Date(n.createdAt); return d >= start && d <= end; });

    const grouped = {};
    const addLine = (projectId, line) => { const key = projectId || '_inbox'; if (!grouped[key]) grouped[key] = []; grouped[key].push(line); };
    doneOneOffs.forEach(t => addLine(t.projectId, `☑️ ${t.title} (${t.priority})`));
    
    recurringLogs.forEach(log => {
    const t = cache._taskById?.get(log.taskId);
    if (t) addLine(t.projectId, `🔁 ${t.title} — ${fmt(log.completedAt, true)}${log.note ? 
      ' — ' + escapeHTML(log.note) : ''}`);
  });

    notes.forEach(n => { const s = n.text.length > 160 ? n.text.slice(0,160) + '…' : n.text; addLine(n.projectId, `<i class="ri-sticky-note-add-line"></i> ${s}`); });

    const container = $('#reviewContent'); const rangeEl = $('#reviewRange');
    
  if (rangeEl) {
    // If a label came with the range, use it; otherwise fall back to the original phrasing
    rangeEl.textContent = label || `Since previous ${weekdayName(cache.settings.anchorWeekday)} (${fmt(start)}) → Now (${fmt(end)})`;
  }
    if (container) {
      container.innerHTML = '';
      const keys = Object.keys(grouped);
      if (keys.length === 0) container.innerHTML = `<div class="empty">No activity in this window.</div>`;
      else {
        keys.forEach(k => {
          const proj = cache.projects.find(p => p.id === k);
          const card = document.createElement('div'); card.className = 'panel';
          card.innerHTML = `<h2>${proj ? `<span class="project-chip" style="background:${proj.color || '#7c9cc0'}"></span> ${escapeHTML(proj.name)}` : 'Inbox / General'}</h2><ul class="list"></ul>`;
          const ul = card.querySelector('ul');
          (grouped[k] || []).forEach(line => { const li = document.createElement('li'); li.className='item'; li.innerHTML = `<div style="grid-column: span 3;">${escapeHTML(line)}</div>`; ul.appendChild(li); });
          container.appendChild(card);
        });
      }
    }


const dlg = $('#dlgReview'); if (!dlg) return;
 // Ensure visible for native <dialog> on subsequent opens
    dlg.style.display = '';
    dlg.showModal();

    setReviewActive(true);

    const closeReview = () => {
      try { dlg.close(); } catch (_) {}
      dlg.removeAttribute('open');
      // Remove polyfill backdrop completely (and any leftovers)
      if (dlg._backdrop) {
        if (dlg._backdrop.parentNode) dlg._backdrop.parentNode.removeChild(dlg._backdrop);
        dlg._backdrop = null;
      }
      removeZombieBackdrops(dlg.id || null);
      setReviewActive(false);
    };

    ['btnCloseReview', 'btnCloseReviewX'].forEach(id => {
      const el = document.getElementById(id);
      el?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); closeReview();
      }, { once: true });
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeReview(); }, { once: true });
    dlg.addEventListener('close', () => setReviewActive(false), { once: true });
  }

  // --- Safe task lookup (fallback if cache._taskById isn't set) ---
function taskById() {
  if (cache && cache._taskById instanceof Map) return cache._taskById;
  const m = new Map();
  if (Array.isArray(cache?.tasks)) for (const t of cache.tasks) m.set(t.id, t);
  return m;
}

// --- Inline LOG editor (one open at a time per page) ---
let __openLogEditor = null; // { rowEl, cleanup }

function closeInlineLogEditor() {
  if (!__openLogEditor) return;
  try { __openLogEditor.cleanup?.(); } catch {}
  __openLogEditor = null;
}

function openInlineLogEditor(rowEl, task, onSaved) {
  closeInlineLogEditor();
  // Build editor strip
  const content = rowEl.querySelector('.content');
  if (!content) return;

  // Container
  const editor = document.createElement('div');
  editor.className = 'row';
  editor.style.marginTop = '6px';
  // Input
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add log comment (optional)…';
  input.style.flex = '1';
  input.style.minWidth = '160px';
  // Buttons
  const btnSave = document.createElement('button');
  btnSave.className = 'btn';
  btnSave.textContent = 'Save';
  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn secondary';
  btnCancel.textContent = 'Cancel';

  editor.appendChild(input);
  editor.appendChild(btnSave);
  editor.appendChild(btnCancel);
  content.appendChild(editor);
  input.focus();

  const keyHandler = (e) => {
    // Enter saves, Esc cancels
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  };

  function doSave() {
    const note = input.value.trim();
    closeInlineLogEditor();
    onSaved?.(note);
  }
  function doCancel() {
    closeInlineLogEditor();
  }

  btnSave.addEventListener('click', doSave);
  btnCancel.addEventListener('click', doCancel);
  input.addEventListener('keydown', keyHandler);

  __openLogEditor = {
    rowEl,
    cleanup: () => {
      input.removeEventListener('keydown', keyHandler);
      editor.remove();
    }
  };
}

  /** ---------------- Init --------------------------------------------------- */
  async function init() {
    try {
      patchDialogs();

      db = await openDB();
      if (!cache.settings || !cache.settings.id) {
        await saveSettings({
          id: 'main',
          anchorWeekday: 2,
          workdaysOnly: true,
          theme: 'light',
          filters: { status: 'all', priority: 'all', sort: 'due-asc' },
          notificationsEnabled: false,
          _lastNotifyKey: null,
          quickAddProjectId: null,
          focusModeEnabled: false,
          sidebarCollapsed: { views: true, projects: false, settings: true },
          compactDashboard: true,
          // uncomment singleTodoBeta to allow the option back in settings
          // singleTodoBeta: true
// renderer.js – defaults/seed (optional)
          // singleTodoBeta: false

        });
      }
      await loadAll();
 
  // Back-compat: if the settings collapse state was never set, default to collapsed
      if (!cache.settings.sidebarCollapsed || typeof cache.settings.sidebarCollapsed.settings === 'undefined' || typeof cache.settings.sidebarCollapsed.views === 'undefined') {
        const next = {
          views: true,  // default Views to collapsed,
          projects: !!(cache.settings.sidebarCollapsed?.projects),
          settings: true
        };
        await saveSettings({ sidebarCollapsed: next });
      }
// Back-compat: default new compactDashboard setting to true if missing
  if (typeof cache.settings.compactDashboard === 'undefined') {
    await saveSettings({ compactDashboard: true });
  }
      removeZombieBackdrops(null); // clear any leftovers after hot reloads
      setQuickAddPlaceholder();
      applySidebarCollapse();

      const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
// --- Filters popover wiring ---
const filtersBtn = document.getElementById('btnFilters');
const filtersPop = document.getElementById('filtersPopover');

if (filtersBtn && filtersPop) {
  // Toggle open/close
  filtersBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const isOpen = filtersPop.style.display === 'block';
    if (isOpen) closeFiltersPopover(); else openFiltersPopover();
  });

  // Close on Done
  document.getElementById('btnCloseFilters')?.addEventListener('click', (e) => {
    e.preventDefault(); closeFiltersPopover();
  });

  // Clear filters (resets to Status:All, Priority:All, Sort:Due soonest)
  document.getElementById('btnClearFilters')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const next = { status: 'all', priority: 'all', sort: 'due-asc' };
    await saveSettings({ filters: next });
    // Reflect in UI
    const fs = document.getElementById('filterStatus'); if (fs) fs.value = next.status;
    const fp = document.getElementById('filterPriority'); if (fp) fp.value = next.priority;
    const so = document.getElementById('sortBy'); if (so) so.value = next.sort;
    updateFiltersButtonLabel();
    rerenderCurrentView();
  });

  // Outside click to close
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#filtersPopover') || t.closest('#btnFilters')) return;
    if (filtersPop.style.display === 'block') closeFiltersPopover();
  }, { passive: true });

  // Esc to close when open
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filtersPop.style.display === 'block') {
      e.preventDefault();
      closeFiltersPopover();
    }
  });

  // Initial label
  updateFiltersButtonLabel();
}    

// Sidebar toggles (delegated): click + keyboard on any .section-header
  const sidebarEl = document.querySelector('.sidebar');
  if (sidebarEl) {
    sidebarEl.addEventListener('click', (e) => {
      const header = e.target?.closest?.('.section-header');
      if (!header || !sidebarEl.contains(header)) return;
      const key = header.dataset.key;
      if (!key) return;
      e.preventDefault();
      toggleSectionCollapse(key);
    });
    sidebarEl.addEventListener('keydown', (e) => {
      const header = e.target?.closest?.('.section-header');
      if (!header || !sidebarEl.contains(header)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'enter' || k === ' ') {
        const key = header.dataset.key;
        if (!key) return;
        e.preventDefault();
        toggleSectionCollapse(key);
      }
    });
  }


      // Brand → Dashboard (click + keyboard)
      const brand = document.getElementById('brandHome');
      if (brand) {
        brand.addEventListener('click', (e) => { e.preventDefault(); setView({ type: 'dashboard' }); });
        brand.addEventListener('keydown', (e) => {
          const key = (e.key || '').toLowerCase();
          if (key === 'enter' || key === ' ') { e.preventDefault(); setView({ type: 'dashboard' }); }
        });
      }

      // Focus toggle (persisted)
      applyFocusModeFromSettings();
      const focusBtn = document.getElementById('btnFocus');
      if (focusBtn) focusBtn.textContent = cache.settings.focusModeEnabled ? 'Unfocus' : 'Focus';
      on('btnFocus', 'click', () => toggleTrueFocusMode());
      window.addEventListener('keydown', (e) => {
        const key = (e.key || '').toLowerCase();
        const active = document.activeElement;
        const isEditable = active && (
          active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' || active.isContentEditable
        );
        const anyDialogOpen = Array.from(document.querySelectorAll('dialog'))
          .some(d => d.hasAttribute('open') && d.style.display !== 'none');
        if (isEditable || anyDialogOpen) return;
        if (key === 'f' && e.shiftKey) { e.preventDefault(); toggleTrueFocusMode(); }
      });

      // Top actions
      on('btnTopNewTask', 'click', () => openTaskDialog());
      on('btnNewProject', 'click', () => openProjectDialog());
      on('btnSidebarNewProject', 'click', () => openProjectDialog());
      on('btnTheme', 'click', () => toggleTheme());
      on('btnExport', 'click', () => exportBackup());
      on('btnImport', 'click', () => importBackup());

      // Quick Add
      on('btnQuickAdd', 'click', submitQuickAdd);
      const quickInput = document.getElementById('quickTask');
      if (quickInput) {
        quickInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
            e.preventDefault(); submitQuickAdd();
          }
        });
      }
      // Reset Quick Add only when clicking outside the Quick Add controls
      const appEl = document.querySelector('.app');
      appEl?.addEventListener('pointerdown', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#quickTask') || target.closest('#quickProject') || target.closest('#btnQuickAdd')) return;
        resetQuickAddSelection();
      }, { passive: true });

      // Persist Quick Add project selection & keep placeholder updated
      on('quickProject', 'change', (e) => {
        const id = e.target.value || null;
        saveSettings({ quickAddProjectId: id });
        setQuickAddPlaceholder();
      });

      // Views (event delegation)
      const viewsListEl = document.getElementById('viewsList');
      if (viewsListEl) {
        viewsListEl.addEventListener('click', (e) => {
          const li = e.target?.closest?.('.nav-item');
          if (!li || !li.dataset) return;
          const view = li.dataset.view;
          if (!view) return;
          setView({ type: view, id: li.dataset.id || null });
        });
      }

      // Projects (event delegation)
      const projectsListEl = document.getElementById('projectsList');
      if (projectsListEl) {
        projectsListEl.addEventListener('click', (e) => {
          const li = e.target?.closest?.('.nav-item');
          if (!li || !li.dataset?.id) return;
          setView({ type: 'project', id: li.dataset.id });
        });
      }

      // Settings
      on('anchorWeekday', 'change', (e) => saveSettings({ anchorWeekday: Number(e.target.value) }));
      on('workdaysOnly', 'change', (e) => saveSettings({ workdaysOnly: e.target.checked }));
      on('enableNotifications', 'change', async (e) => { await saveSettings({ notificationsEnabled: e.target.checked, _lastNotifyKey: null }); startNotificationLoop(); });
      on('compactDashboard', 'change', async (e) => { await saveSettings({ compactDashboard: !!e.target.checked }); render(); });
      // Filters
      on('filterStatus', 'change', (e) => { const filters = { ...cache.settings.filters, status: e.target.value }; 
      saveSettings({ filters }).then(() => {
        updateFiltersButtonLabel();
        if (currentView.type === 'today') {
          setView({ type: 'today' }); // force remount
        } else { 
          rerenderCurrentView();
        }
      }); 
    });
      on('filterPriority', 'change', (e) => { const filters = { ...cache.settings.filters, priority: e.target.value }; 
            saveSettings({ filters }).then(() => {
        updateFiltersButtonLabel();
        if (currentView.type === 'today') {
          setView({ type: 'today' }); // force remount
        } else { 
          rerenderCurrentView();
        }
      }); 
      });
      on('sortBy', 'change', (e) => { const filters = { ...cache.settings.filters, sort: e.target.value }; 
      saveSettings({ filters }).then(() => {
        updateFiltersButtonLabel();
        if (currentView.type === 'today') {
          setView({ type: 'today' }); // force remount
        } else { 
          rerenderCurrentView();
        }
      }); 
      }); 
// renderer.js – init() Settings wiring
      // on('singleTodoBeta', 'change', async (e) => { await saveSettings({ singleTodoBeta: !!e.target.checked }); render(); });
// vapor theme button      
      on('themeSelect', 'change', async (e) => { const newTheme = e.target.value || 'light'; await saveSettings({ theme: newTheme }); document.documentElement.setAttribute('data-theme', newTheme);
});
// You already have these helpers; call this after any filters change too
updateFiltersButtonLabel();

      // Notes quick add (delegated)
      document.body.addEventListener('click', (e) => { if (e?.target?.id === 'btnAddNote') openNoteDialog(); });

      // Search
      on('searchInput', 'input', (e) => applySearch(e.target.value));

      // Shortcuts
      wireShortcuts();

      // Version tag
      try {
        const info = await api.getAppInfo();
        const v = $('#version'); if (v) v.textContent = `v${info.version || 'dev'}`;
      } catch {
        const v = $('#version'); if (v) v.textContent = 'v?';
      }

      startNotificationLoop();
      setView({ type: 'dashboard' });

    } catch (err) {
      console.error(err);
      alert('Failed to initialize: ' + (err?.message || String(err)));
    }
  }

  // Error surfacing
  window.addEventListener('error', (e) => { console.error('Global error:', e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { console.error('Unhandled promise rejection:', e.reason); });

  // One-time init guard
  if (!window.__FF_INIT__) {
    window.__FF_INIT__ = true;
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();