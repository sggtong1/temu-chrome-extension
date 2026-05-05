// ISOLATED world — DOM access + chrome.runtime messaging + CustomEvent bridge

// ── Message bridge ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTIVATE_CAPTURE') {
    window.dispatchEvent(new CustomEvent('temu:setConfig', {
      detail: { activeModule: msg.module, targetDate: msg.targetDate, siteType: msg.siteType },
    }));
    sendResponse({ ok: true });
  }
  if (msg.type === 'DEACTIVATE_CAPTURE') {
    window.dispatchEvent(new CustomEvent('temu:setConfig', {
      detail: { activeModule: null, targetDate: null, siteType: null },
    }));
    sendResponse({ ok: true });
  }
  if (msg.type === 'UPDATE_PANEL_STATUS') {
    updatePanelStatus(msg);
    sendResponse({ ok: true });
  }
  if (msg.type === 'TOGGLE_PANEL') {
    togglePanel();
  }
  return false;
});

window.addEventListener('temu:apiCapture', (e) => {
  chrome.runtime.sendMessage({
    type: 'API_DATA',
    module: e.detail.module,
    subType: e.detail.subType ?? null,
    url: e.detail.url,
    data: e.detail.data,
  });
});

window.addEventListener('temu:userInfo', (e) => {
  chrome.runtime.sendMessage({ type: 'USER_INFO', data: e.detail });
  // Also populate mall selector directly from the event
  const malls = e.detail?.result?.mallList ?? [];
  populateMallSelect(malls);
});

// ── Shadow DOM panel ─────────────────────────────────────────────────────────

const host = document.createElement('div');
host.id = 'temu-panel-host';
host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:system-ui;user-select:none;';
document.body.appendChild(host);

const shadow = host.attachShadow({ mode: 'closed' });

shadow.innerHTML = `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :host { font-family: system-ui; font-size: 12px; }
  .bar {
    background: #1e40af; color: white;
    padding: 6px 10px; border-radius: 6px;
    box-shadow: 0 4px 12px rgba(30,64,175,.35);
    display: flex; align-items: center; gap: 8px;
    cursor: grab; white-space: nowrap;
  }
  .bar.dragging { cursor: grabbing; }
  .bar-label { font-weight: 600; }
  .bar-sub { opacity: .65; font-size: 10px; }
  .bar-btn { margin-left: 4px; background: rgba(255,255,255,.2); border-radius: 3px; padding: 1px 5px; font-size: 11px; cursor: pointer; }
  .panel {
    width: 340px;
    box-shadow: 0 4px 20px rgba(0,0,0,.15);
    border-radius: 8px; overflow: hidden;
  }
  .header {
    background: #1e40af; color: white;
    padding: 8px 12px; cursor: grab;
    display: flex; justify-content: space-between; align-items: center;
  }
  .header.dragging { cursor: grabbing; }
  .header-title { font-weight: 600; font-size: 13px; pointer-events: none; }
  .header-btn {
    background: rgba(255,255,255,.2); border: none; color: white;
    border-radius: 4px; width: 22px; height: 22px;
    cursor: pointer; font-size: 15px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    pointer-events: all;
  }
  .body { background: white; }
  .two-col { display: flex; border-bottom: 1px solid #e2e8f0; }
  .col { flex: 1; padding: 12px; }
  .col:first-child { border-right: 1px solid #e2e8f0; }
  .col-label { font-size: 10px; font-weight: 700; color: #64748b; letter-spacing: .05em; margin-bottom: 8px; }
  .modules { display: flex; flex-direction: column; gap: 6px; }
  .modules label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .param-row { margin-bottom: 8px; }
  .param-row:last-child { margin-bottom: 0; }
  .param-label { font-size: 10px; color: #94a3b8; margin-bottom: 3px; }
  select, input[type=date] {
    width: 100%; font-size: 11px; padding: 4px;
    border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc;
  }
  .footer { padding: 10px 12px; }
  .start-btn {
    width: 100%; background: #1e40af; color: white; border: none;
    padding: 8px; border-radius: 5px; font-size: 13px;
    font-weight: 600; cursor: pointer; letter-spacing: .03em;
  }
  .start-btn:disabled { background: #94a3b8; cursor: default; }
  .progress { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .prog-date { font-size: 10px; color: #64748b; margin-bottom: 2px; }
  .prog-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; }
  .prog-icon { width: 18px; text-align: center; }
</style>

<div class="bar" id="bar" style="display:none">
  <span>🛒</span>
  <span class="bar-label">Temu 采集</span>
  <span class="bar-sub" id="bar-sub">· 就绪</span>
  <span class="bar-btn" id="bar-expand">＋</span>
</div>

<div class="panel" id="panel">
  <div class="header" id="drag-header">
    <span class="header-title">🛒 Temu 数据采集</span>
    <button class="header-btn" id="collapse-btn" title="最小化">−</button>
  </div>
  <div class="body">
    <div class="two-col">
      <div class="col">
        <div class="col-label">采集模块</div>
        <div class="modules">
          <label><input type="checkbox" name="mod" value="list" checked> LIST</label>
          <label><input type="checkbox" name="mod" value="sales"> SALES</label>
          <label><input type="checkbox" name="mod" value="orders" checked> ORDERS</label>
          <label><input type="checkbox" name="mod" value="promo" checked> PROMO</label>
        </div>
      </div>
      <div class="col">
        <div class="col-label">采集参数</div>
        <div class="param-row">
          <div class="param-label">区域</div>
          <select id="region">
            <option value="us">🇺🇸 US</option>
            <option value="eu">🌍 EU</option>
            <option value="default">🌐 Default</option>
          </select>
        </div>
        <div class="param-row">
          <div class="param-label">开始日期</div>
          <input type="date" id="date-start">
        </div>
        <div class="param-row">
          <div class="param-label">结束日期</div>
          <input type="date" id="date-end">
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="param-row">
        <div class="param-label">店铺</div>
        <select id="mall-select" disabled>
          <option value="">⏳ 等待页面加载...</option>
        </select>
      </div>
      <button class="start-btn" id="start-btn" style="margin-top:8px" disabled>▶ 开始采集</button>
      <div class="progress" id="progress" style="display:none"></div>
    </div>
  </div>
</div>
`;

