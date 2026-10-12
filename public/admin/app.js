'use strict';
/*
 * ICPC case desk. Vanilla JS on purpose: no build step, no third-party code on a page
 * that handles sensitive reports. Every piece of report data goes through textContent
 * (via h()), never innerHTML, so a malicious report can't inject script into an
 * official's browser. The server's CSP blocks inline script/style as a second layer.
 *
 * The only vendored code is Lucide (icons), served from /admin/vendor on your own origin.
 * Icons are built with DOM calls (no innerHTML) and styles are set through the CSSOM,
 * so both are CSP-safe.
 */

const STATUSES = [
  { key: 'RECEIVED', label: 'Received' },
  { key: 'UNDER_REVIEW', label: 'Under review' },
  { key: 'INVESTIGATING', label: 'Investigating' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'DISMISSED', label: 'Dismissed' },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));

const root = document.getElementById('app');
const state = {
  me: null,
  view: 'reports',
  filters: { status: '', state: '', q: '' },
  items: [],
  nextCursor: null,
  stats: null,
  selectedId: null,
  listLoading: false,
  listToken: 0,
};
let els = {};      // handles to the live parts of the reports view
let shell = null;  // handles to the app chrome (sidebar, title, main)
let drawer = null; // the open report drawer, if any

/* ───────────── helpers ───────────── */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Lucide icon as an inline <svg>, built with DOM calls. Silently renders nothing if the vendor script is missing.
function icon(name, size = 18) {
  const wrap = h('span', { class: 'ico', 'aria-hidden': 'true' });
  const node = window.lucide && window.lucide.icons && window.lucide.icons[name];
  if (!node) return wrap;
  try {
    const svg = window.lucide.createElement(node);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    wrap.append(svg);
  } catch { /* icons are decoration only */ }
  return wrap;
}

const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
function ago(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 604800) return Math.floor(s / 86400) + ' d ago';
  return new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const badge = (status) => h('span', { class: 'badge', 'data-status': status }, STATUS_LABEL[status] || status);
const safeHttps = (u) => typeof u === 'string' && u.startsWith('https://');
const sentence = (s) => { const t = String(s || '').toLowerCase().replaceAll('_', ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

// Skeleton placeholder. Sizes go through the CSSOM (allowed by the CSP).
function skel(w, hgt, cls = '') {
  const e = h('span', { class: 'skel ' + cls });
  if (w) e.style.width = w;
  if (hgt) e.style.height = hgt;
  return e;
}

// Busy state: disables the button and shows a spinner in place of its label.
function setBusy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
  btn.setAttribute('aria-busy', String(on));
}

function copyText(text, message) {
  const done = () => toast(message || 'Copied');
  const fail = () => toast('Could not copy. Select the text and copy it manually.', 'error');
  if (!navigator.clipboard) return fail();
  navigator.clipboard.writeText(text).then(done, fail);
}

// Reads are retried automatically on transient failures (network drop, 502/503/504).
// Writes are never auto-retried, so a status update can't be applied twice.
async function api(path, opts = {}) {
  const attempts = (opts.method || 'GET') === 'GET' ? 3 : 1;
  for (let i = 0; ; i++) {
    try {
      return await apiOnce(path, opts);
    } catch (err) {
      const transient = !err.handled && (err.network || [502, 503, 504].includes(err.status));
      if (!transient || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
}

async function apiOnce(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api/admin' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'icpc-dashboard' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection.'), { network: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    state.me = null;
    renderLogin('Your session has ended. Sign in again.');
    throw Object.assign(new Error('unauthorized'), { handled: true });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status, code: data.code });
  return data;
}

// `target` is the element that receives the id (use it when `input` is a wrapper around the real control).
function field(label, input, hint, target = input) {
  const id = 'f-' + Math.random().toString(36).slice(2, 8);
  target.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function emptyState(iconName, title, text, action, isError) {
  return h('div', { class: 'empty' + (isError ? ' err' : ''), role: isError ? 'alert' : null },
    icon(iconName, 22),
    h('strong', null, title),
    text ? h('p', null, text) : null,
    action || null
  );
}

function errorPanel(message, onRetry) {
  return emptyState('Info', 'Something went wrong', message,
    onRetry ? h('button', { class: 'btn', type: 'button', onClick: onRetry }, icon('RefreshCw', 16), 'Try again') : null, true);
}

/* ───────────── toasts, confirm dialog, theme ───────────── */

let toastBox = null;
function toast(message, kind = 'ok') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'Info' : 'Check', 18), h('span', null, message));
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, kind === 'error' ? 6000 : 3500);
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const finish = (value) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      if (previous && previous.focus) previous.focus();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    const cancel = h('button', { class: 'btn', type: 'button', onClick: () => finish(false) }, 'Cancel');
    const ok = h('button', { class: 'btn ' + (danger ? 'danger-solid' : 'primary'), type: 'button', onClick: () => finish(true) }, confirmLabel);
    const scrim = h('div', { class: 'modal-scrim', onClick: (e) => { if (e.target === scrim) finish(false); } },
      h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', 'aria-describedby': 'modal-text' },
        h('h2', { id: 'modal-title' }, title),
        h('p', { id: 'modal-text', class: 'muted' }, message),
        h('div', { class: 'modal-actions' }, cancel, ok)
      )
    );
    document.body.append(scrim);
    document.addEventListener('keydown', onKey);
    cancel.focus();
  });
}

