// Popup main script.
//
// 当前状态：UI 骨架 + mock 数据，所有真实 chrome.runtime 通信处都打了
// `// TODO[agent-bridge]` 标记，等后端 agent_tasks 队列上线后接通。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ──────────────────────────────────────────────────────────────
// Chrome API 兼容层 —— 让本文件在 file:// / 静态预览 也能跑
// ──────────────────────────────────────────────────────────────
const CHROME = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome : {
  runtime: { getManifest: () => ({ version: '1.0.0 (preview)' }), openOptionsPage: () => alert('options 仅在扩展内有效') },
  storage: { local: {
    get: (_keys, cb) => setTimeout(() => cb({}), 0),
    set: (_obj, cb) => cb && setTimeout(cb, 0),
  }},
};

// ──────────────────────────────────────────────────────────────
// 1. 配置（version / API URL / token）
// ──────────────────────────────────────────────────────────────
$('#version').textContent = CHROME.runtime.getManifest().version;

let cfg = { apiUrl: '', token: '', custody: 'full' };
CHROME.storage.local.get(['apiUrl', 'token', 'custody'], (saved) => {
  cfg = { ...cfg, ...saved };
  if (cfg.custody) selectCustody(cfg.custody);
  refreshAccountChip();
  pingServer();
  refreshFromApi();          // 启动后立刻拉一次真实进度
  setInterval(refreshFromApi, 5000);  // 每 5s 刷
});

// ──────────────────────────────────────────────────────────────
// API 桥（接 ERP /api/agent/tasks）
// ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  if (!cfg.apiUrl) throw new Error('未配置 ERP API');
  const res = await fetch(cfg.apiUrl + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${cfg.token || 'demo'}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  return res.status === 204 ? null : res.json();
}

const KIND_LABELS = {
  'scrape:activity-data':    '获取活动数据',
  'scrape:settlement':       '获取结算数据',
  'scrape:flux-analysis':    '获取流量分析',
  'scrape:sales-30d':        '获取近30天销量',
  'scrape:declared-price':   '获取申报价格',
  'scrape:marketing-activity': '获取营销活动',
  'scrape:promo':            '获取广告报表',
  'submit:activity-enroll':  '提交活动报名',
  'submit:price-confirm':    '提交价格确认',
  'submit:price-reject':     '提交价格驳回',
};
const STATUS_TO_UI = {
  pending:   { cls: 'pending', label: '待获取' },
  claimed:   { cls: 'running', label: '已派单' },
  running:   { cls: 'running', label: '获取中…' },
  success:   { cls: 'ok',      label: '获取成功' },
  failed:    { cls: 'failed',  label: '获取失败' },
  cancelled: { cls: 'pending', label: '已取消' },
};
const REGION_LABEL = {
  us: '美区', eu: '欧区', jp: '日区', mx: '墨区', global: '全球', cn: '跨境', pa: '托管',
};
function regionFromTask(t) {
  const r = t.payload?.region || t.payload?.site || '';
  return REGION_LABEL[r] || r || '-';
}

// 模块 key → backend task kind
const MODULE_TO_KIND = {
  'account-funds':  'scrape:settlement',
  'sales-30d':      'scrape:sales-30d',
  'settle-report':  'scrape:settlement',
  'declare-price':  'scrape:declared-price',
  'activity-data':  'scrape:activity-data',
  'marketing-act':  'scrape:marketing-activity',
  'flux-analysis':  'scrape:flux-analysis',
  'promo':          'scrape:promo',
};

// 反向:kind → module key(给 renderProgress 过滤 + computeModuleCounts 计数用)
const KIND_TO_MODULE = Object.fromEntries(
  Object.entries(MODULE_TO_KIND).map(([m, k]) => [k, m])
);

let _apiShops = [];          // /api/shops 返回
let _apiTasks = [];          // /api/agent/tasks 返回
let _connected = false;      // 上次 refreshFromApi 是否成功

async function refreshFromApi() {
  if (!cfg.apiUrl) { _connected = false; return; }
  // 拆成 allSettled，一个挂不影响另一个；任一成功就算"已连"
  const [shopsR, tasksR] = await Promise.allSettled([
    apiFetch('/api/shops'),
    apiFetch('/api/agent/tasks?limit=100'),
  ]);
  if (shopsR.status === 'fulfilled') {
    const v = shopsR.value;
    _apiShops = Array.isArray(v) ? v : (v?.items || []);
  } else {
    console.warn('[popup] /api/shops:', shopsR.reason?.message);
  }
  if (tasksR.status === 'fulfilled') {
    const v = tasksR.value;
    _apiTasks = Array.isArray(v) ? v : (v?.tasks || []);
  } else {
    console.warn('[popup] /api/agent/tasks:', tasksR.reason?.message);
  }
  _connected = shopsR.status === 'fulfilled' || tasksR.status === 'fulfilled';
  if (_connected) {
    shops = buildShopsFromApi();
    renderModules();    // ★ 左侧计数依赖 _apiTasks/_apiShops,初次拉到后必须重渲染
    renderProgress();
  }
}