// ── Date defaults ────────────────────────────────────────────────────────────

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
const yest = yesterday();
shadow.getElementById('date-start').value = yest;
shadow.getElementById('date-end').value = yest;

// ── Collapse / expand ────────────────────────────────────────────────────────

const bar = shadow.getElementById('bar');
const panel = shadow.getElementById('panel');

function togglePanel() {
  if (panel.style.display === 'none') {
    bar.style.display = 'none';
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
    bar.style.display = 'flex';
  }
}

shadow.getElementById('collapse-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  panel.style.display = 'none';
  bar.style.display = 'flex';
});

shadow.getElementById('bar-expand').addEventListener('click', (e) => {
  e.stopPropagation();
  bar.style.display = 'none';
  panel.style.display = 'block';
});

// ── Dragging ─────────────────────────────────────────────────────────────────

let _dragging = false;
let _dragOffX = 0, _dragOffY = 0;
let _movedPx = 0;

function startDrag(e) {
  if (e.button !== 0) return;
  const rect = host.getBoundingClientRect();
  // Convert bottom/right anchor to top/left so we can drag freely
  host.style.bottom = 'auto';
  host.style.right = 'auto';
  host.style.top = rect.top + 'px';
  host.style.left = rect.left + 'px';

  _dragging = true;
  _movedPx = 0;
  _dragOffX = e.clientX - rect.left;
  _dragOffY = e.clientY - rect.top;

  e.currentTarget.classList.add('dragging');
  document.addEventListener('mousemove', onDrag, { capture: true });
  document.addEventListener('mouseup', stopDrag, { capture: true, once: true });
  e.preventDefault();
}

function onDrag(e) {
  if (!_dragging) return;
  _movedPx += Math.abs(e.movementX) + Math.abs(e.movementY);
  const x = Math.max(0, Math.min(e.clientX - _dragOffX, window.innerWidth - host.offsetWidth));
  const y = Math.max(0, Math.min(e.clientY - _dragOffY, window.innerHeight - host.offsetHeight));
  host.style.left = x + 'px';
  host.style.top = y + 'px';
}

function stopDrag(e) {
  _dragging = false;
  shadow.getElementById('drag-header').classList.remove('dragging');
  shadow.getElementById('bar').classList.remove('dragging');
  document.removeEventListener('mousemove', onDrag, { capture: true });
  // Save position
  const rect = host.getBoundingClientRect();
  chrome.storage.local.set({ panelPos: { top: rect.top, left: rect.left } });
}

shadow.getElementById('drag-header').addEventListener('mousedown', startDrag);
shadow.getElementById('bar').addEventListener('mousedown', (e) => {
  // Only start drag on the bar itself, not the expand button
  if (e.target.id === 'bar-expand') return;
  startDrag(e);
});