function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('icpc-theme', next); } catch { /* storage blocked */ }
}

/* ───────────── report drawer ───────────── */

function openDrawer() {
  if (drawer) return drawer;
  const head = h('div', { class: 'drawer-head' });
  const body = h('div', { class: 'drawer-body' });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report detail', tabindex: '-1' }, head, body);
  const wrap = h('div', { class: 'drawer-layer' }, h('div', { class: 'drawer-scrim', onClick: closeDrawer }), panel);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-scrim')) closeDrawer(); };
  document.body.append(wrap);
  document.body.classList.add('no-scroll');
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => wrap.classList.add('open'));
  drawer = { wrap, head, body, panel, onKey, opener: document.activeElement };
  panel.focus();
  return drawer;
}

function closeDrawer() {
  if (!drawer) return;
  const d = drawer;
  drawer = null;
  state.selectedId = null;
  markSelected();
  document.removeEventListener('keydown', d.onKey);
  document.body.classList.remove('no-scroll');
  d.wrap.classList.remove('open');
  setTimeout(() => d.wrap.remove(), 230);
  if (d.opener && d.opener.isConnected && d.opener.focus) d.opener.focus();
}

const closeBtn = () => h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close report', onClick: closeDrawer }, icon('X', 20));

function detailSkeleton() {
  const card = (...kids) => h('div', { class: 'card' }, ...kids);
  return h('div', { class: 'skel-stack', 'aria-busy': 'true', 'aria-label': 'Loading report' },
    card(skel('40%', '1rem', 'block'), h('div', { style: null }, skel('100%', '0.9rem', 'block')), skel('85%', '0.9rem', 'block'), skel('70%', '0.9rem', 'block')),
    card(skel('35%', '1rem', 'block'), skel('100%', '0.9rem', 'block'), skel('100%', '0.9rem', 'block'), skel('60%', '0.9rem', 'block')),
    card(skel('30%', '1rem', 'block'), h('div', { class: 'ev-grid' }, skel('100%', '120px'), skel('100%', '120px'), skel('100%', '120px'))),
  );
}

/* ───────────── auth views ───────────── */

function passwordInput(autocomplete, extra = {}) {
  const input = h('input', { type: 'password', autocomplete, required: true, maxlength: 128, ...extra });
  const toggle = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Show password', onClick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.replaceChildren(icon(show ? 'EyeOff' : 'Eye', 18));
  } }, icon('Eye', 18));
  return { input, wrapper: h('div', { class: 'pw' }, input, toggle) };
}

function authLayout(card) {
  return h('div', { class: 'auth' },
    h('div', { class: 'side-brand' },
      h('img', {
        class: 'logo',
        src: '/admin/assets/icpc-logo.png',
        alt: '',
      }),
      'ICPC case desk'),
      h('div', { class: 'pitch' },
        h('h2', null, 'Every report, reviewed and on record.'),
        h('p', null, 'Read incoming reports, move them through review, and keep a trail of who did what.')
      ),
      h('ul', { class: 'pitch' },
        h('li', null, icon('Lock', 18), 'Informant details open only on request and are logged'),
        h('li', null, icon('Clock', 18), 'Evidence links expire automatically'),
        h('li', null, icon('ScrollText', 18), 'Every status change is recorded')
      )
    ),
    h('main', { class: 'auth-main', id: 'main' }, card)
  );
}

function renderLogin(message) {
  closeDrawer();
  shell = null;
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxlength: 120 });
  const pw = passwordInput('current-password');
  const error = h('div', { class: 'error error-line', role: 'alert' }, message || '');
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  const form = h('form', {
    class: 'auth-card',
    onSubmit: async (e) => {
      e.preventDefault();
      setBusy(submit, true);
      error.textContent = '';
      try {
        const { admin } = await api('/auth/login', { method: 'POST', body: { email: email.value, password: pw.input.value } });
        state.me = admin;
        start();
      } catch (err) {
        if (!err.handled) error.textContent = err.message;
        setBusy(submit, false);
      }
    },
  },
    h('h1', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Use your official account to review and update reports.'),
    field('Email', email),
    field('Password', pw.wrapper, null, pw.input),
    error,
    submit,
  );
  root.replaceChildren(authLayout(form));
  email.focus();
}