function buildShopsFromApi() {
  // 当前 custody Tab 过滤店铺
  const wanted = activeCustody === 'full' ? 'full' : 'semi';
  return _apiShops
    .filter((s) => s.platform === 'temu' && s.shopType === wanted)
    .map((s) => {
      // 按 kind 合并:同 kind 多次任务只留最新一条 + 执行时间。
      // _apiTasks 已按 createdAt desc(后端默认),所以第一遇到的就是最新。
      const byKind = new Map();
      for (const t of _apiTasks) {
        if (t.shopId !== s.id) continue;
        if (!byKind.has(t.kind)) byKind.set(t.kind, t);
      }
      const tasks = Array.from(byKind.values()).map((t) => {
        const ui = STATUS_TO_UI[t.status] || STATUS_TO_UI.pending;
        return {
          taskId: t.id,
          name: KIND_LABELS[t.kind] || t.kind,
          region: regionFromTask(t),
          status: ui.cls,
          result: ui.label,
          execAt: t.completedAt || t.claimedAt || t.createdAt || null,
          errorMessage: t.errorMessage,
        };
      });
      return {
        id: s.id,
        name: s.displayName || s.platformShopId || s.id.slice(0, 8),
        // 不再显示 region=pa / 12 / 30 这些噪声;详情用 hover tooltip 看
        window: '',
        expanded: true,
        tasks,
      };
    });
}

// 时间 → "刚刚 / 几分钟前 / HH:mm" 简短格式,放任务行尾用
function fmtExecAt(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 0) return '';
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  // 24h 以上 显示日期 + 时间
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 'today' | '7d' | '30d' | '90d' → ISO yyyy-mm-dd 对的起止
function dateRangeToDates(dateRange) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = fmt(today);
  const back = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return fmt(d);
  };
  switch (dateRange) {
    case 'today': return { startDate: end, endDate: end };
    case '7d':    return { startDate: back(6),  endDate: end };
    case '30d':   return { startDate: back(29), endDate: end };
    case '90d':   return { startDate: back(89), endDate: end };
    default:      return { startDate: back(6),  endDate: end };  // safe default
  }
}

async function createTasksForSelected() {
  if (!cfg.apiUrl) throw new Error('请先配置 ERP API 地址');
  const kinds = [...SELECTED].map((m) => MODULE_TO_KIND[m]).filter(Boolean);
  if (kinds.length === 0) throw new Error('请至少勾选一个模块');

  // 决定派到哪些店铺
  let targetIds = [];
  if (selectedShops && selectedShops.length > 0) {
    targetIds = selectedShops;
  } else {
    targetIds = _apiShops
      .filter((s) => s.platform === 'temu'
        && s.shopType === activeCustody
        && s.status === 'active')
      .map((s) => s.id);
  }
  if (targetIds.length === 0) throw new Error('没有可用店铺，请先在 ERP 绑定 Temu 店铺');

  const region = $('#region')?.value || 'global';
  const dateRange = $('#date-range')?.value || '7d';
  const dates = dateRangeToDates(dateRange);
  const shopById = new Map(_apiShops.map((s) => [s.id, s]));

  const tasks = [];
  for (const shopId of targetIds) {
    const shop = shopById.get(shopId);
    if (!shop) {
      console.warn('[popup] shop not in _apiShops, skip:', shopId);
      continue;
    }
    for (const kind of kinds) {
      const t = await apiFetch('/api/agent/tasks', {
        method: 'POST',
        body: JSON.stringify({
          shopId,
          kind,
          payload: {
            mallId: shop.platformShopId,
            siteType: shop.shopType,
            region,
            startDate: dates.startDate,
            endDate: dates.endDate,
          },
          priority: 5,
        }),
      });
      tasks.push(t);
    }
  }
  return tasks;
}

function refreshAccountChip() {
  $('#account-name').textContent = cfg.apiUrl
    ? new URL(cfg.apiUrl).host
    : '未绑定 ERP';
}

// ──────────────────────────────────────────────────────────────
// 2. 模块定义 + Mock 进度
//    真实数据从 background message 来：{ shops: [...], modules: [...] }
// ──────────────────────────────────────────────────────────────
// 模块定义只保留 key + label;count/total 由 computeModuleCounts() 按真实任务算
const MODULES_BY_CUSTODY = {
  full: [
    { key: 'account-funds', label: '获取账号资金' },
    { key: 'sales-30d',     label: '获取近 30 天销量' },
    { key: 'settle-report', label: '获取结算报表' },
    { key: 'declare-price', label: '获取申报价格' },
    { key: 'activity-data', label: '获取活动数据' },
    { key: 'marketing-act', label: '获取营销活动' },
    { key: 'flux-analysis', label: '获取流量分析' },
  ],
  semi: [
    { key: 'sales-30d',     label: '获取近 30 天销量' },
    { key: 'declare-price', label: '获取申报价格' },
    { key: 'orders',        label: '获取订单数据' },
    { key: 'promo',         label: '获取促销数据' },
  ],
};

