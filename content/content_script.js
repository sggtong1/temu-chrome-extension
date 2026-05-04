// ISOLATED world — DOM access + chrome.runtime messaging + CustomEvent bridge

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTIVATE_CAPTURE') {
    window.dispatchEvent(new CustomEvent('temu:setConfig', {
      detail: { activeModule: msg.module, targetDate: msg.targetDate },
    }));
    sendResponse({ ok: true });
  }
  if (msg.type === 'DEACTIVATE_CAPTURE') {
    window.dispatchEvent(new CustomEvent('temu:setConfig', {
      detail: { activeModule: null, targetDate: null },
    }));
    sendResponse({ ok: true });
  }
  if (msg.type === 'UPDATE_PANEL_STATUS') {
    updatePanelStatus(msg.module, msg.status);
    sendResponse({ ok: true });
  }
  return false;
});

window.addEventListener('temu:apiCapture', (e) => {
  chrome.runtime.sendMessage({
    type: 'API_DATA',
    module: e.detail.module,
    url: e.detail.url,
    data: e.detail.data,
  });
});

const host = document.createElement('div');
host.id = 'temu-panel-host';
host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:system-ui;';
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
    cursor: pointer; white-space: nowrap;
  }
  .bar-label { font-weight: 600; }
  .bar-sub { opacity: .65; font-size: 10px; }
  .bar-btn { margin-left: 4px; background: rgba(255,255,255,.2); border-radius: 3px; padding: 1px 5px; font-size: 11px; }
  .panel {
    width: 340px;
    box-shadow: 0 4px 20px rgba(0,0,0,.15);
    border-radius: 8px; overflow: hidden;
  }
  .header {
    background: #1e40af; color: white;
    padding: 8px 12px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .header-title { font-weight: 600; font-size: 13px; }
  .header-btn {
    background: rgba(255,255,255,.2); border: none; color: white;
    border-radius: 4px; width: 22px; height: 22px;
    cursor: pointer; font-size: 15px; line-height: 1;
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
  .param-label { font-size: 10px; color: #94a3b8; margin-bottom: 3px; }
  select, input[type=date] {
    width: 100%; font-size: 11px; padding: 4px;
    border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc;
  }
  .footer { padding: 10px 12px; }
  .shop-info {
    background: #eff6ff; border-radius: 4px;
    padding: 6px 8px; margin-bottom: 8px;
    font-size: 11px; color: #1e40af;
    display: flex; align-items: center; gap: 6px;
  }
  .start-btn {
    width: 100%; background: #1e40af; color: white; border: none;
    padding: 8px; border-radius: 5px; font-size: 13px;
    font-weight: 600; cursor: pointer; letter-spacing: .03em;
  }
  .start-btn:disabled { background: #94a3b8; cursor: default; }
  .progress { display: flex; flex-direction: column; gap: 4px; }
  .prog-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; }
  .prog-icon { width: 18px; text-align: center; }
</style>

<div class="bar" id="bar" style="display:none">
  <span>🛒</span>
  <span class="bar-label">Temu 采集</span>
  <span class="bar-sub" id="bar-sub">· 就绪</span>
  <span class="bar-btn">＋</span>
</div>

<div class="panel" id="panel">
  <div class="header">
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
          <div class="param-label">采集日期</div>
          <input type="date" id="date">
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="shop-info" id="shop-info">
        <span>📦</span><span id="shop-text">检测店铺中...</span>
      </div>
      <button class="start-btn" id="start-btn">▶ 开始采集</button>
      <div class="progress" id="progress" style="display:none; margin-top:8px;"></div>
    </div>
  </div>
</div>
`;

const dateInput = shadow.getElementById('date');
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
dateInput.value = yesterday.toISOString().slice(0, 10);

const bar = shadow.getElementById('bar');
const panel = shadow.getElementById('panel');
shadow.getElementById('collapse-btn').addEventListener('click', () => {
  panel.style.display = 'none';
  bar.style.display = 'flex';
});
bar.addEventListener('click', () => {
  bar.style.display = 'none';
  panel.style.display = 'block';
});

function detectMallId() {
  const url = new URL(window.location.href);
  return url.searchParams.get('mallId') || url.searchParams.get('mall_id') || null;
}

const mallId = detectMallId();
if (mallId) {
  chrome.runtime.sendMessage({ type: 'GET_SHOP_INFO', mallId }, (shop) => {
    const shopText = shadow.getElementById('shop-text');
    if (shop) {
      shopText.textContent = `${shop.shop_name} · ${shop.site_type} · ${mallId}`;
    } else {
      shopText.textContent = `mallId: ${mallId}（未匹配店铺配置）`;
    }
  });
} else {
  shadow.getElementById('shop-text').textContent = '未检测到 mallId，请在店铺页面使用';
  shadow.getElementById('start-btn').disabled = true;
}

shadow.getElementById('start-btn').addEventListener('click', () => {
  const modules = [...shadow.querySelectorAll('input[name=mod]:checked')].map(el => el.value);
  const region = shadow.getElementById('region').value;
  const date = shadow.getElementById('date').value;
  if (!modules.length) return;

  shadow.getElementById('start-btn').style.display = 'none';
  const progressEl = shadow.getElementById('progress');
  progressEl.style.display = 'flex';
  progressEl.innerHTML = modules.map(m =>
    `<div class="prog-row"><span>${m.toUpperCase()}</span><span class="prog-icon" id="prog-${m}">⏳</span></div>`
  ).join('');

  chrome.runtime.sendMessage({ type: 'START_COLLECTION', modules, region, date, mallId });
});

function updatePanelStatus(module, status) {
  const el = shadow.getElementById(`prog-${module}`);
  if (el) el.textContent = status === 'done' ? '✅' : status === 'error' ? '❌' : '⏳';
  const barSub = shadow.getElementById('bar-sub');
  if (barSub) barSub.textContent = `· 采集中`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOGGLE_PANEL') {
    if (bar.style.display !== 'none') {
      bar.style.display = 'none';
      panel.style.display = 'block';
    } else {
      panel.style.display = 'none';
      bar.style.display = 'flex';
    }
  }
});