function renderChangePassword(forced) {
  const current = passwordInput('current-password');
  const next = passwordInput('new-password', { minlength: 12 });
  const confirm = passwordInput('new-password', { minlength: 12 });
  const error = h('div', { class: 'error error-line', role: 'alert' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Save new password');

  const form = h('form', {
    class: 'auth-card',
    onSubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (next.input.value !== confirm.input.value) { error.textContent = 'The new passwords do not match.'; return; }
      setBusy(submit, true);
      try {
        const { admin } = await api('/auth/change-password', { method: 'POST', body: { currentPassword: current.input.value, newPassword: next.input.value } });
        state.me = admin;
        if (!forced) toast('Password changed. Other devices were signed out.');
        start();
      } catch (err) {
        if (!err.handled) error.textContent = err.message;
        setBusy(submit, false);
      }
    },
  },
    h('h1', null, forced ? 'Choose a new password' : 'Change password'),
    h('p', { class: 'muted' }, forced ? 'You are using a temporary password. Set your own to continue.' : 'Other signed-in devices will be signed out.'),
    field(forced ? 'Temporary password' : 'Current password', current.wrapper, null, current.input),
    field('New password', next.wrapper, 'At least 12 characters, with letters and numbers.', next.input),
    field('Confirm new password', confirm.wrapper, null, confirm.input),
    error,
    submit,
    forced ? h('button', { class: 'btn ghost block', type: 'button', onClick: signOut }, 'Sign out') : h('button', { class: 'btn ghost block', type: 'button', onClick: () => renderShell() }, 'Cancel'),
  );
  root.replaceChildren(authLayout(form));
  current.input.focus();
}

async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
  state.me = null;
  state.stats = null;
  state.items = [];
  renderLogin();
}

/* ───────────── shell ───────────── */

const VIEWS = {
  reports: { label: 'Reports', title: 'Reports', icon: 'FileText' },
  admins: { label: 'Admins', title: 'Admins', icon: 'Users', superOnly: true },
  audit: { label: 'Activity log', title: 'Activity log', icon: 'ScrollText', superOnly: true },
};

function renderShell() {
  closeDrawer();
  const isSuper = state.me.role === 'SUPER_ADMIN';
  if (VIEWS[state.view]?.superOnly && !isSuper) state.view = 'reports';

  const app = h('div', { class: 'app', 'data-nav': 'closed' });
  const setNav = (open) => {
    app.setAttribute('data-nav', open ? 'open' : 'closed');
    menuBtn.setAttribute('aria-expanded', String(open));
  };

  const nav = h('nav', { class: 'side-nav', 'aria-label': 'Sections' });
  const themeBtn = h('button', { type: 'button', onClick: () => { toggleTheme(); paintThemeBtn(); } });
  const paintThemeBtn = () => {
    const dark = currentTheme() === 'dark';
    themeBtn.replaceChildren(icon(dark ? 'Sun' : 'Moon', 18), dark ? 'Light theme' : 'Dark theme');
  };
  paintThemeBtn();

  const menuBtn = h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', onClick: () => setNav(true) }, icon('Menu', 22));
  const title = h('h1', { class: 'page-title' });
  const actions = h('div', { class: 'top-actions' });
  const main = h('main', { id: 'main', class: 'main', tabindex: '-1' });

  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Navigation' },
    h('div', { class: 'side-brand' },
      h('img', {
        class: 'logo',
        src: '/admin/assets/icpc-logo.png',
        alt: '',
      }),
      'ICPC case desk'),
    nav,
    h('div', { class: 'side-foot' },
      h('div', { class: 'me' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(state.me.name)),
        h('div', null, h('div', { class: 'me-name' }, state.me.name), h('div', { class: 'me-role' }, isSuper ? 'Super admin' : 'Officer'))
      ),
      themeBtn,
      h('button', { type: 'button', onClick: () => renderChangePassword(false) }, icon('KeyRound', 18), 'Change password'),
      h('button', { type: 'button', onClick: signOut }, icon('LogOut', 18), 'Sign out'),
    )
  );

  app.append(
    sidebar,
    h('div', { class: 'scrim', onClick: () => setNav(false) }),
    h('div', { class: 'content' }, h('header', { class: 'topbar' }, menuBtn, title, actions), main)
  );
  shell = { app, nav, title, actions, main, setNav, isSuper };
  root.replaceChildren(app);
  renderView();
}

function renderNav() {
  const keys = Object.keys(VIEWS).filter((k) => !VIEWS[k].superOnly || shell.isSuper);
  shell.nav.replaceChildren(...keys.map((key) =>
    h('button', {
      type: 'button', 'aria-current': state.view === key ? 'page' : null,
      onClick: () => { state.view = key; shell.setNav(false); renderView(); },
    }, icon(VIEWS[key].icon, 18), VIEWS[key].label)
  ));
}

