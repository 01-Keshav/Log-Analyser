/* ═══════════════════════════════════════════════════════════════
   LOG ANALYSER — app.js
   Vanilla JS SPA · No dependencies · Connects to Express backend
═══════════════════════════════════════════════════════════════ */

'use strict';

// ── CONFIG ──────────────────────────────────────────────────────
let API_BASE = localStorage.getItem('log_api_base') || 'http://localhost:3001';
let GEMINI_KEY = localStorage.getItem('log_gemini_key') || '';

const PAGE_SIZE = 50;

// ── STATE ────────────────────────────────────────────────────────
const state = {
  view: 'dashboard',
  explorer: { offset: 0, total: 0, logs: [], filters: {} },
  chat: { messages: [], loading: false },
  summary: null,
  analyzeData: null,
};

// ── UTILS ────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function $$(sel) { return document.querySelectorAll(sel); }

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) +
      ' ' + d.toTimeString().slice(0, 8);
  } catch { return iso; }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, type = 'info', duration = 3500) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

async function apiFetch(path, opts = {}) {
  const url = API_BASE + path;
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.message.includes('fetch') || e.message.includes('Failed')) {
      throw new Error('Cannot reach backend. Is the server running on port 3001?');
    }
    throw e;
  }
}

// ── NAVIGATION ───────────────────────────────────────────────────
function navigate(view) {
  state.view = view;
  $$('.view').forEach(el => el.classList.remove('active'));
  $$('.nav-item').forEach(el => el.classList.remove('active'));

  const viewEl = $(`view-${view}`);
  const navEl = $(`nav-${view}`);
  if (viewEl) viewEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: ['Dashboard', 'Overview'],
    explorer:  ['Log Explorer', 'Browse & Filter Logs'],
    ingest:    ['Ingest Logs', 'Add New Logs'],
    analytics: ['Analytics', 'Charts & Statistics'],
    chat:      ['AI Chat', 'Gemini-Powered Analysis'],
  };
  const [title, sub] = titles[view] || ['', ''];
  $('page-title').textContent = title;
  $('breadcrumb').textContent = sub;

  // Load data on navigate
  if (view === 'dashboard') loadDashboard();
  if (view === 'explorer') loadExplorer();
  if (view === 'analytics') loadAnalytics();
}

// ── DASHBOARD ────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [summary, analyze] = await Promise.all([
      apiFetch('/api/summary'),
      apiFetch('/api/analyze'),
    ]);
    state.summary = summary;
    state.analyzeData = analyze;
    renderDashboard(summary, analyze);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderDashboard(s, a) {
  // KPI values
  $('kpi-total-val').textContent = fmt(s.total_logs);
  $('kpi-sources-sub').textContent = `${s.sources} source${s.sources !== 1 ? 's' : ''}`;
  $('pill-count').textContent = fmt(s.total_logs);

  const errorRate = parseFloat(s.error_rate);
  $('kpi-error-val').textContent = s.error_rate;
  $('kpi-error-count-sub').textContent = `${fmt(s.level_counts?.ERROR || 0)} errors`;

  $('kpi-warn-val').textContent = fmt(s.level_counts?.WARN || 0);
  $('kpi-anomaly-sub').textContent = s.has_anomalies ? '⚠ Anomalies detected' : 'No anomalies';

  const health = Math.max(0, 100 - errorRate * 3).toFixed(0);
  $('kpi-health-val').textContent = health + '%';
  $('kpi-health-sub').textContent = health >= 90 ? '✓ Healthy' : health >= 70 ? '⚠ Degraded' : '✗ Critical';

  // Charts
  drawTimeline('chart-timeline', a.timeline || [], 'chart-timeline-empty');
  drawDonut('chart-donut', a.byLevel || {}, 'donut-legend');

  // Top errors
  const errList = $('top-errors-list');
  if (s.top_errors && s.top_errors.length > 0) {
    errList.innerHTML = s.top_errors.map((e, i) => `
      <li>
        <span class="error-rank">#${i + 1}</span>
        <span class="error-name">${escHtml(e.type)}</span>
        <span class="error-count">${e.count}</span>
      </li>`).join('');
  } else {
    errList.innerHTML = '<li class="empty-state" style="padding:12px">No errors detected 🎉</li>';
  }

  // Recent logs
  const recent = $('recent-logs');
  if (s.recent_logs && s.recent_logs.length > 0) {
    recent.innerHTML = s.recent_logs.slice().reverse().map(l => `
      <div class="log-row ${l.level}">
        <span class="log-ts">${fmtDate(l.timestamp)}</span>
        <span class="level-chip ${l.level}">${l.level}</span>
        <span class="log-source">${escHtml(l.source)}</span>
        <span class="log-message">${escHtml(l.message.slice(0, 120))}</span>
      </div>`).join('');
  } else {
    recent.innerHTML = '<div class="empty-state">No logs yet. Go to <strong>Ingest Logs</strong> to get started.</div>';
  }
}

