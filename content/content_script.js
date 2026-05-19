// ISOLATED world — DOM access + chrome.runtime messaging + CustomEvent bridge

// ── Constants ────────────────────────────────────────────────────────────────

const MODULE_LABELS = {
  list:     '流量分析',
  sales:    '销售管理',
  orders:   '订单管理',
  activity: '营销活动',
  promo:    '广告报表',
};

// ── Message bridge ───────────────────────────────────────────────────────────

function checkPageReady() {
  const title = document.title.toLowerCase();
  const body  = (document.body?.innerText ?? '').slice(0, 1000).toLowerCase();
  if (title.includes('just a moment')) return false;   // Cloudflare challenge
  if (title.includes('error') && !title.includes('seller')) return false;
  if (body.includes('too many visitors')) return false;
  if (body.includes('访问人数过多'))       return false;
  if (body.includes('enable javascript and cookies')) return false;
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTIVATE_CAPTURE') {
    window.dispatchEvent(new CustomEvent('temu:setConfig', {
      detail: { activeModule: msg.module, targetDate: msg.targetDate, siteType: msg.siteType },
    }));
    // Check page health after 2s and report back
    const captureModule = msg.module;
    setTimeout(() => {
      if (!checkPageReady()) safeSend({ type: 'PAGE_ERROR', module: captureModule });
    }, 2000);
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

let _contextInvalidated = false;
function reportContextInvalidated() {
  if (_contextInvalidated) return;
  _contextInvalidated = true;
  try {
    showBanner('插件已更新，请刷新页面（F5）后再操作', 'warn');
    const startBtn = shadow.getElementById('start-btn');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⚠ 请刷新页面'; }
  } catch {}
}
function isCtxValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}
function safeChrome(fn) {
  if (!isCtxValid()) { reportContextInvalidated(); return; }
  try { return fn(); }
  catch (e) {
    if (String(e).includes('Extension context invalidated')) reportContextInvalidated();
  }
}
function safeSend(msg) { safeChrome(() => chrome.runtime.sendMessage(msg)); }

window.addEventListener('temu:apiCapture', (e) => {
  safeSend({
    type: 'API_DATA',
    module: e.detail.module,
    subType: e.detail.subType ?? null,
    url: e.detail.url,
    data: e.detail.data,
  });
});

window.addEventListener('temu:paginationProgress', (e) => {
  safeSend({ type: 'PAGINATION_PROGRESS', module: e.detail.module, pageNo: e.detail.pageNo, gotSoFar: e.detail.gotSoFar });
});