function renderView() {
  closeDrawer();
  els = {};
  renderNav();
  shell.title.textContent = VIEWS[state.view].title;
  shell.actions.replaceChildren();
  shell.main.replaceChildren();
  document.title = VIEWS[state.view].title + ' · ICPC case desk';
  if (state.view === 'reports') renderReportsView(shell.main);
  else if (state.view === 'admins') renderAdminsView(shell.main);
  else if (state.view === 'audit') renderAuditView(shell.main);
}

function refreshButton(onClick) {
  const btn = h('button', { class: 'btn', type: 'button', onClick: async () => {
    setBusy(btn, true);
    try { await onClick(); } finally { setBusy(btn, false); }
  } }, icon('RefreshCw', 16), h('span', { class: 'label' }, 'Refresh'));
  return btn;
}

function tableSkeleton(columns, rows = 6) {
  return h('div', { class: 'table-wrap', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, Array.from({ length: rows }, () =>
        h('tr', null, columns.map((c, i) => h('td', { class: i === 0 ? 'lead' : null, 'data-label': i === 0 ? null : c },
          i === 0 ? [skel('120px', '0.9rem', 'block'), skel('70%', '0.75rem', 'block')] : skel(i === 2 ? '84px' : '70px', i === 2 ? '1.3rem' : '0.9rem', i === 2 ? 'pill' : '')
        )))
      ))
    )
  );
}

/* ───────────── reports view ───────────── */

function renderReportsView(main) {
  shell.actions.append(refreshButton(() => Promise.all([loadStats(), refreshList(true)])));

  els.overview = h('section', { class: 'card overview', 'aria-label': 'Reports by status' });
  els.list = h('div');
  els.more = h('div', { class: 'more' });

  const stateSelect = h('select', { 'aria-label': 'Filter by state', onChange: (e) => { state.filters.state = e.target.value; updateFilterBar(); refreshList(); } });
  const search = h('input', { type: 'search', placeholder: 'Search by tracking or reference code, e.g. ICPC-XXXXX-XXXXX', maxlength: 60, value: state.filters.q, autocomplete: 'off', 'aria-label': 'Search by tracking code' });
  els.stateSelect = stateSelect;
  els.search = search;
  els.clear = h('button', { class: 'btn hidden', type: 'button', onClick: () => {
    state.filters = { status: '', state: '', q: '' };
    search.value = ''; stateSelect.value = '';
    updateFilterBar(); renderOverview(); refreshList();
  } }, icon('X', 16), 'Clear filters');

  // search as you type, after a short pause
  let timer;
  const applySearch = () => {
    const q = search.value.trim();
    if (q === state.filters.q) return;
    state.filters.q = q; updateFilterBar(); refreshList();
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(applySearch, 350); });

  const toolbar = h('form', { class: 'toolbar', role: 'search', onSubmit: (e) => { e.preventDefault(); clearTimeout(timer); applySearch(); } },
    h('div', { class: 'search' }, icon('Search', 18), search),
    stateSelect,
    els.clear
  );

  main.append(
    els.overview,
    h('section', { class: 'card flush', 'aria-label': 'Reports' }, toolbar, els.list, els.more)
  );
  updateFilterBar();
  renderOverview();
  if (state.stats) fillStates();
  loadStats();
  refreshList();
}

function updateFilterBar() {
  const f = state.filters;
  if (els.clear) els.clear.classList.toggle('hidden', !(f.status || f.state || f.q));
}

function fillStates() {
  if (!els.stateSelect || !state.stats) return;
  const keep = state.filters.state;
  els.stateSelect.replaceChildren(h('option', { value: '' }, 'All states'), state.stats.states.map((s) => h('option', { value: s }, s)));
  els.stateSelect.value = keep;
}

async function loadStats() {
  try {
    state.stats = await api('/reports/stats');
    if (!els.overview) return;
    renderOverview();
    fillStates();
  } catch (err) {
    if (err.handled) return;
    console.error(err);
    if (!state.stats && els.overview) els.overview.replaceChildren(errorPanel(err.message, loadStats));
  }
}

