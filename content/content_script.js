// ISOLATED world — DOM access + chrome.runtime messaging + CustomEvent bridge

// ── Constants ────────────────────────────────────────────────────────────────

const MODULE_LABELS = {
  list:   '流量分析',
  sales:  '销售管理',
  orders: '订单管理',
  promo:  '广告报表',
};

// ── Message bridge ───────────────────────────────────────────────────────────

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
  populateMallSelect(e.detail?.result?.mallList ?? []);
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
  .bar-label { font-weight: 600; }
  .bar-sub { opacity: .65; font-size: 10px; }
  .bar-btn { margin-left: 4px; background: rgba(255,255,255,.2); border-radius: 3px; padding: 1px 5px; font-size: 11px; cursor: pointer; }

  .panel { width: 340px; box-shadow: 0 4px 20px rgba(0,0,0,.15); border-radius: 8px; overflow: hidden; }

  .header {
    background: #1e40af; color: white; padding: 8px 12px; cursor: grab;
    display: flex; justify-content: space-between; align-items: center;
  }
  .header-title { font-weight: 600; font-size: 13px; pointer-events: none; }
  .header-btn {
    background: rgba(255,255,255,.2); border: none; color: white;
    border-radius: 4px; width: 22px; height: 22px; cursor: pointer;
    font-size: 15px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
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
    font-weight: 600; cursor: pointer; letter-spacing: .03em; margin-top: 8px;
  }
  .start-btn:disabled { background: #94a3b8; cursor: default; }

  /* Error / info banner */
  .banner {
    border-radius: 4px; padding: 6px 8px; margin-top: 8px;
    font-size: 11px; display: none; align-items: flex-start; gap: 6px;
  }
  .banner.error { background: #fef2f2; color: #b91c1c; display: flex; }
  .banner.info  { background: #eff6ff; color: #1e40af; display: flex; }

  /* Progress */
  .progress-wrap { margin-top: 8px; display: none; flex-direction: column; gap: 0; }
  .progress-date {
    font-size: 10px; color: #64748b; font-weight: 600;
    padding: 4px 0 4px; border-bottom: 1px solid #f1f5f9; margin-bottom: 4px;
  }
  .prog-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px; border-radius: 4px; margin-bottom: 2px;
    background: #f8fafc;
  }
  .prog-name { font-size: 11px; color: #374151; }
  .prog-badge {
    font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600;
  }
  .badge-wait    { background: #f1f5f9; color: #94a3b8; }
  .badge-running { background: #dbeafe; color: #1e40af; }
  .badge-done    { background: #dcfce7; color: #15803d; }
  .badge-error   { background: #fee2e2; color: #b91c1c; }
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
          <label><input type="checkbox" name="mod" value="list" checked> 流量分析</label>
          <label><input type="checkbox" name="mod" value="sales"> 销售管理</label>
          <label><input type="checkbox" name="mod" value="orders" checked> 订单管理</label>
          <label><input type="checkbox" name="mod" value="promo" checked> 广告报表</label>
        </div>
      </div>
      <div class="col">
        <div class="col-label">采集参数</div>
        <div class="param-row">
          <div class="param-label">区域</div>
          <select id="region">
            <option value="us">🇺🇸 美国</option>
            <option value="eu">🌍 欧洲</option>
            <option value="default">🌐 全球</option>
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
      <div class="banner" id="banner"><span id="banner-text"></span></div>
      <button class="start-btn" id="start-btn" disabled>▶ 开始采集</button>
      <div class="progress-wrap" id="progress-wrap"></div>
    </div>
  </div>
</div>
`;

// ── Date defaults ─────────────────────────────────────────────────────────────

function yesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
const yest = yesterday();
shadow.getElementById('date-start').value = yest;
shadow.getElementById('date-end').value = yest;

// ── Collapse / expand ─────────────────────────────────────────────────────────

const bar   = shadow.getElementById('bar');
const panel = shadow.getElementById('panel');

function togglePanel() {
  if (panel.style.display === 'none') {
    bar.style.display = 'none'; panel.style.display = 'block';
  } else {
    panel.style.display = 'none'; bar.style.display = 'flex';
  }
}

shadow.getElementById('collapse-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  panel.style.display = 'none'; bar.style.display = 'flex';
});
shadow.getElementById('bar-expand').addEventListener('click', (e) => {
  e.stopPropagation();
  bar.style.display = 'none'; panel.style.display = 'block';
});

// ── Dragging ──────────────────────────────────────────────────────────────────

let _dragging = false, _dragOffX = 0, _dragOffY = 0;

function startDrag(e) {
  if (e.button !== 0) return;
  const rect = host.getBoundingClientRect();
  host.style.bottom = 'auto'; host.style.right = 'auto';
  host.style.top  = rect.top  + 'px';
  host.style.left = rect.left + 'px';
  _dragging = true;
  _dragOffX = e.clientX - rect.left;
  _dragOffY = e.clientY - rect.top;
  document.addEventListener('mousemove', onDrag, { capture: true });
  document.addEventListener('mouseup',   stopDrag, { capture: true, once: true });
  e.preventDefault();
}
function onDrag(e) {
  if (!_dragging) return;
  host.style.left = Math.max(0, Math.min(e.clientX - _dragOffX, window.innerWidth  - host.offsetWidth))  + 'px';
  host.style.top  = Math.max(0, Math.min(e.clientY - _dragOffY, window.innerHeight - host.offsetHeight)) + 'px';
}
function stopDrag() {
  _dragging = false;
  document.removeEventListener('mousemove', onDrag, { capture: true });
  const rect = host.getBoundingClientRect();
  chrome.storage.local.set({ panelPos: { top: rect.top, left: rect.left } });
}

shadow.getElementById('drag-header').addEventListener('mousedown', startDrag);
shadow.getElementById('bar').addEventListener('mousedown', (e) => {
  if (e.target.id === 'bar-expand') return;
  startDrag(e);
});

chrome.storage.local.get('panelPos', ({ panelPos }) => {
  if (!panelPos) return;
  host.style.bottom = 'auto'; host.style.right = 'auto';
  host.style.top  = Math.min(panelPos.top,  window.innerHeight - 60) + 'px';
  host.style.left = Math.min(panelPos.left, window.innerWidth  - 60) + 'px';
});

// ── Banner (error / info) ─────────────────────────────────────────────────────

function showBanner(text, type = 'error') {
  const el = shadow.getElementById('banner');
  shadow.getElementById('banner-text').textContent = text;
  el.className = `banner ${type}`;
}
function hideBanner() {
  shadow.getElementById('banner').className = 'banner';
}

// ── Mall selector ─────────────────────────────────────────────────────────────

let _currentMallId = null;

function populateMallSelect(malls) {
  if (!malls.length) return;
  const select = shadow.getElementById('mall-select');
  const prevVal = select.value || _currentMallId;

  select.innerHTML = malls.map(m =>
    `<option value="${m.mallId}">${m.mallName} · ${m.managedType === 0 ? '全托' : '半托'} · ID:${m.mallId}</option>`
  ).join('');
  select.disabled = false;

  const urlId = detectMallIdFromUrl();
  const preferred = urlId || prevVal || String(malls[0].mallId);
  const opt = [...select.options].find(o => o.value === String(preferred));
  if (opt) opt.selected = true;

  _currentMallId = select.value;
  shadow.getElementById('start-btn').disabled = false;
  hideBanner();
}

shadow.getElementById('mall-select').addEventListener('change', (e) => {
  _currentMallId = e.target.value;
});

function detectMallIdFromUrl() {
  const p = new URL(window.location.href).searchParams;
  return p.get('mallId') || p.get('mall_id') || null;
}

// Fast path from URL before userInfo arrives
const urlMallId = detectMallIdFromUrl();
if (urlMallId) {
  const select = shadow.getElementById('mall-select');
  select.innerHTML = `<option value="${urlMallId}">ID:${urlMallId}</option>`;
  select.disabled = false;
  _currentMallId = urlMallId;
  shadow.getElementById('start-btn').disabled = false;
  chrome.runtime.sendMessage({ type: 'GET_SHOP_INFO', mallId: urlMallId }, (shop) => {
    if (shop) {
      const typeLabel = shop.site_type === 'semi_us' ? '半托' : '全托';
      select.options[0].text = `${shop.shop_name} · ${typeLabel} · ID:${urlMallId}`;
    }
  });
}

// ── Progress rendering ────────────────────────────────────────────────────────

let _activeModules = [];

function renderProgress(modules, date, dateIdx, totalDates) {
  _activeModules = modules;
  const wrap = shadow.getElementById('progress-wrap');
  const dateLabel = totalDates > 1
    ? `<div class="progress-date">日期 ${dateIdx}/${totalDates}：${date}</div>`
    : `<div class="progress-date">采集日期：${date}</div>`;
  wrap.innerHTML = dateLabel + modules.map(m =>
    `<div class="prog-row" id="prog-row-${m}">
       <span class="prog-name">${MODULE_LABELS[m] ?? m}</span>
       <span class="prog-badge badge-wait" id="prog-${m}">等待</span>
     </div>`
  ).join('');
  wrap.style.display = 'flex';
}

function setProgBadge(module, status) {
  const badge = shadow.getElementById(`prog-${module}`);
  if (!badge) return;
  const map = {
    processing: ['badge-running', '采集中'],
    done:       ['badge-done',    '✓ 完成'],
    error:      ['badge-error',   '✗ 失败'],
  };
  const [cls, label] = map[status] ?? ['badge-wait', '等待'];
  badge.className = `prog-badge ${cls}`;
  badge.textContent = label;
}

// ── Start collection ──────────────────────────────────────────────────────────

shadow.getElementById('start-btn').addEventListener('click', () => {
  hideBanner();
  const modules   = [...shadow.querySelectorAll('input[name=mod]:checked')].map(el => el.value);
  const region    = shadow.getElementById('region').value;
  const startDate = shadow.getElementById('date-start').value;
  const endDate   = shadow.getElementById('date-end').value;
  const mallId    = shadow.getElementById('mall-select').value;

  if (!modules.length) { showBanner('请至少勾选一个采集模块'); return; }
  if (!mallId)         { showBanner('请先选择店铺'); return; }
  if (!startDate)      { showBanner('请选择采集日期'); return; }

  const totalDates = dateRangeLength(startDate, endDate);
  shadow.getElementById('start-btn').style.display = 'none';
  renderProgress(modules, startDate, 1, totalDates);
  shadow.getElementById('bar-sub').textContent = '· 采集中';

  chrome.runtime.sendMessage({ type: 'START_COLLECTION', modules, region, startDate, endDate, mallId });
});

function dateRangeLength(start, end) {
  const a = new Date(start), b = new Date(end ?? start);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// ── Status updates ────────────────────────────────────────────────────────────

function updatePanelStatus(msg) {
  if (msg.status === 'error-no-supabase') {
    showBanner('未配置 Supabase，请前往插件选项页填写 URL 和 Anon Key');
    shadow.getElementById('start-btn').style.display = '';
    shadow.getElementById('start-btn').disabled = false;
    shadow.getElementById('progress-wrap').style.display = 'none';
    shadow.getElementById('bar-sub').textContent = '· 就绪';
    return;
  }
  if (msg.status === 'next-date') {
    renderProgress(_activeModules, msg.date, msg.dateIndex + 1, msg.totalDates);
    shadow.getElementById('bar-sub').textContent = `· 采集中 ${msg.dateIndex + 1}/${msg.totalDates}`;
    return;
  }
  if (msg.status === 'complete') {
    shadow.getElementById('start-btn').style.display = '';
    shadow.getElementById('start-btn').disabled = false;
    shadow.getElementById('bar-sub').textContent = '· 完成 ✓';
    showBanner('采集完成', 'info');
    return;
  }
  setProgBadge(msg.module, msg.status);
  if (msg.status === 'processing') {
    shadow.getElementById('bar-sub').textContent = `· 采集中`;
  }
}