window.addEventListener('temu:userInfo', (e) => {
  safeSend({ type: 'USER_INFO', data: e.detail });
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
  :host {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    color: #1f2937;
  }

  /* ─── 收起态：横向 bar ─── */
  .bar {
    background: linear-gradient(135deg, #232c47 0%, #1f2740 100%);
    color: #e3e7f3;
    padding: 7px 10px 7px 8px;
    border-radius: 18px;
    box-shadow: 0 6px 20px rgba(31,39,64,.35);
    display: flex; align-items: center; gap: 6px;
    cursor: grab; white-space: nowrap;
    border: 1px solid rgba(255,255,255,0.06);
  }
  .bar-logo {
    width: 22px; height: 22px;
    border-radius: 5px;
    background: #f0b429;
    color: #1f2740;
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 12px;
    flex-shrink: 0;
  }
  .bar-label { font-weight: 600; color: #fff; font-size: 12px; }
  .bar-sub { color: #9aa3c7; font-size: 11px; }
  .bar-btn {
    margin-left: 2px;
    background: rgba(255,255,255,0.06);
    border-radius: 11px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
    color: #d8def0;
    transition: background .15s;
  }
  .bar-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }

  /* ─── 展开态：panel ─── */
  .panel {
    width: 340px;
    background: #fff;
    box-shadow: 0 12px 32px rgba(0,0,0,0.18);
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #eef0f4;
  }

  .header {
    background: linear-gradient(180deg, #1f2740 0%, #232c47 100%);
    color: #fff;
    padding: 10px 12px;
    cursor: grab;
    display: flex; align-items: center; gap: 8px;
  }
  .header-logo {
    width: 22px; height: 22px;
    border-radius: 5px;
    background: #f0b429;
    color: #1f2740;
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 12px;
    pointer-events: none;
  }
  .header-title { font-weight: 600; font-size: 13px; flex: 1; pointer-events: none; }
  .header-sub { font-size: 10px; color: #9aa3c7; margin-left: auto; pointer-events: none; }
  .header-btn {
    background: rgba(255,255,255,0.1);
    border: 0; color: #d8def0;
    border-radius: 4px; width: 22px; height: 22px;
    cursor: pointer; font-size: 14px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    margin-left: 4px;
  }
  .header-btn:hover { background: rgba(255,255,255,0.2); color: #fff; }

  .body { background: #fff; }

  .section {
    padding: 10px 14px;
    border-bottom: 1px solid #f0f2f5;
  }
  .section:last-of-type { border-bottom: 0; }
  .section-label {
    font-size: 10px; font-weight: 600; color: #6b7280;
    letter-spacing: .04em; margin-bottom: 8px;
    text-transform: uppercase;
  }

  .modules {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }
  .modules label {
    display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer; font-size: 12px; color: #4b5563;
    padding: 2px 0;
  }
  .modules input[type=checkbox] {
    accent-color: #4f64f6;
    width: 13px; height: 13px;
    margin: 0;
  }

  .param-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 10px;
  }
  .param-grid .param-row.full { grid-column: 1 / -1; }
  .param-row { display: flex; flex-direction: column; gap: 3px; }
  .param-label {
    font-size: 11px; color: #6b7280;
  }
  select, input[type=date] {
    width: 100%; font-size: 12px; padding: 5px 6px;
    border: 1px solid #d1d5db; border-radius: 4px; background: #fff;
    color: #1f2937;
    font-family: inherit;
  }
  select:focus, input[type=date]:focus {
    outline: none; border-color: #4f64f6;
  }

  .footer {
    padding: 10px 14px 12px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .start-btn, .export-btn, .clear-btn {
    width: 100%; border: 0;
    padding: 7px; border-radius: 4px; font-size: 12px;
    font-weight: 500; cursor: pointer;
    font-family: inherit;
    transition: opacity .15s;
  }
  .start-btn  { background: #4f64f6; color: #fff; }
  .start-btn:hover { background: #4054e0; }
  .export-btn { background: #fff; color: #15803d; border: 1px solid #bbf7d0; }
  .export-btn:hover { background: #f0fdf4; }
  .clear-btn  { background: #fff; color: #c2410c; border: 1px solid #fed7aa; }
  .clear-btn:hover { background: #fff7ed; }
  .start-btn:disabled,
  .export-btn:disabled,
  .clear-btn:disabled {
    background: #f3f4f6; color: #9ca3af; border-color: #e5e7eb;
    cursor: not-allowed;
  }

  /* Error / info banner */
  .banner {
    border-radius: 4px; padding: 6px 8px;
    font-size: 11px; display: none; align-items: flex-start; gap: 6px;
    line-height: 1.5;
  }
  .banner.error { background: #fef2f2; color: #b91c1c; display: flex; border: 1px solid #fecaca; }
  .banner.info  { background: #eff6ff; color: #1e40af; display: flex; border: 1px solid #bfdbfe; }

  /* Progress */
  .progress-wrap {
    margin-top: 4px;
    display: none;
    flex-direction: column;
    gap: 0;
    max-height: 200px;
    overflow-y: auto;
  }
  .progress-date {
    font-size: 10px; color: #6b7280; font-weight: 500;
    padding: 6px 0 4px; border-bottom: 1px solid #f0f2f5;
    margin-bottom: 4px;
  }
  .prog-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px; border-radius: 4px; margin-bottom: 2px;
    background: #fafbfd;
  }
  .prog-name { font-size: 11px; color: #4b5563; }
  .prog-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 500;
  }
  .badge-wait    { background: #f3f4f6; color: #6b7280; }
  .badge-running { background: #dbeafe; color: #1d4ed8; }
  .badge-done    { background: #dcfce7; color: #15803d; }
  .badge-error   { background: #fee2e2; color: #b91c1c; }
  .badge-retry   { background: #fff7ed; color: #c2410c; }

  /* Cookie health popover */
  .cookie-pop {
    position: absolute;
    top: 50px; right: 12px;
    width: 240px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    z-index: 10;
    overflow: hidden;
    display: none;
  }
  .cookie-pop.open { display: block; }
  .cookie-pop-head {
    padding: 8px 10px;
    background: #fafbfd;
    border-bottom: 1px solid #eef0f4;
    font-size: 11px;
    font-weight: 600;
    color: #1f2937;
  }
  .cookie-pop-body { max-height: 240px; overflow-y: auto; }
  .cookie-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 11px;
    border-bottom: 1px solid #f0f2f5;
  }
  .cookie-row:last-child { border-bottom: 0; }
  .cookie-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .cookie-dot.ok { background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,0.15); }
  .cookie-dot.partial { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245,158,11,0.15); }
  .cookie-dot.off { background: #9ca3af; }
  .cookie-dot.error { background: #ef4444; }
  .cookie-info { flex: 1; min-width: 0; }
  .cookie-name { color: #1f2937; font-weight: 500; }
  .cookie-host { color: #9ca3af; font-size: 9px; }
  .cookie-action {
    color: #4f64f6;
    font-size: 11px;
    cursor: pointer;
    text-decoration: none;
  }
  .cookie-action:hover { text-decoration: underline; }
  .cookie-pop-foot {
    padding: 6px 10px;
    background: #fafbfd;
    border-top: 1px solid #eef0f4;
    text-align: right;
  }
  .cookie-refresh-btn {
    background: none;
    border: 0;
    color: #4f64f6;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
  }
  .cookie-refresh-btn:hover { text-decoration: underline; }
</style>

<div class="bar" id="bar" style="display:flex">
  <span class="bar-logo">舵</span>
  <span class="bar-label">Temu 采集</span>
  <span class="bar-sub" id="bar-sub">· 就绪</span>
  <span class="bar-btn" id="bar-clear" title="一键清除弹窗">🧹</span>
  <span class="bar-btn" id="bar-expand" title="展开面板">＋</span>
</div>

<div class="panel" id="panel" style="display:none">
  <div class="header" id="drag-header">
    <span class="header-logo">舵</span>
    <span class="header-title">Temu 数据采集</span>
    <span class="header-sub" id="cookie-health-sub">在线 ✓</span>
    <button class="header-btn" id="cookie-health-btn" title="查看在线情况">⌖</button>
    <button class="header-btn" id="collapse-btn" title="最小化">−</button>
  </div>
  <div class="body">
    <div class="section">
      <div class="section-label">采集模块</div>
      <div class="modules">
        <label><input type="checkbox" name="mod" value="list" checked> 流量分析</label>
        <label><input type="checkbox" name="mod" value="sales"> 销售管理</label>
        <label><input type="checkbox" name="mod" value="orders" checked> 订单管理</label>
        <label><input type="checkbox" name="mod" value="activity"> 营销活动</label>
        <label><input type="checkbox" name="mod" value="promo" checked> 广告报表</label>
      </div>
    </div>

    <div class="section">
      <div class="section-label">采集参数</div>
      <div class="param-grid">
        <div class="param-row">
          <span class="param-label">区域</span>
          <select id="region">
            <option value="us">🇺🇸 美国</option>
            <option value="eu">🌍 欧洲</option>
            <option value="default">🌐 全球</option>
          </select>
        </div>
        <div class="param-row">
          <span class="param-label">店铺</span>
          <select id="mall-select" disabled>
            <option value="">⏳ 等待页面加载</option>
          </select>
        </div>
        <div class="param-row">
          <span class="param-label">开始日期</span>
          <input type="date" id="date-start">
        </div>
        <div class="param-row">
          <span class="param-label">结束日期</span>
          <input type="date" id="date-end">
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="banner" id="banner"><span id="banner-text"></span></div>
      <button class="start-btn" id="start-btn" disabled>开始采集</button>
      <div style="display:flex;gap:6px">
        <button class="export-btn" id="export-btn" disabled style="flex:1">导出 Excel</button>
        <button class="clear-btn" id="clear-btn" title="隐藏页面上所有弹窗" style="flex:1">清除弹窗</button>
      </div>
      <div class="progress-wrap" id="progress-wrap"></div>
    </div>
  </div>

  <!-- Cookie 健康 popover -->
  <div class="cookie-pop" id="cookie-pop">
    <div class="cookie-pop-head">Temu 后台在线情况</div>
    <div class="cookie-pop-body" id="cookie-pop-body">
      <div style="padding:10px;text-align:center;color:#9ca3af;font-size:11px">检测中…</div>
    </div>
    <div class="cookie-pop-foot">
      <button class="cookie-refresh-btn" id="cookie-refresh-btn">重新检测</button>
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

// ── State persistence ─────────────────────────────────────────────────────────

function saveState() {
  const modules   = [...shadow.querySelectorAll('input[name=mod]:checked')].map(el => el.value);
  const region    = shadow.getElementById('region').value;
  const startDate = shadow.getElementById('date-start').value;
  const endDate   = shadow.getElementById('date-end').value;
  const mallId    = shadow.getElementById('mall-select').value;
  safeChrome(() => chrome.storage.local.set({ panelState: { modules, region, startDate, endDate, mallId } }));
}

safeChrome(() => chrome.storage.local.get('panelState', ({ panelState }) => {
  if (!panelState) return;
  if (panelState.modules) {
    shadow.querySelectorAll('input[name=mod]').forEach(el => {
      el.checked = panelState.modules.includes(el.value);
    });
  }
  if (panelState.region)    shadow.getElementById('region').value = panelState.region;
  if (panelState.startDate) shadow.getElementById('date-start').value = panelState.startDate;
  if (panelState.endDate)   shadow.getElementById('date-end').value = panelState.endDate;
  if (panelState.mallId)    _currentMallId = panelState.mallId;
}));

shadow.querySelectorAll('input[name=mod]').forEach(el => el.addEventListener('change', saveState));
shadow.getElementById('region').addEventListener('change', saveState);
shadow.getElementById('date-start').addEventListener('change', saveState);
shadow.getElementById('date-end').addEventListener('change', saveState);

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
  closeCookiePop();
});
shadow.getElementById('bar-expand').addEventListener('click', (e) => {
  e.stopPropagation();
  bar.style.display = 'none'; panel.style.display = 'block';
});

// ── Cookie 健康检查 ────────────────────────────────────────────────────────────
//   header 上的 ⌖ 按钮 → 询问 background → 渲染到 popover
//   header-sub 同步显示一个"3/4 在线"的总览

const cookiePop = shadow.getElementById('cookie-pop');
const cookieSub = shadow.getElementById('cookie-health-sub');
const cookieBtn = shadow.getElementById('cookie-health-btn');
const cookieRefreshBtn = shadow.getElementById('cookie-refresh-btn');
const STATUS_LABEL = { ok: '在线', partial: '部分', off: '未登录', error: '失败' };

function closeCookiePop() {
  cookiePop.classList.remove('open');
}
function toggleCookiePop() {
  if (cookiePop.classList.contains('open')) closeCookiePop();
  else { cookiePop.classList.add('open'); refreshCookieHealth(); }
}

cookieBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCookiePop(); });
cookieRefreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refreshCookieHealth(); });
// 点 panel 其它地方关闭 popover
panel.addEventListener('click', (e) => {
  if (!cookiePop.contains(e.target) && e.target.id !== 'cookie-health-btn') closeCookiePop();
});

let _cookieTimer = null;
function startCookiePolling() {
  refreshCookieHealth();
  if (_cookieTimer) clearInterval(_cookieTimer);
  _cookieTimer = setInterval(refreshCookieHealth, 30_000);
}

async function refreshCookieHealth() {
  let res = null;
  try {
    res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'AGENT_CHECK_COOKIES' }, (r) => resolve(r));
      setTimeout(() => resolve(null), 2500);
    });
  } catch { /* background 没在线 */ }

  if (!res || !Array.isArray(res.domains)) {
    cookieSub.textContent = '在线 ?';
    cookieSub.style.color = '#9aa3c7';
    shadow.getElementById('cookie-pop-body').innerHTML =
      '<div style="padding:12px;text-align:center;color:#9ca3af;font-size:11px">无法连接 background</div>';
    return;
  }

  // 顶部 sub：例如 "在线 3/4"
  const ok = res.domains.filter((d) => d.status === 'ok').length;
  const total = res.domains.length;
  cookieSub.textContent = `在线 ${ok}/${total}`;
  cookieSub.style.color = ok === total ? '#86efac' : ok > 0 ? '#fde68a' : '#fca5a5';

  // popover 列表
  shadow.getElementById('cookie-pop-body').innerHTML = res.domains.map((d) => {
    const needLogin = d.status !== 'ok';
    const action = needLogin
      ? `<a class="cookie-action" href="${d.url}" target="_blank" rel="noopener">去登录</a>`
      : `<span style="color:#15803d;font-size:11px">${STATUS_LABEL[d.status]}</span>`;
    return `
      <div class="cookie-row">
        <span class="cookie-dot ${d.status}"></span>
        <div class="cookie-info">
          <div class="cookie-name">${d.label}</div>
          <div class="cookie-host">${d.gateway}</div>
        </div>
        ${action}
      </div>
    `;
  }).join('');
}

startCookiePolling();

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
  safeChrome(() => chrome.storage.local.set({ panelPos: { top: rect.top, left: rect.left } }));
}

shadow.getElementById('drag-header').addEventListener('mousedown', startDrag);
shadow.getElementById('bar').addEventListener('mousedown', (e) => {
  if (e.target.id === 'bar-expand' || e.target.id === 'bar-clear') return;
  startDrag(e);
});

safeChrome(() => chrome.storage.local.get('panelPos', ({ panelPos }) => {
  if (!panelPos) return;
  host.style.bottom = 'auto'; host.style.right = 'auto';
  host.style.top  = Math.min(panelPos.top,  window.innerHeight - 60) + 'px';
  host.style.left = Math.min(panelPos.left, window.innerWidth  - 60) + 'px';
}));

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
const _mallTypeCache = {}; // mallId (string) → 'full_managed' | 'semi_us'

// Show/hide modules depending on shop type
// full_managed: list + sales + activity + promo (no orders)
// semi_us:      list + orders + promo (no sales, no activity)
function updateModuleVisibility(siteType) {
  if (!siteType) return;
  const isFull = siteType === 'full_managed';
  setModuleVisible('sales',    isFull);
  setModuleVisible('activity', isFull);
  setModuleVisible('orders',  !isFull);
}

function setModuleVisible(mod, visible) {
  const input = shadow.querySelector(`input[name=mod][value="${mod}"]`);
  if (!input) return;
  const label = input.closest('label');
  if (label) label.style.display = visible ? '' : 'none';
  if (!visible) input.checked = false;
}

function populateMallSelect(malls) {
  if (!malls.length) return;
  const select = shadow.getElementById('mall-select');
  const prevVal = select.value || _currentMallId;

  select.innerHTML = malls.map(m =>
    `<option value="${m.mallId}">${m.mallName} · ${m.managedType === 0 ? '全托' : '半托'} · ID:${m.mallId}</option>`
  ).join('');
  select.disabled = false;

  // Build local type cache from the full mall list
  for (const m of malls) {
    _mallTypeCache[String(m.mallId)] = m.managedType === 0 ? 'full_managed' : 'semi_us';
  }

  const urlId = detectMallIdFromUrl();
  const preferred = urlId || prevVal || String(malls[0].mallId);
  const opt = [...select.options].find(o => o.value === String(preferred));
  if (opt) opt.selected = true;

  _currentMallId = select.value;
  updateModuleVisibility(_mallTypeCache[_currentMallId]);
  shadow.getElementById('start-btn').disabled = false;
  shadow.getElementById('export-btn').disabled = false;
  hideBanner();
}

shadow.getElementById('mall-select').addEventListener('change', (e) => {
  _currentMallId = e.target.value;
  updateModuleVisibility(_mallTypeCache[_currentMallId]);
  saveState();
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
  shadow.getElementById('export-btn').disabled = false;
  safeChrome(() => chrome.runtime.sendMessage({ type: 'GET_SHOP_INFO', mallId: urlMallId }, (shop) => {
    if (shop) {
      const typeLabel = shop.site_type === 'semi_us' ? '半托' : '全托';
      select.options[0].text = `${shop.shop_name} · ${typeLabel} · ID:${urlMallId}`;
    }
  }));
}

// ── Progress rendering ────────────────────────────────────────────────────────

let _activeModules = [];

// Modules that capture the entire date range in one shot (no per-date iteration)
function isRangeOnlyMode(modules, siteType) {
  return modules.length > 0 && modules.every(m =>
    m === 'activity' || (m === 'sales' && siteType === 'full_managed')
  );
}

function renderProgress(modules, dateLabelText) {
  _activeModules = modules;
  const wrap = shadow.getElementById('progress-wrap');
  wrap.innerHTML = `<div class="progress-date">${dateLabelText}</div>` + modules.map(m =>
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
    retrying:   ['badge-retry',   '↻ 重试'],
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

  if (!isCtxValid()) { reportContextInvalidated(); return; }
  const totalDates = dateRangeLength(startDate, endDate);
  shadow.getElementById('start-btn').style.display = 'none';
  const siteType = _mallTypeCache[String(mallId)] || null;
  const effectiveEnd = endDate || startDate;
  safeSend({ type: 'START_COLLECTION', modules, region, startDate, endDate, mallId, siteType });
  // Date label depends on collection mode: range-only modules don't iterate
  // dates, so show start~end. Per-date modules show 日期 N/M.
  let dateLabel;
  if (isRangeOnlyMode(modules, siteType)) {
    dateLabel = startDate === effectiveEnd
      ? `采集日期：${startDate}`
      : `采集范围：${startDate} ~ ${effectiveEnd}`;
  } else {
    dateLabel = totalDates > 1 ? `日期 1/${totalDates}：${startDate}` : `采集日期：${startDate}`;
  }
  renderProgress(modules, dateLabel);
  shadow.getElementById('bar-sub').textContent = '· 采集中';
});

function dateRangeLength(start, end) {
  const a = new Date(start), b = new Date(end ?? start);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// ── Export Excel ──────────────────────────────────────────────────────────────

// Template A: 14 core PnL columns
const EXPORT_TEMPLATE_A = [
  { src: '日期',          name: '日期' },
  { src: 'sku_id',        name: 'SKU ID' },
  { src: 'ext_code',      name: '货号' },
  { src: 'sku规格',       name: '规格' },
  { src: '活动价格',      name: '活动售价' },
  { src: '销售件数',      name: '销售件数' },
  { src: '销售额',        name: '销售额' },
  { src: '成本价',        name: '成本价' },
  { src: '销售成本',      name: '销售成本' },
  { src: '毛利润',        name: '毛利润' },
  { src: '毛利率',        name: '毛利率' },
  { src: '广告花费分摊',  name: '广告花费' },
  { src: '净利润',        name: '净利润' },
  { src: '净利率',        name: '净利率' },
];

shadow.getElementById('export-btn').addEventListener('click', () => {
  hideBanner();
  if (typeof XLSX === 'undefined') { showBanner('XLSX 库未加载，请重载插件'); return; }
  const startDate = shadow.getElementById('date-start').value;
  const endDate   = shadow.getElementById('date-end').value || startDate;
  const mallId    = shadow.getElementById('mall-select').value;

  if (!startDate) { showBanner('请选择开始日期'); return; }
  if (!mallId)    { showBanner('请先选择店铺'); return; }
  if (!isCtxValid()) { reportContextInvalidated(); return; }

  // Shop name from select option text: "THE TELOS PRODUCT · 全托 · ID:..."
  const select = shadow.getElementById('mall-select');
  const optionText = select.options[select.selectedIndex].text;
  const shopName = optionText.split(' · ')[0];

  exportExcel(startDate, endDate, shopName);
});

function exportExcel(startDate, endDate, shopName) {
  const exportBtn = shadow.getElementById('export-btn');
  const originalLabel = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = '⏳ 拉取数据...';

  safeChrome(() => chrome.runtime.sendMessage(
    { type: 'EXPORT_REPORT', startDate, endDate, shopName },
    (resp) => {
      exportBtn.disabled = false;
      exportBtn.textContent = originalLabel;

      if (!resp) { showBanner('导出失败：服务未响应'); return; }
      if (resp.error === 'no-api') {
        showBanner('未配置 API URL，请前往选项页设置 (默认 http://localhost:3003)');
        return;
      }
      if (resp.error) { showBanner(`导出失败: ${resp.error}`); return; }

      const rows = resp.rows ?? [];
      if (rows.length === 0) {
        showBanner(`${startDate} ~ ${endDate} 范围内无数据`, 'warn');
        return;
      }

      // Map view rows → template A columns with friendly names
      const mapped = rows.map(r => {
        const out = {};
        for (const col of EXPORT_TEMPLATE_A) {
          let v = r[col.src];
          // numeric strings (Postgres numeric type) → numbers for Excel
          if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
          out[col.name] = v ?? null;
        }
        return out;
      });

      try {
        const ws = XLSX.utils.json_to_sheet(mapped);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '销售PnL');
        const safeName = shopName.replace(/[\\/:*?"<>|]/g, '_');
        const fname = startDate === endDate
          ? `${safeName}_${startDate}.xlsx`
          : `${safeName}_${startDate}_to_${endDate}.xlsx`;
        XLSX.writeFile(wb, fname);
        showBanner(`✓ 已导出 ${rows.length} 行 → ${fname}`, 'info');
      } catch (e) {
        console.error('[temu] export xlsx failed:', e);
        showBanner(`导出失败: ${e?.message || e}`);
      }
    }
  ));
}

// ── Clear popups / overlays ───────────────────────────────────────────────────

// Heuristic three-layer cleaner: known modal selectors → covering high-z fixed
// elements → unlock body/html scroll. Excludes our own panel container.
const POPUP_SELECTORS = [
  '.modal', '.modal-mask', '.modal-wrap', '.modal-backdrop',
  '.dialog', '.popup', '.popover', '.overlay', '.mask', '.backdrop',
  '.ant-modal', '.ant-modal-mask', '.ant-modal-wrap', '.ant-modal-root',
  '.ant-drawer', '.ant-drawer-mask', '.ant-popover', '.ant-message',
  '.ant-notification', '.ant-tooltip',
  '[role="dialog"]', '[role="alertdialog"]',
  '[class*="Modal_"]', '[class*="Dialog_"]', '[class*="Popup_"]',
  '[class*="Overlay_"]', '[class*="Mask_"]', '[class*="Drawer_"]',
  '[class*="popup"]', '[class*="dialog"]', '[class*="overlay"]',
  '[class*="-mask"]', '[class*="_mask"]',
];

function isOurPanel(el) {
  return el === host || host.contains(el) || el.contains(host);
}

function hideEl(el) {
  if (el.dataset._temuPopupHidden) return false;
  el.dataset._temuPopupHidden = '1';
  el.style.setProperty('display', 'none', 'important');
  return true;
}

function clearAllPopups() {
  let hidden = 0;

  // Layer 1: known selectors
  document.querySelectorAll(POPUP_SELECTORS.join(',')).forEach(el => {
    if (isOurPanel(el)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (hideEl(el)) hidden++;
  });

  // Layer 2: high z-index fixed/absolute elements covering most of viewport
  const vpW = window.innerWidth, vpH = window.innerHeight;
  const vpArea = vpW * vpH;
  document.querySelectorAll('body *').forEach(el => {
    if (isOurPanel(el)) return;
    if (el.dataset._temuPopupHidden) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
    const z = parseInt(cs.zIndex, 10);
    if (!Number.isFinite(z) || z < 1000) return;
    const r = el.getBoundingClientRect();
    const coversArea = (r.width * r.height) > vpArea * 0.5;
    const coversBoth = r.width > vpW * 0.7 && r.height > vpH * 0.7;
    if (coversArea || coversBoth) {
      if (hideEl(el)) hidden++;
    }
  });

  // Layer 3: unlock body/html scroll lock that modals often impose
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
      el.style.setProperty('overflow', 'auto', 'important');
    }
    if (el.style.paddingRight) el.style.paddingRight = '';
  }

  return hidden;
}

let _barSubResetTimer = null;
function flashBarSub(text, holdMs = 2000) {
  const sub = shadow.getElementById('bar-sub');
  if (!sub) return;
  const prev = sub.textContent;
  sub.textContent = text;
  if (_barSubResetTimer) clearTimeout(_barSubResetTimer);
  _barSubResetTimer = setTimeout(() => { sub.textContent = prev; }, holdMs);
}

function onClearClick() {
  const n = clearAllPopups();
  const msg = n > 0 ? `已清除 ${n} 个弹窗 / 弹层` : '未发现可清除的弹窗';
  if (panel.style.display !== 'none') {
    showBanner(msg, 'info');
  } else {
    flashBarSub(`· ${msg}`);
  }
}

shadow.getElementById('clear-btn').addEventListener('click', onClearClick);
shadow.getElementById('bar-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  onClearClick();
});

// ── Status updates ────────────────────────────────────────────────────────────

function updatePanelStatus(msg) {
  if (msg.status === 'error-no-api') {
    showBanner('未配置 API URL，请前往插件选项页填写（默认 http://localhost:3003）');
    shadow.getElementById('start-btn').style.display = '';
    shadow.getElementById('start-btn').disabled = false;
    shadow.getElementById('progress-wrap').style.display = 'none';
    shadow.getElementById('bar-sub').textContent = '· 就绪';
    return;
  }
  if (msg.status === 'next-date') {
    renderProgress(_activeModules, `日期 ${msg.dateIndex + 1}/${msg.totalDates}：${msg.date}`);
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
    shadow.getElementById('bar-sub').textContent = '· 采集中';
  }
  if (msg.status === 'retrying') {
    shadow.getElementById('bar-sub').textContent = '· 重试中';
  }
}