function renderOverview() {
  if (!els.overview) return;
  const s = state.stats;
  const total = s ? s.total : 0;

  const head = h('div', { class: 'ov-head' },
    h('div', null,
      h('div', { class: 'ov-label' }, 'Total reports'),
      s ? h('div', { class: 'ov-total' }, total.toLocaleString()) : skel('96px', '2.4rem', 'block')
    ),
    s
      ? h('div', { class: 'ov-week' }, icon('Inbox', 16), h('span', null, s.last7Days.toLocaleString() + ' new in the last 7 days'))
      : skel('170px', '1rem')
  );

  const bar = h('div', { class: 'dist' + (s ? '' : ' loading'), role: 'img', 'aria-label': 'Share of reports by status' });
  if (s && total > 0) {
    for (const st of STATUSES) {
      const n = s.byStatus[st.key] || 0;
      if (!n) continue;
      const seg = h('span', { class: 'seg', 'data-status': st.key, title: st.label + ': ' + n.toLocaleString() });
      seg.style.flex = n + ' 1 0%';
      seg.style.minWidth = '6px';
      bar.append(seg);
    }
  } else {
    bar.append(h('span', { class: 'seg empty' }));
  }

  const tiles = h('div', { class: 'tiles' }, STATUSES.map((st) => {
    const n = s ? s.byStatus[st.key] || 0 : 0;
    const active = state.filters.status === st.key;
    return h('button', {
      type: 'button', class: 'tile', 'data-status': st.key, 'aria-pressed': String(active),
      onClick: () => { state.filters.status = active ? '' : st.key; updateFilterBar(); renderOverview(); refreshList(); },
    },
      h('span', { class: 't-top' }, h('span', { class: 'dot' }), st.label),
      s ? h('span', { class: 't-count' }, n.toLocaleString()) : skel('46px', '1.5rem', 'block'),
      s ? h('span', { class: 't-pct' }, total > 0 ? Math.round((n / total) * 100) + '% of all' : '—') : skel('60px', '0.75rem', 'block'),
    );
  }));

  els.overview.replaceChildren(head, bar, tiles);
}

const REPORT_COLUMNS = ['Report', 'Location', 'Status', 'Submitted', 'Files'];

function renderListSkeleton() {
  els.list.replaceChildren(tableSkeleton(REPORT_COLUMNS, 6));
  els.more.replaceChildren();
}

function refreshList(quiet) { return loadMore(true, quiet === true); }

async function loadMore(reset, quiet = false) {
  if (!els.list) return;
  if (!reset && state.listLoading) return;
  const token = ++state.listToken;
  state.listLoading = true;
  if (reset && !quiet) { state.items = []; state.nextCursor = null; renderListSkeleton(); }
  try {
    const p = new URLSearchParams({ limit: '25' });
    if (state.filters.status) p.set('status', state.filters.status);
    if (state.filters.state) p.set('state', state.filters.state);
    if (state.filters.q) p.set('q', state.filters.q);
    if (!reset && state.nextCursor) p.set('cursor', state.nextCursor);
    const data = await api('/reports?' + p.toString());
    if (token !== state.listToken || !els.list) return; // a newer request replaced this one
    state.items = reset ? data.items : state.items.concat(data.items);
    state.nextCursor = data.nextCursor;
    renderList();
  } catch (err) {
    if (token !== state.listToken || err.handled || !els.list) return;
    if (reset && !quiet) els.list.replaceChildren(errorPanel(err.message, () => refreshList()));
    else { toast(err.message, 'error'); renderList(); }
  } finally {
    if (token === state.listToken) state.listLoading = false;
  }
}

function renderList() {
  if (state.items.length === 0) {
    const filtered = state.filters.q || state.filters.status || state.filters.state;
    els.list.replaceChildren(filtered
      ? emptyState('Search', 'No reports match', 'Try a different tracking code or clear the filters.', els.clear && h('button', { class: 'btn', type: 'button', onClick: () => els.clear.click() }, 'Clear filters'))
      : emptyState('Inbox', 'No reports yet', 'New reports will show up here as soon as they are submitted.'));
    els.more.replaceChildren();
    return;
  }
  const rows = state.items.map((r) =>
    h('tr', {
      class: 'row', tabindex: '0', 'data-id': r.id, 'aria-selected': String(state.selectedId === r.id),
      onClick: () => openReport(r.id),
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReport(r.id); } },
    },
      h('td', { class: 'lead' }, h('div', { class: 'code' }, r.trackingCode || '—'), h('div', { class: 'snippet' }, r.snippet)),
      h('td', { 'data-label': 'Location' }, r.city + ', ' + r.state),
      h('td', { 'data-label': 'Status' }, badge(r.status)),
      h('td', { class: 'num', 'data-label': 'Submitted', title: fmt(r.createdAt) }, ago(r.createdAt)),
      h('td', { class: 'num', 'data-label': 'Files' }, r.mediaCount ? h('span', { class: 'attach' }, icon('Paperclip', 14), String(r.mediaCount)) : '—'),
      h('td', { class: 'go', 'aria-hidden': 'true' }, icon('ChevronRight', 18)),
    )
  );
  els.list.replaceChildren(
    h('div', { class: 'table-wrap' },
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, [...REPORT_COLUMNS, ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows)
      )
    )
  );
  els.more.replaceChildren(
    state.nextCursor ? h('button', { class: 'btn', type: 'button', onClick: async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, true);
      await loadMore(false);
      setBusy(btn, false);
    } }, 'Load older reports') : null
  );
}