// ── LOG EXPLORER ─────────────────────────────────────────────────
async function loadExplorer(reset = false) {
  if (reset) state.explorer.offset = 0;
  const f = state.explorer.filters;
  const params = new URLSearchParams({
    limit: PAGE_SIZE,
    offset: state.explorer.offset,
    ...(f.source ? { source: f.source } : {}),
    ...(f.level  ? { level:  f.level  } : {}),
    ...(f.search ? { search: f.search } : {}),
    ...(f.start  ? { startDate: f.start } : {}),
    ...(f.end    ? { endDate:   f.end   } : {}),
  });
  try {
    const data = await apiFetch('/api/logs?' + params);
    state.explorer = { ...state.explorer, total: data.total, logs: data.logs };
    renderLogTable(data);

    // Also refresh source dropdown
    const sources = await apiFetch('/api/sources');
    const sel = $('filter-source');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Sources</option>' +
      (sources.sources || []).map(s => `<option value="${escHtml(s)}"${s === cur ? ' selected' : ''}>${escHtml(s)}</option>`).join('');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderLogTable({ total, logs, offset = 0, limit = PAGE_SIZE }) {
  const body = $('log-table-body');
  if (!logs || logs.length === 0) {
    body.innerHTML = '<div class="empty-state">No logs match your filters.</div>';
  } else {
    body.innerHTML = logs.map(l => `
      <div class="table-row ${l.level}" data-id="${l.id}" role="button" tabindex="0">
        <div class="lt-col lt-ts">${fmtDate(l.timestamp)}</div>
        <div class="lt-col lt-level"><span class="level-chip ${l.level}">${l.level}</span></div>
        <div class="lt-col lt-source">${escHtml(l.source)}</div>
        <div class="lt-col lt-msg">${escHtml(l.message.slice(0, 200))}</div>
      </div>`).join('');

    body.querySelectorAll('.table-row').forEach((row, idx) => {
      row.addEventListener('click', () => openDrawer(logs[idx]));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') openDrawer(logs[idx]); });
    });
  }

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  $('page-info').textContent = `Page ${page} of ${Math.max(1, totalPages)} (${fmt(total)} logs)`;
  $('btn-prev').disabled = offset === 0;
  $('btn-next').disabled = offset + limit >= total;
}

function openDrawer(log) {
  const drawer = $('log-drawer');
  const body = $('drawer-body');
  const meta = log.metadata || {};
  const metaKeys = Object.keys(meta);

  body.innerHTML = `
    <div class="drawer-section">
      <label>Timestamp</label>
      <div class="drawer-value">${escHtml(log.timestamp)}</div>
    </div>
    <div class="drawer-section">
      <label>Level</label>
      <div class="drawer-value"><span class="level-chip ${log.level}">${log.level}</span></div>
    </div>
    <div class="drawer-section">
      <label>Source</label>
      <div class="drawer-value">${escHtml(log.source)}</div>
    </div>
    <div class="drawer-section">
      <label>Message</label>
      <div class="drawer-value">${escHtml(log.message)}</div>
    </div>
    ${metaKeys.length > 0 ? `
    <div class="drawer-section">
      <label>Metadata</label>
      <div class="drawer-meta-grid">
        ${metaKeys.map(k => `
          <div class="drawer-value" style="font-size:11px">
            <span style="color:var(--text-muted)">${escHtml(k)}</span><br/>
            ${escHtml(String(meta[k]))}
          </div>`).join('')}
      </div>
    </div>` : ''}
    <div class="drawer-section">
      <label>Raw Log</label>
      <div class="drawer-value" style="font-size:11.5px;opacity:0.7">${escHtml(log.raw || log.message)}</div>
    </div>
  `;
  drawer.classList.add('open');
}

// ── INGEST ───────────────────────────────────────────────────────
const SAMPLE_LOGS = `2024-01-15 10:28:30 INFO [api-service] Server started on port 8080
2024-01-15 10:30:01 ERROR [api-service] Connection timeout connecting to database host=db.prod.internal port=5432 duration=30012ms
2024-01-15 10:30:02 ERROR [api-service] Connection timeout connecting to database host=db.prod.internal port=5432 duration=30001ms
2024-01-15 10:30:03 WARN [api-service] Retry attempt 1/3 for database connection
2024-01-15 10:30:15 ERROR [auth-service] Authentication failed user_id=usr_9821 reason="invalid_token" request_id=req_abc123
2024-01-15 10:30:16 WARN [api-gateway] Circuit breaker opened for service=auth-service
2024-01-15 10:30:20 INFO [api-service] Health check endpoint /health responded 200 duration=5ms
2024-01-15 10:31:00 ERROR [worker-service] OutOfMemoryError: Java heap space at com.example.DataProcessor.process
2024-01-15 10:31:05 ERROR [worker-service] Service unavailable: upstream dependency not responding
2024-01-15 10:31:10 INFO [api-service] Database connection restored after 90s outage
127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /index.html HTTP/1.0" 200 2326
127.0.0.1 - - [10/Oct/2000:13:56:00 -0700] "POST /api/login HTTP/1.1" 401 512
127.0.0.1 - - [10/Oct/2000:13:56:10 -0700] "GET /api/data HTTP/1.1" 500 128
{"level":"info","timestamp":"2024-01-15T10:32:00Z","msg":"Request processed","request_id":"req_xyz789","user_id":"usr_1234","duration":245,"status":200}
{"level":"error","timestamp":"2024-01-15T10:32:05Z","msg":"Database query failed","request_id":"req_xyz790","error":"connection pool exhausted","duration":5001}`;

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function previewLogs(text) {
  const lines = text.trim().split('\n').filter(l => l.trim()).slice(0, 10);
  const preview = $('ingest-preview');
  const count = $('preview-count');
  const total = text.trim().split('\n').filter(l => l.trim()).length;

  if (!text.trim()) {
    preview.innerHTML = '<div class="empty-state">Preview will appear as you type…</div>';
    count.textContent = '0 entries';
    return;
  }

  count.textContent = `${total} entries (showing first 10)`;
  preview.innerHTML = lines.map(line => {
    const level = /error|err|fatal|critical/i.test(line) ? 'ERROR' :
                  /warn/i.test(line) ? 'WARN' :
                  /debug|trace/i.test(line) ? 'DEBUG' : 'INFO';
    return `<div class="log-row ${level}">
      <span class="level-chip ${level}">${level}</span>
      <span class="log-message">${escHtml(line.slice(0, 150))}</span>
    </div>`;
  }).join('');
}

async function doIngest() {
  const raw_text = $('ingest-textarea').value.trim();
  const source = $('ingest-source').value.trim() || 'app';

  if (!raw_text) { toast('Paste some logs first!', 'error'); return; }

  const btn = $('btn-ingest');
  btn.textContent = 'Ingesting…';
  btn.disabled = true;

  try {
    const result = await apiFetch('/api/logs/ingest', {
      method: 'POST',
      body: JSON.stringify({ raw_text, source }),
    });

    toast(`✓ Ingested ${result.ingested} logs`, 'success');
    $('pill-count').textContent = fmt(result.total);

    const card = $('ingest-result-card');
    card.style.display = '';
    $('ingest-result-body').innerHTML = `
      <div class="result-stat">
        <span>Logs Ingested</span>
        <span class="result-stat-value">${result.ingested}</span>
      </div>
      <div class="result-stat">
        <span>Total in Store</span>
        <span class="result-stat-value">${result.total}</span>
      </div>
      <div class="result-stat">
        <span>Source</span>
        <span class="result-stat-value">${escHtml(source)}</span>
      </div>
      ${result.sample && result.sample.length > 0 ? `
      <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Sample parsed entries:</div>
      ${result.sample.map(l => `
        <div class="log-row ${l.level}" style="cursor:default">
          <span class="level-chip ${l.level}">${l.level}</span>
          <span class="log-source">${escHtml(l.source)}</span>
          <span class="log-message">${escHtml(l.message.slice(0, 100))}</span>
        </div>`).join('')}` : ''}
    `;
  } catch (e) {
    toast(e.message, 'error');
    const card = $('ingest-result-card');
    card.style.display = '';
    $('ingest-result-body').innerHTML = `<div class="result-stat"><span>Error</span><span class="result-stat-value error">${escHtml(e.message)}</span></div>`;
  } finally {
    btn.textContent = 'Ingest Logs';
    btn.disabled = false;
  }
}

// ── ANALYTICS ────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const data = await apiFetch('/api/analyze');
    state.analyzeData = data;
    renderAnalytics(data);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderAnalytics(data) {
  drawTimeline('chart-analytics-timeline', data.timeline || [], 'chart-analytics-empty', true);
  drawErrorTypesBar(data.topErrors || []);
  drawDonut('chart-source-donut', data.bySource || {}, 'source-donut-legend', SOURCE_COLORS);

  // Perf stats
  const perf = $('perf-stats');
  if (data.avgDuration) {
    perf.innerHTML = `
      <div class="perf-stat-card">
        <div class="perf-stat-label">Avg Duration</div>
        <div class="perf-stat-value">${data.avgDuration}<span style="font-size:12px;font-weight:400;color:var(--text-muted)">ms</span></div>
      </div>
      <div class="perf-stat-card">
        <div class="perf-stat-label">Max Duration</div>
        <div class="perf-stat-value">${data.maxDuration}<span style="font-size:12px;font-weight:400;color:var(--text-muted)">ms</span></div>
      </div>
      <div class="perf-stat-card">
        <div class="perf-stat-label">Error Rate</div>
        <div class="perf-stat-value">${data.errorRate}<span style="font-size:12px;font-weight:400;color:var(--text-muted)">%</span></div>
      </div>
      <div class="perf-stat-card">
        <div class="perf-stat-label">Total Logs</div>
        <div class="perf-stat-value">${fmt(data.total)}</div>
      </div>
    `;
  } else {
    perf.innerHTML = '<div class="empty-state">No duration metadata found in logs</div>';
  }
}

// ── CANVAS CHARTS ────────────────────────────────────────────────
const LEVEL_COLORS = {
  ERROR: '#ff4d6a',
  WARN:  '#ffc842',
  INFO:  '#448aff',
  DEBUG: 'rgba(255,255,255,0.15)',
};

const SOURCE_COLORS = ['#00d4ff', '#00ff9d', '#7c6bff', '#ff4d6a', '#ffc842', '#448aff', '#ff6b9d'];

function drawTimeline(canvasId, timeline, emptyId, errorsOnly = false) {
  const canvas = $(canvasId);
  const emptyEl = $(emptyId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width || 600;
  const H = parseInt(canvas.getAttribute('height')) || 160;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  if (!timeline || timeline.length === 0) {
    ctx.clearRect(0, 0, W, H);
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  ctx.clearRect(0, 0, W, H);

  const pad = { top: 16, right: 16, bottom: 30, left: 40 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const levels = errorsOnly ? ['ERROR', 'WARN'] : ['ERROR', 'WARN', 'INFO'];
  const maxVal = Math.max(1, ...timeline.map(b => levels.reduce((s, l) => s + (b[l] || 0), 0)));
  const n = timeline.length;
  const barW = Math.max(2, (cW / n) - 2);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (cH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cW, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `10px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal * (1 - i / 4)), pad.left - 6, y + 4);
  }

  // Stacked bars
  timeline.forEach((bucket, i) => {
    const x = pad.left + i * (cW / n) + (cW / n - barW) / 2;
    let yOff = pad.top + cH;

    for (const level of [...levels].reverse()) {
      const val = bucket[level] || 0;
      if (!val) continue;
      const barH = (val / maxVal) * cH;
      ctx.fillStyle = LEVEL_COLORS[level];
      ctx.beginPath();
      ctx.roundRect(x, yOff - barH, barW, barH, [2, 2, 0, 0]);
      ctx.fill();
      yOff -= barH;
    }

    // X labels (every few)
    const step = Math.max(1, Math.floor(n / 8));
    if (i % step === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'center';
      const label = bucket.time ? bucket.time.slice(11, 16) || bucket.time.slice(5, 10) : '';
      ctx.fillText(label, x + barW / 2, pad.top + cH + 14);
    }
  });

  // Legend
  const legendX = pad.left;
  const legendY = 6;
  levels.forEach((l, i) => {
    const lx = legendX + i * 70;
    ctx.fillStyle = LEVEL_COLORS[l];
    ctx.beginPath();
    ctx.arc(lx + 5, legendY + 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(l, lx + 13, legendY + 8);
  });
}

function drawDonut(canvasId, data, legendId, colorList = null) {
  const canvas = $(canvasId);
  const legendEl = $(legendId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const H = parseInt(canvas.getAttribute('height')) || 180;
  const W = H;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const entries = Object.entries(data).filter(([, v]) => v > 0);
  if (!entries.length) return;

  const total = entries.reduce((s, [, v]) => s + v, 0);
  const cx = W / 2, cy = H / 2;
  const r = Math.min(cx, cy) - 10;
  const inner = r * 0.55;

  const colors = colorList || [LEVEL_COLORS.ERROR, LEVEL_COLORS.WARN, LEVEL_COLORS.INFO, LEVEL_COLORS.DEBUG];

  let angle = -Math.PI / 2;
  entries.forEach(([key, val], i) => {
    const slice = (val / total) * Math.PI * 2;
    const color = colorList ? colors[i % colors.length] : (LEVEL_COLORS[key] || colors[i % colors.length]);

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Gap
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r + 2, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,14,26,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10,14,26,0.8)';
    ctx.stroke();

    angle += slice;
  });

  // Inner hole
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,14,26,0.95)';
  ctx.fill();

  // Center text
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `bold ${Math.floor(r * 0.3)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total.toLocaleString(), cx, cy);

  // Legend
  if (legendEl) {
    angle = -Math.PI / 2;
    legendEl.innerHTML = entries.map(([key, val], i) => {
      const color = colorList ? colors[i % colors.length] : (LEVEL_COLORS[key] || colors[i % colors.length]);
      return `<div class="legend-item">
        <div class="legend-dot" style="background:${color}"></div>
        <span>${escHtml(key)}</span>
        <span class="legend-count">${val}</span>
      </div>`;
    }).join('');
  }
}

function drawErrorTypesBar(topErrors) {
  const canvas = $('chart-error-types');
  const emptyEl = $('chart-errors-empty');
  if (!canvas) return;

  if (!topErrors || topErrors.length === 0) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }

  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width || 300;
  const H = parseInt(canvas.getAttribute('height')) || 200;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const pad = { top: 12, right: 16, bottom: 12, left: 12 };
  const cW = W - pad.left - pad.right;
  const n = topErrors.length;
  const rowH = (H - pad.top - pad.bottom) / n;
  const maxVal = topErrors[0].count;

  topErrors.forEach((e, i) => {
    const y = pad.top + i * rowH;
    const barH = rowH * 0.55;
    const barY = y + (rowH - barH) / 2;
    const barW = Math.max(4, (e.count / maxVal) * cW * 0.6);

    // Background track
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.roundRect(pad.left, barY, cW * 0.6, barH, 4);
    ctx.fill();

    // Bar fill
    const grad = ctx.createLinearGradient(pad.left, 0, pad.left + barW, 0);
    grad.addColorStop(0, '#ff4d6a');
    grad.addColorStop(1, '#ff6b9d');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(pad.left, barY, barW, barH, 4);
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `11px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.type, pad.left + cW * 0.62, barY + barH / 2);

    // Count
    ctx.fillStyle = '#ff4d6a';
    ctx.font = `bold 11px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(e.count, pad.left + cW, barY + barH / 2);
  });
}

// ── AI CHAT ──────────────────────────────────────────────────────
function renderMessages() {
  const container = $('chat-messages');
  const msgs = state.chat.messages;

  if (msgs.length === 0) {
    container.innerHTML = `<div class="chat-welcome">
      <div class="welcome-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
      </div>
      <h2>Log Analysis AI</h2>
      <p>Powered by Gemini 2.5 Flash. Ask me anything about your logs.</p>
      <div class="quick-prompts" id="quick-prompts">
        ${[
          ['Summarize the current log data and identify any critical issues.', 'Summarize logs'],
          ['What are the most common errors and their root causes?', 'Top errors & root causes'],
          ['Are there any performance issues or high latency events?', 'Performance analysis'],
          ['Show me a timeline of events and identify any anomalies.', 'Anomaly detection'],
          ['Correlate logs across different sources and find related events.', 'Cross-source correlation'],
          ['Give me actionable recommendations to fix the issues you found.', 'Recommendations'],
        ].map(([prompt, label]) =>
          `<button class="quick-prompt-btn" data-prompt="${escHtml(prompt)}">${escHtml(label)}</button>`
        ).join('')}
      </div>
    </div>`;

    container.querySelectorAll('.quick-prompt-btn').forEach(btn => {
      btn.addEventListener('click', () => sendChat(btn.dataset.prompt));
    });
    return;
  }

  container.innerHTML = msgs.map(m => `
    <div class="chat-msg ${m.role}">
      <div class="msg-label">${m.role === 'user' ? 'You' : '🤖 AI Assistant'}</div>
      <div class="msg-bubble">${m.role === 'assistant' ? renderMarkdown(m.content) : escHtml(m.content)}</div>
    </div>
  `).join('');

  if (state.chat.loading) {
    container.innerHTML += `
      <div class="chat-msg assistant">
        <div class="msg-label">🤖 AI Assistant</div>
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>`;
  }

  container.scrollTop = container.scrollHeight;
}

// Simple markdown renderer
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
}

async function sendChat(content) {
  if (!content || !content.trim()) return;
  if (state.chat.loading) return;

  if (!GEMINI_KEY) {
    toast('Set your Gemini API key in Settings first!', 'error');
    openSettings();
    return;
  }

  $('chat-input').value = '';
  autoResizeTextarea($('chat-input'));

  state.chat.messages.push({ role: 'user', content: content.trim() });
  state.chat.loading = true;
  renderMessages();

  try {
    const result = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'x-gemini-api-key': GEMINI_KEY },
      body: JSON.stringify({
        messages: state.chat.messages.filter(m => m.role !== 'system'),
      }),
    });
    state.chat.messages.push({ role: 'assistant', content: result.response });
  } catch (e) {
    state.chat.messages.push({ role: 'assistant', content: `❌ Error: ${e.message}` });
  } finally {
    state.chat.loading = false;
    renderMessages();
  }
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── SETTINGS ─────────────────────────────────────────────────────
function openSettings() {
  $('api-key-input').value = GEMINI_KEY;
  $('backend-url-input').value = API_BASE;
  $('settings-modal').style.display = 'flex';
}

function closeSettings() {
  $('settings-modal').style.display = 'none';
}

function saveSettings() {
  GEMINI_KEY = $('api-key-input').value.trim();
  API_BASE = $('backend-url-input').value.trim() || 'http://localhost:3001';
  localStorage.setItem('log_gemini_key', GEMINI_KEY);
  localStorage.setItem('log_api_base', API_BASE);
  updateApiKeyStatus();
  closeSettings();
  toast('Settings saved!', 'success');
}

function updateApiKeyStatus() {
  const dot = $('status-dot');
  const label = $('status-label');
  const banner = $('no-api-key-banner');
  const badge = $('ai-badge');

  if (GEMINI_KEY) {
    dot.classList.add('active');
    label.textContent = 'API Key Set';
    if (banner) banner.style.display = 'none';
    if (badge) badge.style.display = 'flex';
  } else {
    dot.classList.remove('active');
    label.textContent = 'No API Key';
    if (banner) banner.style.display = 'flex';
    if (badge) badge.style.display = 'none';
  }
}

// ── CLEAR ALL ────────────────────────────────────────────────────
async function clearAllLogs() {
  if (!confirm('Delete ALL logs from the store? This cannot be undone.')) return;
  try {
    const r = await apiFetch('/api/logs', { method: 'DELETE' });
    toast(`Deleted ${r.deleted} logs`, 'success');
    $('pill-count').textContent = '0';
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'explorer') loadExplorer(true);
    if (state.view === 'analytics') loadAnalytics();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── DRAG & DROP ──────────────────────────────────────────────────
function initDragDrop() {
  const zone = $('drop-zone');
  const fileInput = $('file-input');

  zone.addEventListener('click', () => fileInput.click());

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    $('ingest-textarea').value = e.target.result;
    $('ingest-source').value = file.name.replace(/\.[^.]+$/, '');
    previewLogs(e.target.result);
    toast(`Loaded ${file.name}`, 'info');
  };
  reader.readAsText(file);
}

// ── INIT ─────────────────────────────────────────────────────────
function init() {
  // Nav clicks
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigate(item.dataset.view);
    });
  });

  // Link buttons that trigger view changes
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn && !btn.classList.contains('nav-item')) {
      navigate(btn.dataset.view);
    }
  });

  // Topbar buttons
  $('btn-refresh').addEventListener('click', async () => {
    $('btn-refresh').classList.add('spinning');
    if (state.view === 'dashboard') await loadDashboard();
    if (state.view === 'explorer') await loadExplorer();
    if (state.view === 'analytics') await loadAnalytics();
    $('btn-refresh').classList.remove('spinning');
    toast('Refreshed', 'info', 1500);
  });

  $('btn-clear-all').addEventListener('click', clearAllLogs);

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-close-settings-2').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('settings-modal').addEventListener('click', e => {
    if (e.target === $('settings-modal')) closeSettings();
  });

  // API key toggle
  $('btn-toggle-key').addEventListener('click', () => {
    const inp = $('api-key-input');
    if (inp.type === 'password') { inp.type = 'text'; $('btn-toggle-key').textContent = 'Hide'; }
    else { inp.type = 'password'; $('btn-toggle-key').textContent = 'Show'; }
  });

  $('btn-set-key').addEventListener('click', openSettings);

  // Explorer filters
  $('btn-apply-filter').addEventListener('click', () => {
    state.explorer.filters = {
      source: $('filter-source').value,
      level:  $('filter-level').value,
      search: $('filter-search').value,
      start:  $('filter-start').value,
      end:    $('filter-end').value,
    };
    loadExplorer(true);
  });

  $('btn-reset-filter').addEventListener('click', () => {
    $('filter-source').value = '';
    $('filter-level').value = '';
    $('filter-search').value = '';
    $('filter-start').value = '';
    $('filter-end').value = '';
    state.explorer.filters = {};
    loadExplorer(true);
  });

  $('filter-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-apply-filter').click();
  });

  // Pagination
  $('btn-prev').addEventListener('click', () => {
    state.explorer.offset = Math.max(0, state.explorer.offset - PAGE_SIZE);
    loadExplorer();
  });

  $('btn-next').addEventListener('click', () => {
    state.explorer.offset += PAGE_SIZE;
    loadExplorer();
  });

  // Drawer close
  $('btn-close-drawer').addEventListener('click', () => $('log-drawer').classList.remove('open'));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('log-drawer').classList.remove('open');
  });

  // Ingest
  initDragDrop();

  $('ingest-textarea').addEventListener('input', debounce(() => {
    previewLogs($('ingest-textarea').value);
  }, 300));

  $('btn-ingest').addEventListener('click', doIngest);

  $('btn-ingest-sample').addEventListener('click', () => {
    $('ingest-textarea').value = SAMPLE_LOGS;
    $('ingest-source').value = 'demo';
    previewLogs(SAMPLE_LOGS);
    toast('Sample logs loaded!', 'info');
  });

  // Chat
  const chatInput = $('chat-input');
  chatInput.addEventListener('input', () => autoResizeTextarea(chatInput));
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(chatInput.value);
    }
  });

  $('btn-send').addEventListener('click', () => sendChat(chatInput.value));

  // Quick prompts (initial render)
  $$('.quick-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => sendChat(btn.dataset.prompt));
  });

  // Update API key status
  updateApiKeyStatus();

  // Load initial view
  navigate('dashboard');

  // Redraw charts on resize
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === 'dashboard' && state.analyzeData) {
        drawTimeline('chart-timeline', state.analyzeData.timeline || [], 'chart-timeline-empty');
        drawDonut('chart-donut', state.analyzeData.byLevel || {}, 'donut-legend');
      }
      if (state.view === 'analytics' && state.analyzeData) {
        renderAnalytics(state.analyzeData);
      }
    }, 150);
  });
}

document.addEventListener('DOMContentLoaded', init);