// 按 module key → 这一类下 (成功数 / 总数);只统计当前 custody 下的店铺
function computeModuleCounts() {
  const wanted = activeCustody === 'full' ? 'full' : 'semi';
  const shopIds = new Set(
    _apiShops.filter((s) => s.platform === 'temu' && s.shopType === wanted).map((s) => s.id),
  );
  const counts = {};
  for (const t of _apiTasks) {
    if (!shopIds.has(t.shopId)) continue;
    const moduleKey = KIND_TO_MODULE[t.kind];
    if (!moduleKey) continue;
    // 按 (shopId, kind) 合并 — 同一 task 多次重试只算 1
    const bucket = (counts[moduleKey] ||= { keys: new Set(), succ: new Set() });
    const dedupeKey = `${t.shopId}::${t.kind}`;
    bucket.keys.add(dedupeKey);
    if (t.status === 'success') bucket.succ.add(dedupeKey);
  }
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, { count: v.succ.size, total: v.keys.size }]),
  );
}

// 默认空,逼用户主动勾选,意图明确;chrome.storage 里有记忆值则恢复
const SELECTED = new Set();
let activeCustody = 'full';
let activeModule = null;

function renderModules() {
  const list = MODULES_BY_CUSTODY[activeCustody];
  const counts = computeModuleCounts();
  const ul = $('#module-list');
  ul.innerHTML = '';
  for (const m of list) {
    const li = document.createElement('li');
    li.className = 'module-item' + (m.key === activeModule ? ' active' : '');
    li.dataset.key = m.key;
    const c = counts[m.key];
    const countText = c ? `${c.count}/${c.total}` : '';
    li.innerHTML = `
      <input type="checkbox" ${SELECTED.has(m.key) ? 'checked' : ''} data-key="${m.key}" />
      <span class="module-label">${m.label}</span>
      <span class="module-count">${countText}</span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      // 再点同一个 → 取消过滤
      activeModule = activeModule === m.key ? null : m.key;
      renderModules();
      renderProgress();
    });
    li.querySelector('input').addEventListener('change', (e) => {
      const k = e.target.dataset.key;
      e.target.checked ? SELECTED.add(k) : SELECTED.delete(k);
      updateFetchButton();
    });
    ul.appendChild(li);
  }
  updateFetchButton();
}

// 手动获取按钮文案 / 状态 — 让用户一眼看清"会派多少类"
function updateFetchButton() {
  const btn = document.getElementById('btn-fetch');
  if (!btn) return;
  const n = SELECTED.size;
  if (n === 0) {
    btn.disabled = true;
    btn.textContent = '请先勾选模块';
  } else {
    btn.disabled = false;
    btn.textContent = `手动获取 (${n} 项)`;
  }
}

// ──────────────────────────────────────────────────────────────
// 3. 进度区（演示数据）
//    每店铺 -> 多任务，每任务有 status: ok/running/failed/pending
// ──────────────────────────────────────────────────────────────
function mockShops(custody) {
  if (custody === 'full') return [
    {
      id: 's1',
      name: '测试店铺-全托主店',
      window: '2026-04-16 ~ 2026-05-15',
      expanded: true,
      tasks: [
        { name: '待处理款项',  region: '全球', status: 'ok',      result: '获取成功' },
        { name: '结算中款项',  region: '全球', status: 'ok',      result: '获取成功' },
        { name: '已到账款项',  region: '全球', status: 'ok',      result: '获取成功' },
        { name: '待处理款项',  region: '美区', status: 'ok',      result: '获取成功' },
        { name: '结算中款项',  region: '美区', status: 'ok',      result: '获取成功' },
        { name: '已到账款项',  region: '美区', status: 'running', result: '获取中…' },
        { name: '待处理款项',  region: '欧区', status: 'pending', result: '待获取' },
        { name: '结算中款项',  region: '欧区', status: 'pending', result: '待获取' },
        { name: '已到账款项',  region: '欧区', status: 'pending', result: '待获取' },
      ],
    },
    {
      id: 's2',
      name: '测试店铺-全托备用店',
      window: '2026-02-16 ~ 2026-05-15',
      expanded: false,
      tasks: [
        { name: '活动数据', region: '美区', status: 'ok', result: '获取成功' },
        { name: '营销活动', region: '美区', status: 'failed', result: '账号匹配失败' },
        { name: '申报价格', region: '欧区', status: 'ok', result: '获取成功' },
      ],
    },
  ];
  return [
    {
      id: 's3',
      name: '半托测试店',
      window: '2026-05-01 ~ 2026-05-15',
      expanded: true,
      tasks: [
        { name: '订单数据', region: '美区', status: 'ok', result: '获取成功' },
        { name: '申报价格', region: '美区', status: 'ok', result: '获取成功' },
      ],
    },
  ];
}
let shops = mockShops(activeCustody);

function summary(tasks) {
  let ok = 0, total = tasks.length, hasRunning = false, failed = 0;
  for (const t of tasks) {
    if (t.status === 'ok') ok++;
    if (t.status === 'running') hasRunning = true;
    if (t.status === 'failed') failed++;
  }
  let s;
  if (total === 0)                  s = { cls: 'pending', text: '待获取' };
  else if (hasRunning)              s = { cls: 'running', text: '获取中' };
  else if (failed === total)        s = { cls: 'failed',  text: '获取失败' };
  else if (failed > 0)              s = { cls: 'failed',  text: '部分失败' };
  else if (ok === total)            s = { cls: 'ok',      text: '获取成功' };
  else                              s = { cls: 'pending', text: '待获取' };
  return { ok, total, ...s };
}

function taskIcon(status) {
  if (status === 'ok')      return { glyph: '✓', cls: 'ok' };
  if (status === 'running') return { glyph: '◐', cls: 'running' };
  if (status === 'failed')  return { glyph: '✕', cls: 'failed' };
  return { glyph: '⏰', cls: 'pending' };
}

function renderProgress() {
  const area = $('#progress-area');
  area.innerHTML = '';
  const onlyFailed = $('#only-failed').checked;
  // 拿到当前选中模块对应的 kind（activeModule 是 module key）
  const filterKind = activeModule ? MODULE_TO_KIND[activeModule] : null;

  let totalRendered = 0;
  for (const shop of shops) {
    let tasksToShow = shop.tasks;
    // 模块过滤（点左侧某个模块 → 只看这个模块的任务）
    if (filterKind) {
      tasksToShow = tasksToShow.filter((t) => {
        // 真 API 任务有 taskId + 我们存了原 kind 在 _apiTasks 里查
        const orig = _apiTasks.find((x) => x.id === t.taskId);
        return orig?.kind === filterKind;
      });
    }
    if (onlyFailed) tasksToShow = tasksToShow.filter((t) => t.status === 'failed');
    if ((filterKind || onlyFailed) && tasksToShow.length === 0) continue;

    const block = document.createElement('div');
    block.className = 'shop-block';
    // ★ 用 tasksToShow 而非 shop.tasks — 否则用户筛选某模块时
    //   header 状态会汇总全量任务的失败(跟可见行不一致,出现"1 条成功 / 部分失败"的歧义)
    const s = summary(tasksToShow);

    block.innerHTML = `
      <div class="shop-head ${shop.expanded ? 'expanded' : ''}">
        <span class="shop-caret">▶</span>
        <span class="shop-status ${s.cls}">${s.text}</span>
        <span class="shop-name">${shop.name}</span>
      </div>
      ${shop.expanded ? `
        <div class="task-list">
          ${tasksToShow.map((t) => {
            const i = taskIcon(t.status);
            const retryBtn = t.status === 'failed'
              ? `<button class="task-retry" data-shop="${shop.id}" data-idx="${shop.tasks.indexOf(t)}" title="重新执行此任务">↻ 重试</button>`
              : '';
            const ts = fmtExecAt(t.execAt);
            return `
              <div class="task-row">
                <span class="task-icon ${i.cls}">${i.glyph}</span>
                <span class="task-name">${t.name}</span>
                <span class="task-result ${i.cls}">${t.result}</span>
                <span class="task-exec-at" title="${t.execAt || ''}">${ts}</span>
                ${retryBtn}
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    `;
    block.querySelector('.shop-head').addEventListener('click', () => {
      shop.expanded = !shop.expanded;
      renderProgress();
    });
    block.querySelectorAll('.task-retry').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const shopId = btn.dataset.shop;
        const idx = Number(btn.dataset.idx);
        const targetShop = shops.find((s) => s.id === shopId);
        if (!targetShop) return;
        const task = targetShop.tasks[idx];
        if (!task) return;
        btn.classList.add('busy');
        btn.textContent = '↻ 重试中…';
        try {
          // 通过 raw rawTask 找到原 kind/payload 重新建一个
          const orig = _apiTasks.find((t) => t.id === task.taskId);
          if (!orig) throw new Error('找不到原任务');
          await apiFetch('/api/agent/tasks', {
            method: 'POST',
            body: JSON.stringify({
              shopId: orig.shopId,
              kind: orig.kind,
              payload: orig.payload || {},
              priority: 8,  // 重试给高优
            }),
          });
          try { chrome.runtime?.sendMessage?.({ type: 'AGENT_PULL_NOW' }); } catch {}
          setTimeout(refreshFromApi, 500);
        } catch (e2) {
          alert('重试派单失败: ' + e2.message);
          btn.classList.remove('busy');
          btn.textContent = '↻ 重试';
        }
      });
    });
    area.appendChild(block);
    totalRendered++;
  }

  $('#empty-state').hidden = totalRendered > 0;
  area.hidden = totalRendered === 0;
}

// ──────────────────────────────────────────────────────────────
// 4. 托管类型切换
// ──────────────────────────────────────────────────────────────
function selectCustody(c) {
  activeCustody = c;
  $$('.custody-tab').forEach((b) => b.classList.toggle('active', b.dataset.custody === c));
  $('#custody-pill').textContent = c === 'full' ? '全托模式' : '半托模式';
  // 优先用真实数据，离线时 fallback 到 mock
  shops = _connected ? buildShopsFromApi() : mockShops(c);
  // 切换托管类型时重置店铺选择（避免选了旧 shopId）
  if (typeof selectedShops !== 'undefined') {
    selectedShops = null;
    if (document.getElementById('shop-picker-btn')) updateShopPickerLabel();
  }
  renderModules();
  renderProgress();
  CHROME.storage.local.set({ custody: c });
}
$$('.custody-tab').forEach((b) => b.addEventListener('click', () => selectCustody(b.dataset.custody)));

// ──────────────────────────────────────────────────────────────
// 5. 操作按钮
// ──────────────────────────────────────────────────────────────
$('#btn-fetch').addEventListener('click', async () => {
  $('#btn-fetch').disabled = true;
  $('#btn-fetch').textContent = '派单中…';
  try {
    const created = await createTasksForSelected();
    $('#last-sync').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 通知 service_worker 立刻拉一次（不等下个 10s 周期）
    try { chrome.runtime?.sendMessage?.({ type: 'AGENT_PULL_NOW' }); } catch {}
    console.log(`[popup] 已创建 ${created.length} 个任务`);
    // 短延迟后刷新真实进度
    setTimeout(refreshFromApi, 600);
  } catch (e) {
    alert('派单失败：' + e.message);
  } finally {
    updateFetchButton();
  }
});

$('#btn-refresh').addEventListener('click', () => {
  refreshFromApi();
});

$('#only-failed').addEventListener('change', renderProgress);

$('#link-online').addEventListener('click', async (e) => {
  e.preventDefault();
  const pop = $('#online-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.hidden = false;
  await loadOnlineStatus();
});

$('#online-pop-close').addEventListener('click', () => { $('#online-pop').hidden = true; });
$('#online-pop-refresh').addEventListener('click', async () => {
  // 真"实测":让 SW 开 4 个 hidden tab 跑 /labor/bill,看是否跳登录页 → 写 loginHealth
  // 平均耗时 5-15s,期间按钮 disabled + 加载中
  const btn = $('#online-pop-refresh');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'AGENT_RECHECK_LOGIN' }, (r) => {
        if (chrome.runtime.lastError) { /* SW not active */ }
        resolve(r);
      });
    });
  } catch (e) {
    console.warn('[popup] recheck failed', e?.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText || '重新检测';
  }
  await loadOnlineStatus();
});

async function clearExpiredHealth() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const s = await chrome.storage.local.get('agent:loginHealth');
    const h = s['agent:loginHealth'] || {};
    const cleared = {};
    for (const [k, v] of Object.entries(h)) {
      if (v?.status === 'expired') continue;       // 丢弃 expired 标记
      cleared[k] = v;                              // 保留 ok / unknown
    }
    await chrome.storage.local.set({ 'agent:loginHealth': cleared });
  } catch (e) {
    console.warn('[popup] clearExpiredHealth failed', e?.message);
  }
}

// 汇总各子域状态 → 顶部 dot 着色
function applyOnlineDotFromDomains(domains) {
  const dot = $('#online-dot');
  if (!dot || !Array.isArray(domains) || domains.length === 0) return;
  // 只关注 global/us/eu(kjmh 是另一个域名,暂不计入主健康)
  const main = domains.filter((d) => d.key === 'global' || d.key === 'us' || d.key === 'eu');
  const statuses = main.map((d) => d.status);
  const errCount = statuses.filter((s) => s === 'off' || s === 'error').length;
  const okCount  = statuses.filter((s) => s === 'ok').length;
  dot.classList.remove('ok', 'warn', 'err');
  if (errCount === 0) {
    dot.classList.add('ok');
    dot.title = '三个区域登录态均正常';
  } else if (okCount > 0) {
    dot.classList.add('warn');
    dot.title = `部分子域需要重新登录:${main.filter((d) => d.status === 'off' || d.status === 'error').map((d) => d.label).join(', ')}`;
  } else {
    dot.classList.add('err');
    dot.title = '全部子域均需重新登录';
  }
}

// 不再用假 fallback — SW 返不来就显示真的 "检测失败",让用户知道有问题而不是看到假"全部在线"
const TEMU_DOMAINS_META = [
  { key: 'global', label: '全球',     gateway: 'agentseller.temu.com',     url: 'https://agentseller.temu.com' },
  { key: 'us',     label: '美区',     gateway: 'agentseller-us.temu.com',  url: 'https://agentseller-us.temu.com' },
  { key: 'eu',     label: '欧区',     gateway: 'agentseller-eu.temu.com',  url: 'https://agentseller-eu.temu.com' },
  { key: 'kjmh',   label: '跨境卖家', gateway: 'seller.kuajingmaihuo.com', url: 'https://seller.kuajingmaihuo.com' },
];

async function checkCookiesViaSW(timeoutMs = 6000) {
  // SW 冷启动可能慢,bump 6s。返 null 不再 fallback 假数据。
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  try {
    return await new Promise((resolve) => {
      let done = false;
      try {
        chrome.runtime.sendMessage({ type: 'AGENT_CHECK_COOKIES' }, (r) => {
          if (done) return;
          done = true;
          resolve(r ?? null);
        });
      } catch (e) {
        done = true;
        resolve(null);
      }
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    });
  } catch { return null; }
}

// 直接从 chrome.storage.local 读 plugin 实测得到的 loginHealth(SW 已写入)
// 这条路径绕过 sendMessage,确保即便 SW 挂了也能拿到最近一次的 expired 状态
async function readLoginHealthFromStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
  try {
    const s = await chrome.storage.local.get('agent:loginHealth');
    return s['agent:loginHealth'] || {};
  } catch { return {}; }
}

async function loadOnlineStatus() {
  const body = $('#online-pop-body');
  body.innerHTML = '<div class="hint-row">检测中…</div>';

  const res = await checkCookiesViaSW();

  // 即便 SW 调用失败,我们也用 storage 直读的 loginHealth + meta 拼一份可显示数据
  let domains;
  if (res && Array.isArray(res.domains)) {
    domains = res.domains;
  } else {
    const health = await readLoginHealthFromStorage();
    domains = TEMU_DOMAINS_META.map((d) => {
      const h = health[d.key];
      let status = 'unknown';
      if (h?.status === 'expired') status = 'off';
      else if (h?.status === 'ok') status = 'ok';
      return {
        ...d,
        status,
        source: h ? 'plugin-actual' : 'cookie-unavailable',
        reason: h?.reason ?? (res ? 'SW 返空' : 'SW 无响应或 chrome.cookies 不可用'),
        cookieCount: 0,
      };
    });
  }

  const labelMap = { ok: '在线', partial: '部分凭证', off: '未登录', error: '失败', unknown: '未检测' };
  body.innerHTML = domains.map((d) => {
    const isBad = d.status === 'off' || d.status === 'partial' || d.status === 'error' || d.status === 'unknown';
    const action = isBad
      ? `<a class="domain-action" href="${d.url}" target="_blank" rel="noopener">去登录 →</a>`
      : `<span class="domain-status ${d.status}">${labelMap[d.status]}</span>`;
    const sourceTag = d.source === 'plugin-actual'
      ? `<span class="domain-source" title="${d.reason || ''}">实测</span>`
      : (d.source === 'cookie-unavailable' ? `<span class="domain-source" title="${d.reason || ''}">未连</span>` : '');
    return `
      <div class="domain-row">
        <span class="indicator ${d.status}"></span>
        <div class="domain-info">
          <div class="domain-label">${d.label} ${sourceTag}</div>
          <div class="domain-host">${d.gateway}</div>
        </div>
        ${action}
      </div>
    `;
  }).join('');

  applyOnlineDotFromDomains(domains);
  updateLoginBanner(domains);
}

// ★ 顶部"登录态过期"banner — 任何 region 显示 expired/off 就显眼提示用户去登
function updateLoginBanner(domains) {
  const expired = domains.filter((d) => d.status === 'off' && d.source === 'plugin-actual');
  let banner = document.getElementById('login-banner');
  if (expired.length === 0) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'login-banner';
    banner.style.cssText = 'padding:8px 12px;background:#fef2f2;border-bottom:2px solid #ef4444;color:#991b1b;font-size:12px;display:flex;align-items:center;gap:8px;';
    document.querySelector('.app').insertBefore(banner, document.querySelector('.custody-tabs'));
  }
  const names = expired.map((d) => d.label).join('、');
  const firstUrl = expired[0].url;
  banner.innerHTML = `
    <span style="font-size:16px">⚠️</span>
    <span><b>${names}</b> 登录态已过期,所有同步任务会失败 —
      <a href="${firstUrl}" target="_blank" rel="noopener" style="color:#b91c1c;text-decoration:underline;font-weight:600">去 ${expired[0].label} 重新登录 Temu →</a>
    </span>
  `;
}

// 启动时静默检测一次,让顶部 dot 即刻有色 + banner 出现
(async () => {
  const res = await checkCookiesViaSW(6000);
  if (res?.domains) {
    applyOnlineDotFromDomains(res.domains);
    updateLoginBanner(res.domains);
  } else {
    // SW 调用失败也试一下从 storage 直读 loginHealth
    const health = await readLoginHealthFromStorage();
    const domains = TEMU_DOMAINS_META.map((d) => ({
      ...d,
      status: health[d.key]?.status === 'expired' ? 'off' : (health[d.key]?.status === 'ok' ? 'ok' : 'unknown'),
      source: health[d.key] ? 'plugin-actual' : 'cookie-unavailable',
    }));
    applyOnlineDotFromDomains(domains);
    updateLoginBanner(domains);
  }
})();

$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  CHROME.runtime.openOptionsPage();
});

// ──────────────────────────────────────────────────────────────
// 6. 操作日志 modal — 真实拉 /api/agent/tasks?limit=50,每行 = 一次任务执行
// ──────────────────────────────────────────────────────────────
const LOG_STATUS_LABELS = {
  pending: '等待',
  claimed: '已领',
  running: '执行中',
  success: '成功',
  failed: '失败',
  cancelled: '取消',
};

// kind → 中文展示名(跟 KIND_LABELS 重复但保留是为了日志独立可读)
function logKindLabel(kind) {
  return (KIND_LABELS && KIND_LABELS[kind]) || kind;
}

// Asia/Shanghai 时间格式化(plugin 不能 import vue util,这里内联一份)
function shFmtTime(s) {
  if (!s) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(s)).replace(/\//g, '-');
  } catch { return String(s); }
}

$('#btn-log').addEventListener('click', () => openLogModal());
$('#modal-close').addEventListener('click', () => closeLogModal());
$('#btn-close-modal').addEventListener('click', () => closeLogModal());

let countdownTimer = null;
async function openLogModal() {
  $('#log-modal').hidden = false;
  $('#log-total').textContent = '…';
  const tbody = $('#log-body');
  tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:#9ca3af">加载中…</td></tr>';

  try {
    const resp = await apiFetch('/api/agent/tasks?limit=50');
    const arr = Array.isArray(resp) ? resp : (resp?.tasks || resp?.items || []);
    $('#log-total').textContent = String(arr.length);
    if (arr.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:#9ca3af">还没有任务记录</td></tr>';
    } else {
      tbody.innerHTML = arr.map((t) => {
        const kind = logKindLabel(t.kind);
        const stat = LOG_STATUS_LABELS[t.status] || t.status || '?';
        const trigger = t.createdBy ? '手动' : '系统';
        const errMsg = (t.status === 'failed' && t.errorMessage)
          ? ` <span style="color:#b91c1c">— ${String(t.errorMessage).slice(0, 80)}</span>`
          : '';
        const time = shFmtTime(t.completedAt || t.claimedAt || t.createdAt);
        const statColor = t.status === 'success' ? '#15803d'
          : t.status === 'failed' ? '#b91c1c'
          : t.status === 'running' || t.status === 'claimed' ? '#2563eb'
          : '#6b7280';
        return `<tr>
          <td>${kind} · <span style="color:${statColor}">${stat}</span> · ${trigger}${errMsg}</td>
          <td class="r">${time}</td>
        </tr>`;
      }).join('');
    }
  } catch (e) {
    $('#log-total').textContent = '0';
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:#b91c1c">加载失败: ${e.message}</td></tr>`;
  }

  // 倒计时自动刷新 — 30s 一轮
  let c = 30;
  $('#log-countdown').textContent = c;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    c--;
    if (c <= 0) {
      openLogModal();   // 重启自身,reset countdown
      return;
    }
    $('#log-countdown').textContent = c;
  }, 1000);
}
function closeLogModal() {
  $('#log-modal').hidden = true;
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ──────────────────────────────────────────────────────────────
// 7. 切换账号 modal
// ──────────────────────────────────────────────────────────────
$('#btn-switch-account').addEventListener('click', () => {
  $('#cfg-api-url').value = cfg.apiUrl || '';
  $('#cfg-token').value = cfg.token || '';
  $('#cfg-status').textContent = '';
  $('#cfg-status').className = 'form-hint';
  $('#account-modal').hidden = false;
});
$('#account-modal-close').addEventListener('click', () => { $('#account-modal').hidden = true; });
$('#cfg-cancel').addEventListener('click', () => { $('#account-modal').hidden = true; });

$('#cfg-save').addEventListener('click', async () => {
  const apiUrl = $('#cfg-api-url').value.trim().replace(/\/$/, '');
  const token = $('#cfg-token').value.trim();
  if (!apiUrl) {
    $('#cfg-status').textContent = '请填写 API 地址';
    $('#cfg-status').className = 'form-hint err';
    return;
  }
  $('#cfg-status').textContent = '测试中…';
  $('#cfg-status').className = 'form-hint';
  try {
    const r = await fetch(`${apiUrl}/api/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (r.ok) {
      cfg = { ...cfg, apiUrl, token };
      CHROME.storage.local.set({ apiUrl, token });
      refreshAccountChip();
      $('#cfg-status').textContent = '✅ 连接成功，已保存';
      $('#cfg-status').className = 'form-hint ok';
      pingServer();
      setTimeout(() => { $('#account-modal').hidden = true; }, 800);
    } else {
      $('#cfg-status').textContent = `❌ HTTP ${r.status}`;
      $('#cfg-status').className = 'form-hint err';
    }
  } catch (e) {
    $('#cfg-status').textContent = `❌ ${e.message}`;
    $('#cfg-status').className = 'form-hint err';
  }
});

// ──────────────────────────────────────────────────────────────
// 8. 底部状态栏 ping
// ──────────────────────────────────────────────────────────────
async function pingServer() {
  const dot = $('#dot-server');
  const host = $('#server-host');
  if (!cfg.apiUrl) {
    dot.className = 'dot dot-warn';
    host.textContent = '未连';
    return;
  }
  try {
    const r = await fetch(`${cfg.apiUrl}/api/health`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    });
    if (r.ok) {
      dot.className = 'dot dot-ok';
      host.textContent = new URL(cfg.apiUrl).host;
    } else {
      dot.className = 'dot dot-err';
      host.textContent = `异常 ${r.status}`;
    }
  } catch {
    dot.className = 'dot dot-err';
    host.textContent = '断开';
  }
}

// ──────────────────────────────────────────────────────────────
// 9. 店铺多选
//    selectedShops = null  → 全部
//    selectedShops = []    → 空（按钮显示"未选店铺"）
//    selectedShops = [id]  → 仅这些
// ──────────────────────────────────────────────────────────────
let selectedShops = null;
let pendingShops = null;

function updateShopPickerLabel() {
  const btn = $('#shop-picker-btn');
  const label = $('#shop-picker-label');
  if (selectedShops === null) {
    label.textContent = `全部店铺 (${shops.length})`;
    btn.classList.remove('has-selection');
  } else if (selectedShops.length === 0) {
    label.textContent = '未选店铺';
    btn.classList.add('has-selection');
  } else if (selectedShops.length === shops.length) {
    label.textContent = `全部店铺 (${shops.length})`;
    btn.classList.remove('has-selection');
  } else {
    label.textContent = `已选 ${selectedShops.length} / ${shops.length}`;
    btn.classList.add('has-selection');
  }
}

function isShopChecked(id) {
  if (pendingShops === null) return true;
  return pendingShops.includes(id);
}

function renderShopPickerRows() {
  $('#shop-pick-count').textContent = String(shops.length);
  const body = $('#shop-picker-body');
  body.innerHTML = shops.map((s) => {
    const checked = isShopChecked(s.id) ? 'checked' : '';
    return `
      <label class="shop-picker-row">
        <input type="checkbox" data-id="${s.id}" ${checked} />
        <span>${s.name}</span>
        <span class="row-meta">${s.tasks.length} 任务</span>
      </label>
    `;
  }).join('');
  body.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (pendingShops === null) pendingShops = shops.map((s) => s.id);
      const id = cb.dataset.id;
      if (cb.checked) {
        if (!pendingShops.includes(id)) pendingShops.push(id);
      } else {
        pendingShops = pendingShops.filter((x) => x !== id);
      }
      $('#shop-pick-all').checked = pendingShops.length === shops.length;
    });
  });
  $('#shop-pick-all').checked = pendingShops === null || pendingShops.length === shops.length;
}

function openShopPicker() {
  pendingShops = selectedShops === null ? null : [...selectedShops];
  renderShopPickerRows();
  $('#shop-picker-pop').hidden = false;
}
function closeShopPicker() { $('#shop-picker-pop').hidden = true; }

$('#shop-picker-btn').addEventListener('click', () => {
  const pop = $('#shop-picker-pop');
  pop.hidden ? openShopPicker() : closeShopPicker();
});

$('#shop-pick-all').addEventListener('change', (e) => {
  pendingShops = e.target.checked ? shops.map((s) => s.id) : [];
  renderShopPickerRows();
});

$('#shop-pick-cancel').addEventListener('click', closeShopPicker);
$('#shop-pick-apply').addEventListener('click', () => {
  if (pendingShops === null || pendingShops.length === shops.length) selectedShops = null;
  else selectedShops = [...pendingShops];
  updateShopPickerLabel();
  // TODO[agent-bridge]: 写回 chrome.storage 并通知 background "下次派单只发这些店铺"
  // CHROME.storage.local.set({ selectedShops })
  closeShopPicker();
  renderProgress();
});

// ──────────────────────────────────────────────────────────────
// 10. 启动渲染
// ──────────────────────────────────────────────────────────────
renderModules();
renderProgress();
updateShopPickerLabel();