function markSelected() {
  if (!els.list) return;
  els.list.querySelectorAll('tr.row').forEach((tr) => tr.setAttribute('aria-selected', String(tr.dataset.id === state.selectedId)));
}

async function openReport(id, silent = false) {
  state.selectedId = id;
  markSelected();
  const d = openDrawer();
  if (!silent) {
    d.head.replaceChildren(h('div', { class: 'dh-main' }, skel('150px', '1.2rem', 'block')), closeBtn());
    d.body.replaceChildren(detailSkeleton());
  }
  try {
    const report = await api('/reports/' + encodeURIComponent(id));
    if (!drawer || state.selectedId !== id) return; // closed or switched while loading
    renderDetail(report);
  } catch (err) {
    if (!err.handled && drawer && state.selectedId === id) {
      drawer.body.replaceChildren(errorPanel(err.message, () => openReport(id)));
    }
  }
}

function renderDetail(r) {
  const d = drawer;

  d.head.replaceChildren(
    h('div', { class: 'dh-main' },
      h('div', { class: 'dh-code' },
        h('h2', { class: 'code' }, r.trackingCode || 'No tracking code'),
        r.trackingCode ? h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Copy tracking code', onClick: () => copyText(r.trackingCode, 'Tracking code copied') }, icon('Copy', 15)) : null
      ),
      h('div', { class: 'small muted' }, 'Reference ' + r.id)
    ),
    badge(r.status),
    closeBtn()
  );

  /* informant (shown only on request, and logged by the server) */
  const informantBox = h('div');
  const showBtn = h('button', { class: 'btn small', type: 'button' }, icon('Eye', 16), 'Show informant details');
  if (r.hasInformant) {
    let shown = false;
    showBtn.addEventListener('click', async () => {
      if (shown) {
        informantBox.replaceChildren(); showBtn.replaceChildren(icon('Eye', 16), 'Show informant details'); shown = false; return;
      }
      setBusy(showBtn, true);
      try {
        const { informant } = await api('/reports/' + encodeURIComponent(r.id) + '/informant');
        const dl = h('dl', { class: 'facts' },
          [['Name', informant?.name], ['Phone', informant?.phone], ['Email', informant?.email], ['Address', informant?.address]]
            .flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v || 'Not provided')])
        );
        informantBox.replaceChildren(h('p', { class: 'hint', style: null }, 'This view is recorded in the activity log.'), dl);
        showBtn.replaceChildren(icon('EyeOff', 16), 'Hide informant details');
        shown = true;
      } catch (err) {
        if (!err.handled) toast(err.message, 'error');
      } finally { setBusy(showBtn, false); }
    });
  }

  /* evidence */
  const evidence = r.media.map((m) => {
    if (!safeHttps(m.url)) return null;
    if (m.type === 'image') return h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: m.url, alt: 'Evidence image ' + m.name, loading: 'lazy' }));
    if (m.type === 'video') return h('video', { src: m.url, controls: true, preload: 'metadata' });
    return h('a', { class: 'file', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, icon('File', 22), m.name);
  }).filter(Boolean);

  /* status form */
  let chosen = r.status;
  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Status' }, STATUSES.map((s) =>
    h('label', { class: 'chip', 'data-status': s.key },
      h('input', { type: 'radio', name: 'status-' + r.id, value: s.key, checked: s.key === r.status, onChange: () => { chosen = s.key; } }),
      h('span', null, s.label)
    )
  ));
  const counter = (max, ta) => { const c = h('span', { class: 'hint' }, '0/' + max); ta.addEventListener('input', () => { c.textContent = ta.value.length + '/' + max; }); return c; };
  const pub = h('textarea', { maxlength: 500, placeholder: 'Optional. The reporter can read this in the app.' });
  const internal = h('textarea', { maxlength: 2000, placeholder: 'Optional. Only officials can read this.' });
  const formError = h('div', { class: 'error error-line', role: 'alert' });
  const save = h('button', { class: 'btn primary block', type: 'submit' }, 'Update status');
  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      formError.textContent = '';
      setBusy(save, true);
      try {
        await api('/reports/' + encodeURIComponent(r.id) + '/status', {
          method: 'PATCH',
          body: { status: chosen, publicNote: pub.value.trim() || undefined, internalNote: internal.value.trim() || undefined },
        });
        toast('Status updated to ' + STATUS_LABEL[chosen]);
        const jobs = [loadStats(), refreshList(true)];
        if (drawer && state.selectedId === r.id) jobs.push(openReport(r.id, true));
        await Promise.all(jobs);
      } catch (err) {
        if (!err.handled) formError.textContent = err.message;
      } finally { setBusy(save, false); }
    },
  },
    h('div', { class: 'field' }, h('label', null, 'Status'), chips),
    h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { for: 'note-pub' }, 'Note for the reporter'), counter(500, pub)), pub,
      h('span', { class: 'hint' }, 'Shown next to this update in the mobile app. Do not include personal details.')),
    h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { for: 'note-int' }, 'Internal note'), counter(2000, internal)), internal),
    formError,
    save,
  );
  pub.id = 'note-pub';
  internal.id = 'note-int';

  /* history */
  const history = h('ol', { class: 'history' },
    r.events.map((ev) =>
      h('li', { 'data-status': ev.toStatus },
        h('div', { class: 'who' }, badge(ev.toStatus), h('span', { class: 'small muted' }, fmt(ev.createdAt) + (ev.actorEmail ? ' · ' + ev.actorEmail : ''))),
        ev.publicNote ? h('div', { class: 'note' }, 'Shown to reporter: ' + ev.publicNote) : null,
        ev.internalNote ? h('div', { class: 'note internal' }, 'Internal: ' + ev.internalNote) : null,
      )
    )
  );

  d.body.replaceChildren(
    h('section', { class: 'card' },
      h('dl', { class: 'facts' },
        h('dt', null, 'Submitted'), h('dd', null, fmt(r.createdAt)),
        h('dt', null, 'Last update'), h('dd', null, fmt(r.statusUpdatedAt)),
        h('dt', null, 'State'), h('dd', null, r.state),
        h('dt', null, 'City'), h('dd', null, r.city),
        h('dt', null, 'Address'), h('dd', null, r.address),
      )
    ),
    h('section', { class: 'card' }, h('h3', null, 'What happened'), h('p', { class: 'description' }, r.description)),
    h('section', { class: 'card' },
      h('h3', null, 'Evidence', h('span', { class: 'count' }, '(' + r.media.length + ')')),
      evidence.length ? h('div', { class: 'ev-grid' }, evidence) : h('p', { class: 'muted' }, 'No files attached.'),
      evidence.length ? h('p', { class: 'hint' }, 'Links expire after 15 minutes. Reopen the report for fresh ones.') : null
    ),
    h('section', { class: 'card' }, h('h3', null, 'Informant'),
      r.hasInformant ? [showBtn, informantBox] : h('p', { class: 'muted' }, 'Reported anonymously.')),
    h('section', { class: 'card' }, h('h3', null, 'Update status'), form),
    h('section', { class: 'card' }, h('h3', null, 'History'), history),
  );
}