// Restore saved position
chrome.storage.local.get('panelPos', ({ panelPos }) => {
  if (panelPos) {
    host.style.bottom = 'auto';
    host.style.right = 'auto';
    host.style.top = Math.min(panelPos.top, window.innerHeight - 60) + 'px';
    host.style.left = Math.min(panelPos.left, window.innerWidth - 60) + 'px';
  }
});

// ── Mall selector ────────────────────────────────────────────────────────────

let _currentMallId = null;

function populateMallSelect(malls) {
  if (!malls.length) return;
  const select = shadow.getElementById('mall-select');
  const prevVal = select.value || _currentMallId;

  select.innerHTML = malls.map(m =>
    `<option value="${m.mallId}">${m.mallName} · ${m.managedType === 0 ? '全托' : '半托'}</option>`
  ).join('');
  select.disabled = false;

  // Prefer: URL mallId → previously selected → first
  const urlMallId = detectMallIdFromUrl();
  const preferred = urlMallId || prevVal || String(malls[0].mallId);
  const opt = [...select.options].find(o => o.value === String(preferred));
  if (opt) opt.selected = true;

  _currentMallId = select.value;
  shadow.getElementById('start-btn').disabled = false;
}

shadow.getElementById('mall-select').addEventListener('change', (e) => {
  _currentMallId = e.target.value;
});

function detectMallIdFromUrl() {
  const params = new URL(window.location.href).searchParams;
  return params.get('mallId') || params.get('mall_id') || null;
}

// Try URL first (fast path before userInfo arrives)
const urlMallId = detectMallIdFromUrl();
if (urlMallId) {
  const select = shadow.getElementById('mall-select');
  select.innerHTML = `<option value="${urlMallId}">${urlMallId}</option>`;
  select.disabled = false;
  _currentMallId = urlMallId;
  shadow.getElementById('start-btn').disabled = false;
  // Enrich with name once background has shop info
  chrome.runtime.sendMessage({ type: 'GET_SHOP_INFO', mallId: urlMallId }, (shop) => {
    if (shop) {
      const label = `${shop.shop_name} · ${shop.site_type === 'semi_us' ? '半托' : '全托'}`;
      shadow.getElementById('mall-select').options[0].text = label;
    }
  });
}

// ── Start collection ─────────────────────────────────────────────────────────

shadow.getElementById('start-btn').addEventListener('click', () => {
  const modules = [...shadow.querySelectorAll('input[name=mod]:checked')].map(el => el.value);
  const region = shadow.getElementById('region').value;
  const startDate = shadow.getElementById('date-start').value;
  const endDate = shadow.getElementById('date-end').value;
  const mallId = shadow.getElementById('mall-select').value;

  if (!modules.length || !mallId || !startDate) return;

  shadow.getElementById('start-btn').style.display = 'none';
  const progressEl = shadow.getElementById('progress');
  progressEl.style.display = 'flex';
  renderProgress(modules, startDate, 1, dateRangeLength(startDate, endDate));

  chrome.runtime.sendMessage({ type: 'START_COLLECTION', modules, region, startDate, endDate, mallId });
});

function dateRangeLength(start, end) {
  const a = new Date(start), b = new Date(end ?? start);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function renderProgress(modules, date, dateIdx, totalDates) {
  const progressEl = shadow.getElementById('progress');
  const dateLabel = totalDates > 1 ? `<div class="prog-date">日期 ${dateIdx}/${totalDates}：${date}</div>` : '';
  progressEl.innerHTML = dateLabel + modules.map(m =>
    `<div class="prog-row"><span>${m.toUpperCase()}</span><span class="prog-icon" id="prog-${m}">—</span></div>`
  ).join('');
}

// ── Status updates from background ──────────────────────────────────────────

function updatePanelStatus(msg) {
  if (msg.status === 'next-date') {
    // Reset progress rows for the new date
    const modules = [...shadow.querySelectorAll('input[name=mod]:checked')].map(el => el.value);
    renderProgress(modules, msg.date, msg.dateIndex + 1, msg.totalDates);
    shadow.getElementById('bar-sub').textContent = `· 采集中 ${msg.dateIndex + 1}/${msg.totalDates}`;
    return;
  }
  if (msg.status === 'complete') {
    shadow.getElementById('start-btn').style.display = '';
    shadow.getElementById('start-btn').disabled = false;
    shadow.getElementById('progress').style.display = 'none';
    shadow.getElementById('bar-sub').textContent = '· 完成';
    return;
  }
  const icon = { done: '✅', error: '❌', processing: '⏳' }[msg.status] ?? '—';
  const el = shadow.getElementById(`prog-${msg.module}`);
  if (el) el.textContent = icon;
  shadow.getElementById('bar-sub').textContent = `· 采集中`;
}