/* ───────────── admins view (super admin) ───────────── */

function renderAdminsView(main) {
  const listBox = h('div');
  const tempBox = h('div');

  const email = h('input', { type: 'email', required: true, maxlength: 120, autocomplete: 'off' });
  const name = h('input', { type: 'text', required: true, minlength: 2, maxlength: 80, autocomplete: 'off' });
  const role = h('select', null, h('option', { value: 'OFFICER' }, 'Officer'), h('option', { value: 'SUPER_ADMIN' }, 'Super admin'));
  const err = h('div', { class: 'error error-line', role: 'alert' });
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('UserPlus', 16), 'Create admin');

  const showTemp = (title, who, password) =>
    tempBox.replaceChildren(
      h('div', { class: 'notice' },
        h('strong', null, title),
        h('p', null, who + ' must change this temporary password when they first sign in. It is shown once, so share it through a secure channel now.'),
        h('div', { class: 'temp' }, password),
        h('button', { class: 'btn small', type: 'button', onClick: () => copyText(password, 'Password copied') }, icon('Copy', 15), 'Copy password'),
      )
    );

  const createForm = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      setBusy(createBtn, true);
      try {
        const { admin, tempPassword } = await api('/admins', { method: 'POST', body: { email: email.value, name: name.value, role: role.value } });
        showTemp('Admin created', admin.email, tempPassword);
        email.value = ''; name.value = '';
        toast('Admin created');
        load();
      } catch (e2) { if (!e2.handled) err.textContent = e2.message; }
      finally { setBusy(createBtn, false); }
    },
  },
    h('div', { class: 'two' }, field('Email', email), field('Full name', name), field('Role', role, 'Officers review reports. Super admins also manage accounts.')),
    err,
    createBtn,
  );

  const COLS = ['Name', 'Email', 'Role', 'Last sign-in', ''];

  async function resetPassword(a, btn) {
    const ok = await confirmDialog({ title: 'Reset password?', message: a.email + ' will be signed out everywhere and given a new temporary password.', confirmLabel: 'Reset password' });
    if (!ok) return;
    setBusy(btn, true);
    try {
      const { tempPassword } = await api('/admins/' + encodeURIComponent(a.id) + '/reset-password', { method: 'POST' });
      showTemp('Password reset', a.email, tempPassword);
      tempBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e3) { if (!e3.handled) toast(e3.message, 'error'); }
    finally { setBusy(btn, false); }
  }

  async function removeAdmin(a, btn) {
    const ok = await confirmDialog({ title: 'Remove ' + a.name + '?', message: a.email + ' will lose access immediately. This cannot be undone.', confirmLabel: 'Remove admin', danger: true });
    if (!ok) return;
    setBusy(btn, true);
    try {
      await api('/admins/' + encodeURIComponent(a.id), { method: 'DELETE' });
      tempBox.replaceChildren();
      toast('Admin removed');
      load();
    } catch (e4) { if (!e4.handled) toast(e4.message, 'error'); setBusy(btn, false); }
  }

  async function load() {
    try {
      const { admins } = await api('/admins');
      listBox.replaceChildren(
        h('div', { class: 'table-wrap' },
          h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, COLS.map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, admins.map((a) => {
              const isMe = a.id === state.me.id;
              const resetBtn = h('button', { class: 'btn small', type: 'button', onClick: () => resetPassword(a, resetBtn) }, icon('KeyRound', 15), 'Reset password');
              const removeBtn = h('button', { class: 'btn small danger', type: 'button', onClick: () => removeAdmin(a, removeBtn) }, icon('Trash2', 15), 'Remove');
              return h('tr', null,
                h('td', { class: 'lead' }, h('strong', null, a.name), isMe ? h('span', { class: 'muted' }, ' (you)') : null),
                h('td', { 'data-label': 'Email' }, a.email),
                h('td', { 'data-label': 'Role' }, h('span', { class: 'pill' + (a.role === 'SUPER_ADMIN' ? ' accent' : '') }, a.role === 'SUPER_ADMIN' ? 'Super admin' : 'Officer')),
                h('td', { class: 'num', 'data-label': 'Last sign-in' }, a.lastLoginAt ? fmt(a.lastLoginAt) : (a.mustChangePassword ? 'Has not signed in yet' : '—')),
                h('td', { class: 'actions-cell' }, isMe ? null : h('div', { class: 'actions' }, resetBtn, removeBtn)),
              );
            }))
          )
        )
      );
    } catch (e5) { if (!e5.handled) listBox.replaceChildren(errorPanel(e5.message, load)); }
  }

  listBox.append(tableSkeleton(COLS, 4));
  main.append(h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Add an admin'), h('p', { class: 'muted small' }, 'They get a temporary password and must choose their own on first sign-in.'))),
      createForm, tempBox),
    h('section', { class: 'card flush' },
      h('div', { class: 'card-head', style: null }, h('h2', { class: 'pad' }, 'Admins')),
      listBox),
  ));
  load();
}

/* ───────────── audit view (super admin) ───────────── */

function renderAuditView(main) {
  const COLS = ['When', 'Who', 'Action', 'Report', 'Details', 'IP'];
  const box = h('div');
  box.append(tableSkeleton(COLS, 8));

  async function load() {
    try {
      const { logs } = await api('/audit');
      if (!logs.length) { box.replaceChildren(emptyState('ScrollText', 'No activity yet', 'Sign-ins, report views and status changes will be listed here.')); return; }
      box.replaceChildren(
        h('div', { class: 'table-wrap' },
          h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, COLS.map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, logs.map((l) =>
              h('tr', null,
                h('td', { class: 'num lead', title: fmt(l.createdAt) }, ago(l.createdAt)),
                h('td', { 'data-label': 'Who' }, l.actorEmail || '—'),
                h('td', { 'data-label': 'Action' }, h('span', { class: 'pill' }, sentence(l.action))),
                h('td', { 'data-label': 'Report' }, l.reportId ? h('span', { class: 'code' }, l.reportId) : '—'),
                h('td', { 'data-label': 'Details' }, l.meta ? h('code', { class: 'meta' }, JSON.stringify(l.meta)) : '—'),
                h('td', { class: 'num', 'data-label': 'IP' }, l.ip || '—'),
              )
            ))
          )
        )
      );
    } catch (e) { if (!e.handled) box.replaceChildren(errorPanel(e.message, () => { box.replaceChildren(tableSkeleton(COLS, 8)); load(); })); }
  }

  shell.actions.append(refreshButton(async () => { box.replaceChildren(tableSkeleton(COLS, 8)); await load(); }));
  main.append(h('section', { class: 'card flush' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Latest activity'), h('p', { class: 'muted small' }, 'The latest 100 sign-ins, report views, status changes and account changes.'))),
    box));
  load();
}

/* ───────────── boot ───────────── */

function start() {
  if (state.me?.mustChangePassword) renderChangePassword(true);
  else renderShell();
}

(async function boot() {
  root.replaceChildren(h('div', { class: 'auth-main', style: null }, h('span', { class: 'spinner lg', role: 'status', 'aria-label': 'Loading' })));
  try {
    const { admin } = await api('/auth/me');
    state.me = admin;
    start();
  } catch (err) {
    if (!err.handled) renderLogin();
  }
})();