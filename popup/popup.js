// Popup main script.
//
// 数据全部来自 ERP /api/shops + /api/agent/tasks(经 service_worker 派单中枢),
// 未连上 ERP / 未完成账号匹配时面板为空(走空状态),不再有 mock 占位数据。

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

// 固定 ERP 网关:公网域名(香港 VPS 反代 → Tailscale → mini),客户机开箱即用,无需手填。
// 仅当 storage 里存有非空值时才覆盖(本机 dev 可 chrome.storage.local.set({apiUrl:'http://192.168.1.6:4000'}))。
const DEFAULT_API_URL = 'https://duoshouapi.868818.xyz';
const DEFAULT_TOKEN = 'demo'; // TODO: 权限系统上线后改每客户独立 token
// 反代鉴权头:VPS nginx 校验 X-ERP-Key,必须与 setup-vps.sh 的 --gate-secret 同值。
const DEFAULT_ERP_GATE_KEY = 'f79063b32edd405e547f5ff2e3174ecddf14132feff78e50';

let cfg = { apiUrl: DEFAULT_API_URL, token: DEFAULT_TOKEN, custody: 'full' };
CHROME.storage.local.get(['apiUrl', 'token', 'custody', 'selectedShopIds', 'erpAccountPhone', 'erpGateKey'], (saved) => {
  cfg = { ...cfg, ...saved };
  if (!cfg.apiUrl) cfg.apiUrl = DEFAULT_API_URL;   // 历史空串也回退
  if (!cfg.token) cfg.token = DEFAULT_TOKEN;
  if (!cfg.erpGateKey) cfg.erpGateKey = DEFAULT_ERP_GATE_KEY;
  // 本客户端负责的店铺范围(per-browser scope):null=全部,数组=仅这些。
  // 由账号匹配自动写入;SW claim 读同一个 key 过滤派单。
  selectedShops = Array.isArray(saved.selectedShopIds) ? saved.selectedShopIds : null;
  if (cfg.custody) selectCustody(cfg.custody);
  refreshAccountChip();
  pingServer();
  // 开屏门控:已匹配(有 scope)→ 进面板;无 scope → 本会话首次自动匹配一次,
  // 若本会话已试过且失败 → 停在失败页等手动「立即刷新」,不自动重跑(避免反复弹 tab)。
  if (selectedShops && selectedShops.length > 0) {
    enterPanel();
  } else {
    readOnboardFailKind().then((failKind) => {
      if (failKind) {
        showOnboard();
        resetOnboardSteps();
        setStep('match', 'fail', '账号匹配失败');
        setOnboardTip((ONBOARD_FAIL_TIPS[failKind] || tipFailNotLoggedIn)());
      } else {
        runOnboard();
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────
// API 桥（接 ERP /api/agent/tasks）
// ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  if (!cfg.apiUrl) throw new Error('未配置 ERP API');
  // 超时:连不上 ERP 时让 fetch 快速失败,而不是无限挂起 → 上层能进失败 UI。
  // 默认放宽到 15s(公网网关偶发首字节慢;列表瘦身后体量已很小,基本秒回)。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  let res;
  try {
    res = await fetch(cfg.apiUrl + path, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${cfg.token || 'demo'}`,
        'Content-Type': 'application/json',
        ...(cfg.erpGateKey ? { 'X-ERP-Key': cfg.erpGateKey } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`连接 ERP 超时(${cfg.apiUrl})`);
    throw new Error(`连不上 ERP(${cfg.apiUrl}): ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  return res.status === 204 ? null : res.json();
}

const KIND_LABELS = {
  'scrape:activity-data':    '获取活动数据',
  'scrape:settlement':       '结算报表',
  'scrape:flux-analysis':    '获取流量分析',
  'scrape:sales-30d':        '获取近30天销量',
  'scrape:sku-sales-daily':  '获取每日销量明细',
  'scrape:declared-price':   '获取申报价格',
  'scrape:marketing-activity': '获取营销活动',
  'scrape:order-amounts':    '获取订单数据',
  'scrape:returns':          '获取退货退款',
  'scrape:semi-ad':          '获取广告数据',
  'scrape:settle-flow':      '账务明细',
  'scrape:logistics-bill':   '发货面单费',
  'scrape:reverse-logistics-bill': '退货面单费',
  'scrape:epr-goods-fee':    '商品环保费',
  'scrape:epr-package-fee':  '物流包装环保费',
  'scrape:epr-platform-fee': '代付服务费',
  'scrape:violation-appeals': '违规罚款',
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
  us: '美区', eu: '欧区', jp: '日区', mx: '墨区', global: '全球', kjmh: '卖家中心', cn: '跨境', pa: '托管',
};
function regionFromTask(t) {
  const r = t.payload?.region || t.payload?.site || '';
  return REGION_LABEL[r] || r || '-';
}

const SEMI_SETTLEMENT_REPORT_KINDS = [
  'scrape:settlement',
  'scrape:logistics-bill',
  'scrape:reverse-logistics-bill',
  'scrape:epr-goods-fee',
  'scrape:epr-package-fee',
  'scrape:epr-platform-fee',
];
const FULL_SETTLEMENT_REPORT_KINDS = ['scrape:settlement'];
const SETTLEMENT_REPORT_MODULE_KEY = 'settle-report';
const SETTLEMENT_REPORT_TASK_API = '/api/agent/settlement-report/tasks';
const SETTLEMENT_REPORT_STATUS_API = '/api/agent/settlement-report/status';
// 后端聚合接口落地后切 true；当前先复用现有 agent task kinds，保证入库解析不变。
const USE_RESERVED_SETTLEMENT_REPORT_API = false;
const USE_RESERVED_SETTLEMENT_REPORT_STATUS_API = false;

// 手动专属模块 key:逐日销量回填(全托)。日常逐日销量已合并进 sales-30d(「获取近30天销量」),
// 此模块只在手动采集下拉里出现,用于按任意历史区间补数(querySkuSalesNumber,需传日期)。
const DAILY_BACKFILL_MODULE_KEY = 'sku-daily-backfill';

// 模块 key → backend task kind(s)。settle-report 在不同托管模式下对应不同 kind 集合。
const MODULE_TO_KINDS = {
  'sales-30d':      ['scrape:sales-30d'],
  'settle-report':  { full: FULL_SETTLEMENT_REPORT_KINDS, semi: SEMI_SETTLEMENT_REPORT_KINDS },
  'declare-price':  ['scrape:declared-price'],
  'activity-data':  ['scrape:activity-data'],
  'marketing-act':  ['scrape:marketing-activity'],
  'flux-analysis':  ['scrape:flux-analysis'],
  'orders':         ['scrape:order-amounts'],
  'returns':        ['scrape:returns'],
  'semi-ad':        ['scrape:semi-ad'],
  [DAILY_BACKFILL_MODULE_KEY]: ['scrape:sku-sales-daily'],
};

const REGION_ORDER = ['kjmh', 'global', 'eu', 'us', 'cn', 'pa', 'jp', 'mx'];
const KIND_ORDER = [
  'scrape:settlement',
  'scrape:settle-flow',
  'scrape:logistics-bill',
  'scrape:reverse-logistics-bill',
  'scrape:epr-goods-fee',
  'scrape:epr-package-fee',
  'scrape:epr-platform-fee',
  'scrape:violation-appeals',
  'scrape:sales-30d',
  'scrape:declared-price',
  'scrape:marketing-activity',
  'scrape:activity-data',
  'scrape:flux-analysis',
  'scrape:order-amounts',
  'scrape:returns',
  'scrape:semi-ad',
];

function moduleKinds(moduleKey, custody = activeCustody) {
  const spec = MODULE_TO_KINDS[moduleKey];
  if (!spec) return [];
  if (Array.isArray(spec)) return spec;
  return spec[custody] || spec.default || [];
}

function moduleKeyForKind(kind, custody = activeCustody) {
  const modules = MODULES_BY_CUSTODY[custody] || [];
  const hit = modules.find((m) => moduleKinds(m.key, custody).includes(kind));
  return hit?.key || null;
}

function taskRegionKey(task) {
  return task.payload?.region || task.payload?.site || '';
}

function taskProjectKey(task) {
  const payload = task?.payload || {};
  if (payload.settlementProjectKey) return String(payload.settlementProjectKey);
  const region = taskRegionKey(task);
  if (task.kind === 'scrape:settlement' && payload.drIndex != null) {
    const byDr = { 0: 'kjmh', 1: 'global', 2: 'eu', 3: 'us' };
    const r = byDr[Number(payload.drIndex)] || region;
    return r ? `account-${r}` : '';
  }
  if (task.kind === 'scrape:reverse-logistics-bill' && payload.sellerPortalBizType != null) {
    const suffix = Number(payload.sellerPortalBizType) === 3 ? 'temu' : 'merchant';
    return region ? `return-${suffix}-${region}` : '';
  }
  if (task.kind === 'scrape:epr-goods-fee' && region) return `epr-product-${region}`;
  if (task.kind === 'scrape:epr-package-fee' && region) return `epr-package-${region}`;
  if (task.kind === 'scrape:epr-platform-fee' && region) return `epr-service-${region}`;
  return '';
}

function taskRangeInfo(task) {
  const p = task?.payload || {};
  const from = p.dateFrom || p.startDate || p.orderCreateTimeStart || p.deductDateFrom || '';
  const to = p.dateTo || p.endDate || p.orderCreateTimeEnd || p.deductDateTo || from || '';
  const label = from && to ? `${from}~${to}` : '未指定时间范围';
  return {
    from,
    to,
    key: from || to ? `${from || '-'}..${to || '-'}` : 'unknown',
    label,
  };
}

function indexOrEnd(list, value) {
  const i = list.indexOf(value);
  return i >= 0 ? i : list.length;
}

function displayTaskName(task) {
  const base = KIND_LABELS[task.kind] || task.kind;
  const region = regionFromTask(task);
  return region && region !== '-' ? `${base}（${region}）` : base;
}

function settlementPath(path) {
  return `【${path}】`;
}

const SETTLEMENT_ACCOUNT_DR_INDEX = { kjmh: 0, global: 1, eu: 2, us: 3 };
const SETTLEMENT_EPR_KIND_BY_TYPE = {
  product: 'scrape:epr-goods-fee',
  package: 'scrape:epr-package-fee',
  service: 'scrape:epr-platform-fee',
};

const SETTLEMENT_REPORT_PROJECTS = [
  {
    key: 'account-kjmh',
    label: '账务明细（Temu卖家中心）',
    path: settlementPath('卖家履约中心/账户资金/对账中心/账务明细/导出：账务详情'),
    kind: 'scrape:settlement',
    region: 'kjmh',
    drIndex: SETTLEMENT_ACCOUNT_DR_INDEX.kjmh,
  },
  ...['global', 'eu', 'us'].flatMap((region) => {
    const label = REGION_LABEL[region];
    const base = [
      {
        key: `account-${region}`,
        label: `账务明细（${label}）`,
        path: settlementPath('卖家履约中心/账户资金/对账中心/账务明细/导出：账务详情'),
        kind: 'scrape:settlement',
        region,
        drIndex: SETTLEMENT_ACCOUNT_DR_INDEX[region],
      },
      {
        key: `shipping-label-${region}`,
        label: `发货面单费（${label}）`,
        path: settlementPath('Temu seller central/账户资金/发货面单费'),
        kind: 'scrape:logistics-bill',
        region,
      },
      {
        key: `return-merchant-${region}`,
        label: `退货面单费(退至商家仓)（${label}）`,
        path: settlementPath('Temu seller central/账户资金/退货面单费'),
        kind: 'scrape:reverse-logistics-bill',
        region,
        sellerPortalBizType: 2,
      },
      {
        key: `return-temu-${region}`,
        label: `退货面单费(退至Temu仓)（${label}）`,
        path: settlementPath('Temu seller central/账户资金/退货面单费'),
        kind: 'scrape:reverse-logistics-bill',
        region,
        sellerPortalBizType: 3,
      },
    ];
    if (region === 'us') return base;
    const eprKind = (type) => region === 'eu' ? SETTLEMENT_EPR_KIND_BY_TYPE[type] : null;
    const eprReserved = region !== 'eu';
    return base.concat([
      {
        key: `epr-product-${region}`,
        label: `商品环保费（${label}）`,
        path: settlementPath('Temu seller central/账户资金/EPR费用管理'),
        kind: eprKind('product'),
        region,
        eprFeeType: 'product',
        reserved: eprReserved,
        reservedReason: eprReserved ? '待抓包' : undefined,
      },
      {
        key: `epr-package-${region}`,
        label: `物流包装环保费（${label}）`,
        path: settlementPath('Temu seller central/账户资金/EPR费用管理'),
        kind: eprKind('package'),
        region,
        eprFeeType: 'package',
        reserved: eprReserved,
        reservedReason: eprReserved ? '待抓包' : undefined,
      },
      {
        key: `epr-service-${region}`,
        label: `代付服务费（${label}）`,
        path: settlementPath('Temu seller central/账户资金/EPR费用管理'),
        kind: eprKind('service'),
        region,
        eprFeeType: 'service',
        reserved: eprReserved,
        reservedReason: eprReserved ? '待抓包' : undefined,
      },
    ]);
  }),
];

// 手动派单的区域扇出:endpoint 带 -us/-eu 子域的 kind 要分 3 区各采一次
// (没卖货的区域返 0 行无害,与后端定时口径一致);单一固定域名(ads.temu.com / 主域)
// 的 kind 不分区,只派 1 次(用右上角下拉的 region)。
const KIND_REGIONS = {
  'scrape:flux-analysis':          ['global', 'us', 'eu'],
  'scrape:order-amounts':          ['global', 'us', 'eu'],
  'scrape:returns':                ['global', 'us', 'eu'],
  'scrape:settle-flow':            ['global', 'us', 'eu'],
  'scrape:logistics-bill':         ['global', 'us', 'eu'],
  'scrape:reverse-logistics-bill': ['global', 'us', 'eu'],
  'scrape:violation-appeals':      ['global', 'us', 'eu'],
};

const MANUAL_MAX_RANGE_DAYS = 31;

// 手动获取里需要「时间范围」参数的模块 —— 只有结算报表家族真正按 deductTime /
// orderCreateTime 窗口采集;其余采集都是固定窗口(sales=timeType、returns=windowDays、
// semi-ad=windowDays、orders=maxPages 翻页、flux/declare/activity/marketing 无日期),
// 选了时间也无视。报告类型下拉直接复用左侧全部采集模块(见 getManualReportTypes)。
// 模块级:需要用户选时间范围的模块 —— 结算报表家族 + 逐日销量回填(按区间取 querySkuSalesNumber)。
const MODULE_NEEDS_DATE = new Set([SETTLEMENT_REPORT_MODULE_KEY, DAILY_BACKFILL_MODULE_KEY]);

// kind 级:只有这些 kind 才往 payload 塞日期窗口,其它 kind 不塞(固定窗口,传了也被忽略)。
const KIND_NEEDS_DATE = new Set([
  ...FULL_SETTLEMENT_REPORT_KINDS,
  ...SEMI_SETTLEMENT_REPORT_KINDS,
  'scrape:sku-sales-daily',   // 逐日销量回填:querySkuSalesNumber 需 startDate/endDate
]);

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
    refreshShopViews();
    renderModules();    // ★ 左侧计数依赖 _apiTasks/_apiShops,初次拉到后必须重渲染
    renderProgress();
  }
}

// custodyFilter: 'full' / 'semi' 只取该托管;null = 全部托管(选店弹窗用)。
function buildShopsFromApi(custodyFilter = activeCustody) {
  return _apiShops
    .filter((s) => s.platform === 'temu' && (custodyFilter == null || s.shopType === custodyFilter))
    .map((s) => {
      // 按 kind + region + 时间范围合并:同一批同类任务只留最新一条 + 执行时间。
      // _apiTasks 已按 createdAt desc(后端默认),所以第一遇到的就是最新。
      const byTaskKey = new Map();
      for (const t of _apiTasks) {
        if (t.shopId !== s.id) continue;
        const range = taskRangeInfo(t);
        const key = `${t.kind}::${taskRegionKey(t)}::${taskProjectKey(t)}::${range.key}`;
        if (!byTaskKey.has(key)) byTaskKey.set(key, t);
      }
      const tasks = Array.from(byTaskKey.values()).map((t) => {
        const ui = STATUS_TO_UI[t.status] || STATUS_TO_UI.pending;
        const range = taskRangeInfo(t);
        return {
          taskId: t.id,
          kind: t.kind,
          regionKey: taskRegionKey(t),
          projectKey: taskProjectKey(t),
          drIndex: t.payload?.drIndex,
          sellerPortalBizType: t.payload?.sellerPortalBizType,
          eprFeeType: t.payload?.eprFeeType,
          rangeKey: range.key,
          rangeLabel: range.label,
          dateFrom: range.from,
          dateTo: range.to,
          name: displayTaskName(t),
          region: regionFromTask(t),
          status: ui.cls,
          result: ui.label,
          execAt: t.completedAt || t.claimedAt || t.createdAt || null,
          errorMessage: t.errorMessage,
        };
      }).sort((a, b) => {
        const regionDelta = indexOrEnd(REGION_ORDER, a.regionKey) - indexOrEnd(REGION_ORDER, b.regionKey);
        if (regionDelta !== 0) return regionDelta;
        return indexOrEnd(KIND_ORDER, a.kind) - indexOrEnd(KIND_ORDER, b.kind);
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

function matchesSettlementProject(project, task) {
  if (!project.kind || task.kind !== project.kind) return false;
  if (task.projectKey) return task.projectKey === project.key;
  if (project.drIndex != null && task.drIndex != null && Number(task.drIndex) !== Number(project.drIndex)) return false;
  if (project.sellerPortalBizType != null && task.sellerPortalBizType != null && Number(task.sellerPortalBizType) !== Number(project.sellerPortalBizType)) return false;
  if (project.eprFeeType && task.eprFeeType && task.eprFeeType !== project.eprFeeType) return false;
  if (project.matchRegions) return project.matchRegions.includes(task.regionKey || '');
  if (project.region) return task.regionKey === project.region;
  return true;
}

function buildSettlementProjectTasks(shop) {
  const fallbackRange = { key: 'unknown', label: '未指定时间范围', from: '', to: '' };
  return buildSettlementProjectTasksForRange(shop, fallbackRange);
}

function aggregateStatus(tasks) {
  if (!tasks.length) return { status: 'pending', result: '待获取', execAt: null, errorMessage: null };
  const s = summary(tasks);
  const execAtList = tasks
    .map((task) => task.execAt)
    .filter(Boolean)
    .sort();
  const execAt = execAtList.length ? execAtList[execAtList.length - 1] : null;
  const failed = tasks.find((task) => task.status === 'failed');
  return {
    status: s.cls,
    result: s.text,
    execAt,
    errorMessage: failed?.errorMessage || null,
  };
}

function buildSettlementProjectTasksForRange(shop, range) {
  const rangeTasks = shop.tasks.filter((task) => task.rangeKey === range.key && SEMI_SETTLEMENT_REPORT_KINDS.includes(task.kind));
  return SETTLEMENT_REPORT_PROJECTS.map((project) => {
    const realTask = rangeTasks.find((task) => matchesSettlementProject(project, task));
    return {
      taskId: realTask?.taskId || null,
      kind: project.kind,
      rangeKey: range.key,
      rangeLabel: range.label,
      regionKey: project.region || '',
      projectKey: project.key,
      projectLabel: project.label,
      projectPath: project.path,
      reserved: project.reserved === true,
      name: `${project.label} ${project.path}`,
      region: project.region ? (REGION_LABEL[project.region] || project.region) : '-',
      status: realTask?.status || 'pending',
      result: realTask?.result || project.reservedReason || '待获取',
      execAt: realTask?.execAt || null,
      errorMessage: realTask?.errorMessage || null,
    };
  });
}

function buildSettlementReportBatches(shop) {
  const byRange = new Map();
  for (const task of shop.tasks) {
    if (!SEMI_SETTLEMENT_REPORT_KINDS.includes(task.kind)) continue;
    if (!byRange.has(task.rangeKey)) {
      byRange.set(task.rangeKey, {
        key: task.rangeKey,
        label: task.rangeLabel,
        from: task.dateFrom,
        to: task.dateTo,
      });
    }
  }
  return Array.from(byRange.values())
    .sort((a, b) => String(b.from || b.to || '').localeCompare(String(a.from || a.to || '')))
    .map((range) => {
      const tasks = buildSettlementProjectTasksForRange(shop, range);
      return {
        id: `${shop.id}::${range.key}`,
        shopId: shop.id,
        shopName: shop.name,
        range,
        tasks,
        summary: summary(tasks),
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
    case '15d':   return { startDate: back(14), endDate: end };
    case '30d':   return { startDate: back(29), endDate: end };
    case '90d':   return { startDate: back(89), endDate: end };
    default:      return { startDate: back(6),  endDate: end };  // safe default
  }
}

async function createTasksForSelected(options = {}) {
  if (!cfg.apiUrl) throw new Error('请先配置 ERP API 地址');
  const moduleKeys = Array.isArray(options.moduleKeys) && options.moduleKeys.length ? options.moduleKeys : (activeModule ? [activeModule] : []);
  const validModuleKeys = moduleKeys.filter((m) => moduleKinds(m).length > 0);
  if (validModuleKeys.length === 0) throw new Error('请至少选择一个报告类型');

  // 店铺列表还没从 ERP 拉回来(网络慢/未连上)→ 给出明确提示,别误导成"未绑定/scope 问题"。
  // (历史坑:_apiShops 为空时直接报"没有可派单的店铺",让人误查绑定/scope,实则是列表没加载。)
  if (_apiShops.length === 0) {
    throw new Error('店铺列表还没加载出来(ERP 网络慢或未连上),请等面板里出现店铺后再获取');
  }

  // 决定派到哪些店铺:当前 custody ∩ 本机 scope ∩ active(与主面板显示一致)。
  // selectedShops 跨 full/semi,这里叠加 custody 过滤,避免把全托模块派给半托店。
  const targetIds = _apiShops
    .filter((s) => s.platform === 'temu'
      && s.shopType === activeCustody
      && s.status === 'active'
      && (!options.shopId || s.id === options.shopId)
      && (selectedShops === null || selectedShops.includes(s.id)))
    .map((s) => s.id);
  if (targetIds.length === 0) throw new Error('当前没有可派单的店铺(检查右上角店铺范围 / 是否在 ERP 绑定)');

  const region = options.region || $('#region')?.value || 'global';
  const dates = options.dates || dateRangeToDates('7d');
  const shopById = new Map(_apiShops.map((s) => [s.id, s]));

  const tasks = [];
  for (const shopId of targetIds) {
    const shop = shopById.get(shopId);
    if (!shop) {
      console.warn('[popup] shop not in _apiShops, skip:', shopId);
      continue;
    }
    for (const moduleKey of validModuleKeys) {
      if (moduleKey === SETTLEMENT_REPORT_MODULE_KEY) {
        const created = await createSettlementReportTasks({ shop, dates, region, custody: activeCustody });
        tasks.push(...created);
      } else {
        const created = await createAgentTasksForKinds({ shop, kinds: moduleKinds(moduleKey), dates, region });
        tasks.push(...created);
      }
    }
  }
  return tasks;
}

async function createAgentTask({ shop, kind, region, dates, priority = 5, extraPayload = {} }) {
  // 仅结算报表家族(KIND_NEEDS_DATE)的 kind 才带时间窗口;其它采集固定窗口,不塞日期。
  const datePayload = (dates && KIND_NEEDS_DATE.has(kind))
    ? { startDate: dates.startDate, endDate: dates.endDate, dateFrom: dates.startDate, dateTo: dates.endDate }
    : {};
  return apiFetch('/api/agent/tasks', {
    method: 'POST',
    body: JSON.stringify({
      shopId: shop.id,
      kind,
      payload: {
        mallId: shop.platformShopId,
        siteType: shop.shopType,
        region,
        ...datePayload,
        ...extraPayload,
      },
      priority,
    }),
  });
}

function settlementProjectPayload(project) {
  const payload = {
    settlementProjectKey: project.key,
    settlementProjectLabel: project.label,
  };
  if (project.batchIndex != null) payload.settlementBatchIndex = project.batchIndex;
  if (project.drIndex != null) payload.drIndex = project.drIndex;
  if (project.sellerPortalBizType != null) payload.sellerPortalBizType = project.sellerPortalBizType;
  if (project.eprFeeType) payload.eprFeeType = project.eprFeeType;
  return payload;
}

async function createSettlementProjectTasks({ shop, dates, priority = 5 }) {
  const tasks = [];
  const settlementBatchKey = `${shop.id}:${dates.startDate}:${dates.endDate}:semi-settlement-report`;
  for (const [batchIndex, rawProject] of SETTLEMENT_REPORT_PROJECTS.entries()) {
    const project = { ...rawProject, batchIndex };
    if (!project.kind || project.reserved) continue;
    tasks.push(await createAgentTask({
      shop,
      kind: project.kind,
      region: project.region || 'global',
      dates,
      priority,
      extraPayload: {
        ...settlementProjectPayload(project),
        settlementBatchKey,
      },
    }));
  }
  return tasks;
}

async function createAgentTasksForKinds({ shop, kinds, dates, region, priority = 5 }) {
  const tasks = [];
  for (const kind of kinds) {
    // 区域相关 kind(endpoint 有 -us/-eu 子域)扇出全球/美国/欧区各派一次;
    // 不分区的 kind 用右上角下拉选的 region 派 1 次。
    const regions = KIND_REGIONS[kind] || [region];
    for (const rgn of regions) {
      tasks.push(await createAgentTask({ shop, kind, region: rgn, dates, priority }));
    }
  }
  return tasks;
}

async function createSettlementReportTasks({ shop, dates, region, custody }) {
  if (USE_RESERVED_SETTLEMENT_REPORT_API) {
    const resp = await apiFetch(SETTLEMENT_REPORT_TASK_API, {
      method: 'POST',
      body: JSON.stringify({
        shopId: shop.id,
        mallId: shop.platformShopId,
        custody,
        region,
        startDate: dates.startDate,
        endDate: dates.endDate,
      }),
    });
    return Array.isArray(resp) ? resp : (resp?.tasks || resp?.items || []);
  }
  if (custody === 'semi') {
    return createSettlementProjectTasks({ shop, dates });
  }
  return createAgentTasksForKinds({
    shop,
    kinds: moduleKinds(SETTLEMENT_REPORT_MODULE_KEY, custody),
    dates,
    region,
  });
}

// 左上角显示 ERP 登录账号(手机号)—— 与 Temu 平台账号无关,暂为写死/配置值。
// TODO: 权限系统上线后改成真实登录账号。
const DEFAULT_ERP_PHONE = '13094411223';
function refreshAccountChip() {
  const phone = cfg.erpAccountPhone || DEFAULT_ERP_PHONE;
  const el = $('#account-name');
  el.textContent = phone;
  el.title = '点击重新匹配账号 / 授权';
  el.style.cursor = 'pointer';
}

// ──────────────────────────────────────────────────────────────
// 1.5 账号匹配 + 区域授权 引导(纯自动 scope)
//   step1 账号匹配:SW 抓 Temu userInfo(userId+mallIdList,最多重试3次)
//                  → mallIdList 查 ERP /api/shops 匹配已绑店 → 写 selectedShopIds
//   step2-4 区域授权:SW 逐区域 SSO(复用 AGENT_RECHECK_LOGIN),进度事件驱动 stepper
// ──────────────────────────────────────────────────────────────
let _pollStarted = false;
const ONBOARD_REGION_STEPS = ['global', 'eu', 'us'];

function enterPanel() {
  const ov = document.getElementById('onboard-view'); if (ov) ov.hidden = true;
  const pa = document.getElementById('progress-area'); if (pa) pa.hidden = false;
  const fb = document.getElementById('btn-fetch'); if (fb) fb.disabled = false;
  refreshFromApi();
  if (!_pollStarted) { _pollStarted = true; setInterval(refreshFromApi, 5000); }
}

function showOnboard() {
  const ov = document.getElementById('onboard-view'); if (ov) ov.hidden = false;
  const pa = document.getElementById('progress-area'); if (pa) pa.hidden = true;
  const es = document.getElementById('empty-state'); if (es) es.hidden = true;
  const fb = document.getElementById('btn-fetch'); if (fb) fb.disabled = true; // 引导期间禁手动获取
}

function setStep(step, status, label) {
  const icon = document.getElementById(`oi-${step}`);
  if (icon) icon.className = `onboard-icon ${status}`; // idle 显序号,其余靠 CSS(spinner/✓/✕)
  if (label != null) { const lab = document.getElementById(`ol-${step}`); if (lab) lab.textContent = label; }
}

function resetOnboardSteps() {
  setStep('match', 'running', '账号匹配中…');
  setStep('global', 'idle', '等待全球授权');
  setStep('eu', 'idle', '等待欧区授权');
  setStep('us', 'idle', '等待美国授权');
}

function tipDetecting() {
  return `<div class="tip-title">在线检测中(预计需要 90 秒),请耐心等待</div>
    请登录到 Temu 后台 <a href="https://seller.kuajingmaihuo.com" target="_blank" rel="noopener">卖家中心</a>;<br/>
    请保持 Temu 后台和插件 <span class="tip-emph">同时登录在线</span>;<br/>
    自动打开的页签是插件在采集,<span class="tip-emph">无需操作或关闭</span>。`;
}
function tipFailNotLoggedIn() {
  return `<div class="tip-title err">未检测到 Temu 卖家中心在线,可尝试如下操作:</div>
    请先登录到 Temu 后台:<a href="https://seller.kuajingmaihuo.com" target="_blank" rel="noopener">https://seller.kuajingmaihuo.com</a><br/>
    登录后再点击下方按钮,重新检测在线状态<br/>
    <span class="onboard-refresh" id="onboard-refresh-btn">立即刷新</span>`;
}
function tipFailNoBinding() {
  return `<div class="tip-title err">此账号下暂无已绑定的店铺</div>
    请先在 ERP 后台绑定该账号下的 Temu 店铺,再重新匹配<br/>
    <span class="onboard-refresh" id="onboard-refresh-btn">立即刷新</span>`;
}
function tipFailApi() {
  return `<div class="tip-title err">连接 ERP 服务失败</div>
    请检查网络 / Tailscale 是否在线,再重试<br/>
    <span class="onboard-refresh" id="onboard-refresh-btn">立即刷新</span>`;
}
function setOnboardTip(html) {
  const tip = document.getElementById('onboard-tip');
  if (!tip) return;
  tip.innerHTML = html;
  const btn = document.getElementById('onboard-refresh-btn');
  if (btn) btn.addEventListener('click', runOnboard);
}

// SW 进度事件 → 实时驱动 stepper
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'AGENT_ONBOARD_PROGRESS') return;
    if (msg.step === 'match') {
      // match 的 ok/fail 由 runOnboard 在 ERP 匹配后决定,这里只反映重试转圈
      if (msg.status === 'running') {
        setStep('match', 'running', msg.attempt > 1 ? `账号匹配中…(重试 ${msg.attempt}/3)` : '账号匹配中…');
      }
    } else if (ONBOARD_REGION_STEPS.includes(msg.step)) {
      setStep(msg.step, msg.status === 'running' ? 'running' : (msg.status === 'ok' ? 'ok' : 'fail'));
    }
  });
}

function swSend(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (r) => { void chrome.runtime.lastError; resolve(r); });
    } catch { resolve(null); }
  });
}

// mallIdList ∩ ERP 已绑店 → 匹配到的 ERP shopId 数组。API 不通则抛错(上层区分提示)。
async function matchShopsToErp(mallIdList) {
  const v = await apiFetch('/api/shops');
  const list = Array.isArray(v) ? v : (v?.items || []);
  _apiShops = list;
  const want = new Set((mallIdList || []).map(String));
  return list
    .filter((s) => s.platform === 'temu' && want.has(String(s.platformShopId)))
    .map((s) => s.id);
}

// 会话级"本次已自动匹配且失败"标记(chrome.storage.session,浏览器重启自动清)。
// scope 为空时:本会话首次打开自动匹配一次;失败后下次再开 popup 不再自动重跑,
// 停在失败页等用户手动「立即刷新」—— 避免没绑店的客户端反复弹 kjmh tab 影响操作。
const ONBOARD_FAIL_TIPS = { login: tipFailNotLoggedIn, binding: tipFailNoBinding, api: tipFailApi };
function readOnboardFailKind() {
  return new Promise((resolve) => {
    try { CHROME.storage.session.get(['onboardFailKind'], (r) => { void chrome.runtime?.lastError; resolve(r?.onboardFailKind || null); }); }
    catch { resolve(null); }
  });
}
function markOnboardFail(kind) { try { CHROME.storage.session.set({ onboardFailKind: kind }); } catch {} }
function clearOnboardFail() { try { CHROME.storage.session.remove('onboardFailKind'); } catch {} }

async function runOnboard() {
  clearOnboardFail();   // 新一轮尝试(开屏首次 / 手动刷新 / 点账号名),先清旧失败标记
  showOnboard();
  resetOnboardSteps();
  setOnboardTip(tipDetecting());

  // step1:Temu 账号匹配(SW 内含 3 次重试)
  const m = await swSend('AGENT_ONBOARD_MATCH');
  if (!m?.ok) {
    setStep('match', 'fail', '账号匹配失败');
    setOnboardTip(tipFailNotLoggedIn());
    markOnboardFail('login');
    return;
  }

  // step1b:mallIdList 匹配 ERP 已绑店
  setStep('match', 'running', '匹配店铺中…');
  let matched;
  try {
    matched = await matchShopsToErp(m.mallIdList);
  } catch (e) {
    console.warn('[onboard] /api/shops 失败:', e?.message);
    setStep('match', 'fail', '账号匹配失败');
    setOnboardTip(tipFailApi());
    markOnboardFail('api');
    return;
  }
  if (!matched.length) {
    setStep('match', 'fail', '账号匹配失败');
    setOnboardTip(tipFailNoBinding());
    markOnboardFail('binding');
    return;
  }

  // 写 scope(popup 面板 + SW claim 共用)
  selectedShops = matched;
  CHROME.storage.local.set({ selectedShopIds: matched });
  clearOnboardFail();   // 匹配成功,清失败标记
  setStep('match', 'ok', `已匹配 ${matched.length} 家店`);

  // step2-4:区域授权(SW 逐区域 SSO,进度事件已驱动 stepper;最终 results 兜底收尾)
  setOnboardTip(tipDetecting());
  const res = await swSend('AGENT_RECHECK_LOGIN');
  const byKey = {};
  for (const r of (res?.results || [])) byKey[r.key] = r.status;
  for (const step of ONBOARD_REGION_STEPS) {
    if (byKey[step]) setStep(step, byKey[step] === 'ok' ? 'ok' : 'fail');
  }

  // 完成 → 进入面板(只显示本机匹配到的店)
  setTimeout(enterPanel, 600);
}

// ──────────────────────────────────────────────────────────────
// 2. 模块定义 + 进度渲染
//    真实数据从 background message 来：{ shops: [...], modules: [...] }
// ──────────────────────────────────────────────────────────────
// 模块定义只保留 key + label;count/total 由 computeModuleCounts() 按真实任务算
const MODULES_BY_CUSTODY = {
  full: [
    { key: 'sales-30d',     label: '获取近 30 天销量' },
    { key: 'settle-report', label: '获取结算报表' },
    { key: 'declare-price', label: '获取申报价格' },
    { key: 'activity-data', label: '获取活动数据' },
    { key: 'marketing-act', label: '获取营销活动' },
    { key: 'flux-analysis', label: '获取流量分析' },
  ],
  semi: [
    { key: 'sales-30d',              label: '获取近 30 天销量' },
    { key: 'declare-price',          label: '获取申报价格' },
    { key: 'marketing-act',          label: '获取营销活动' },
    { key: 'activity-data',          label: '获取活动数据' },
    { key: 'flux-analysis',          label: '获取流量分析' },
    { key: 'orders',                 label: '获取订单数据' },
    { key: 'returns',                label: '获取退货退款' },
    { key: 'semi-ad',                label: '获取广告数据' },
    { key: 'settle-report',          label: '获取结算报表' },
  ],
};

// 按 module key → 这一类下 (成功数 / 总数);只统计当前 custody 下的店铺
function computeModuleCounts() {
  const wanted = activeCustody === 'full' ? 'full' : 'semi';
  // 与主面板一致:只统计本机 scope(selectedShops)内的店。null=全部。
  const scopedShops = _apiShops
    .filter((s) => s.platform === 'temu' && s.shopType === wanted)
    .filter((s) => selectedShops === null || selectedShops.includes(s.id));
  const shopIds = new Set(scopedShops.map((s) => s.id));
  const counts = {};

  if (wanted === 'semi') {
    for (const shop of buildShopsFromApi('semi').filter((s) => shopIds.has(s.id))) {
      const bucket = (counts[SETTLEMENT_REPORT_MODULE_KEY] ||= { keys: new Set(), succ: new Set() });
      for (const batch of buildSettlementReportBatches(shop)) {
        const dedupeKey = batch.id;
        bucket.keys.add(dedupeKey);
        if (batch.summary.cls === 'ok') bucket.succ.add(dedupeKey);
      }
    }
  }

  const projectBackedKinds = new Set(
    wanted === 'semi'
      ? SETTLEMENT_REPORT_PROJECTS.map((p) => p.kind).filter(Boolean)
      : [],
  );
  for (const t of _apiTasks) {
    if (!shopIds.has(t.shopId)) continue;
    if (wanted === 'semi' && projectBackedKinds.has(t.kind)) continue;
    const moduleKey = moduleKeyForKind(t.kind, wanted);
    if (!moduleKey) continue;
    // 按 (shopId, kind, region, 时间范围) 合并 — 同一批任务多次重试只算 1
    const bucket = (counts[moduleKey] ||= { keys: new Set(), succ: new Set() });
    const dedupeKey = `${t.shopId}::${t.kind}::${taskRegionKey(t)}::${taskProjectKey(t)}::${taskRangeInfo(t).key}`;
    bucket.keys.add(dedupeKey);
    if (t.status === 'success') bucket.succ.add(dedupeKey);
  }
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, { count: v.succ.size, total: v.keys.size }]),
  );
}

let activeCustody = 'full';
let activeModule = null;
const expandedSettlementBatches = new Set();
const collapsedSettlementBatches = new Set();

function ensureActiveModule() {
  const list = MODULES_BY_CUSTODY[activeCustody] || [];
  if (!list.some((m) => m.key === activeModule)) activeModule = list[0]?.key ?? null;
}

function renderModules() {
  const list = MODULES_BY_CUSTODY[activeCustody];
  ensureActiveModule();
  const counts = computeModuleCounts();
  const ul = $('#module-list');
  ul.innerHTML = '';
  for (const m of list) {
    const li = document.createElement('li');
    li.className = 'module-item' + (m.key === activeModule ? ' active' : '');
    li.dataset.key = m.key;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', m.key === activeModule ? 'true' : 'false');
    const c = counts[m.key];
    const countText = c ? `${c.count}/${c.total}` : '';
    li.innerHTML = `
      <span class="module-label">${m.label}</span>
      <span class="module-count">${countText}</span>
    `;
    const selectModule = () => {
      activeModule = m.key;
      renderModules();
      renderProgress();
      updateFetchButton();
    };
    li.addEventListener('click', selectModule);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectModule();
      }
    });
    ul.appendChild(li);
  }
  updateFetchButton();
}

// 手动获取按钮文案 / 状态 — 当前左侧高亮项作为默认报告类型
function updateFetchButton() {
  const btn = document.getElementById('btn-fetch');
  if (!btn) return;
  if (!activeModule) {
    btn.disabled = true;
    btn.textContent = '请选择报告类型';
  } else {
    btn.disabled = false;
    btn.textContent = '手动获取';
  }
}

// ──────────────────────────────────────────────────────────────
// 3. 进度区（演示数据）
//    每店铺 -> 多任务，每任务有 status: ok/running/failed/pending
// ──────────────────────────────────────────────────────────────
let allShops = [];   // 当前 custody 下全部店(来自 /api/shops;未连上 ERP / 未匹配时为空)
let shops = allShops;                    // allShops 再按本机 scope 过滤(主面板 + 领单源)

// 按 selectedShops(per-browser scope,账号匹配自动写入)过滤出本机负责的店。null=全部。
// 注:selectedShops 跨 full/semi —— 当前 custody 视图里对不上的 ID 自然被滤掉。
function applyShopScope(list) {
  if (selectedShops === null) return list;
  return list.filter((s) => selectedShops.includes(s.id));
}
// 重建视图:allShops(当前 custody 全部)→ shops(本机已匹配)。未连上 ERP 时为空(走空状态)。
function refreshShopViews() {
  allShops = _connected ? buildShopsFromApi(activeCustody) : [];
  shops = applyShopScope(allShops);
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTaskNameHtml(task) {
  if (task.projectLabel) {
    return `
      <span class="task-main">${escapeHtml(task.projectLabel)}</span>
      <span class="task-path">${escapeHtml(task.projectPath || '')}</span>
    `;
  }
  return escapeHtml(task.name);
}

function isSettlementBatchExpanded(batch, index) {
  if (expandedSettlementBatches.has(batch.id)) return true;
  if (collapsedSettlementBatches.has(batch.id)) return false;
  return index === 0;
}

function bindRetryButtons(root) {
  root.querySelectorAll('.task-retry').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      if (!taskId) return;
      btn.classList.add('busy');
      btn.textContent = '↻ 重试中…';
      try {
        // 通过 raw rawTask 找到原 kind/payload 重新建一个
        const orig = _apiTasks.find((t) => t.id === taskId);
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
}

function renderTaskRows(tasks) {
  return tasks.map((t) => {
    const i = taskIcon(t.status);
    const retryBtn = t.status === 'failed' && t.taskId
      ? `<button class="task-retry" data-task-id="${escapeHtml(t.taskId)}" title="重新执行此任务">↻ 重试</button>`
      : '';
    const ts = fmtExecAt(t.execAt);
    return `
      <div class="task-row">
        <span class="task-icon ${i.cls}">${i.glyph}</span>
        <span class="task-name" title="${escapeHtml(t.name)}">${renderTaskNameHtml(t)}</span>
        <span class="task-result ${i.cls}">${escapeHtml(t.result)}</span>
        <span class="task-exec-at" title="${escapeHtml(t.execAt || '')}">${escapeHtml(ts)}</span>
        ${retryBtn}
      </div>
    `;
  }).join('');
}

function renderSettlementReportProgress(area, onlyFailed) {
  let totalRendered = 0;
  for (const shop of shops) {
    const batches = buildSettlementReportBatches(shop);
    batches.forEach((batch, index) => {
      const visibleTasks = onlyFailed
        ? batch.tasks.filter((task) => task.status === 'failed')
        : batch.tasks;
      if (onlyFailed && visibleTasks.length === 0) return;

      const s = batch.summary;
      const pct = s.total > 0 ? Math.round((s.ok / s.total) * 100) : 0;
      const expanded = isSettlementBatchExpanded(batch, index);
      const block = document.createElement('div');
      block.className = 'shop-block settlement-batch';
      block.innerHTML = `
        <div class="shop-head ${expanded ? 'expanded' : ''}">
          <span class="shop-caret">▶</span>
          <span class="shop-status ${s.cls}">${s.text}</span>
          <span class="shop-name">${escapeHtml(batch.shopName)} (${escapeHtml(batch.range.label)})</span>
          <span class="shop-progress-bar"><span class="shop-progress-bar-fill" style="width:${pct}%"></span></span>
          <span class="shop-progress-text">${s.total ? `${s.ok}/${s.total}` : ''}</span>
        </div>
        ${expanded ? `<div class="task-list">${renderTaskRows(visibleTasks)}</div>` : ''}
      `;
      block.querySelector('.shop-head').addEventListener('click', () => {
        if (isSettlementBatchExpanded(batch, index)) {
          collapsedSettlementBatches.add(batch.id);
          expandedSettlementBatches.delete(batch.id);
        } else {
          expandedSettlementBatches.add(batch.id);
          collapsedSettlementBatches.delete(batch.id);
        }
        renderProgress();
      });
      bindRetryButtons(block);
      area.appendChild(block);
      totalRendered++;
    });
  }
  return totalRendered;
}

function renderProgress() {
  const area = $('#progress-area');
  area.innerHTML = '';
  const onlyFailed = $('#only-failed').checked;
  // 拿到当前选中模块对应的 kind 集合（activeModule 是 module key）
  const filterKinds = activeModule ? moduleKinds(activeModule) : [];

  if (activeModule === SETTLEMENT_REPORT_MODULE_KEY && activeCustody === 'semi') {
    const totalRendered = renderSettlementReportProgress(area, onlyFailed);
    $('#empty-state').hidden = totalRendered > 0;
    area.hidden = totalRendered === 0;
    return;
  }

  let totalRendered = 0;
  for (const shop of shops) {
    let tasksToShow = shop.tasks;
    // 模块过滤（点左侧某个模块 → 只看这个模块的任务）
    if (filterKinds.length) {
      tasksToShow = tasksToShow.filter((t) => filterKinds.includes(t.kind));
    }
    if (onlyFailed) tasksToShow = tasksToShow.filter((t) => t.status === 'failed');
    if ((filterKinds.length || onlyFailed) && tasksToShow.length === 0) continue;

    const block = document.createElement('div');
    block.className = 'shop-block';
    // ★ 用 tasksToShow 而非 shop.tasks — 否则用户筛选某模块时
    //   header 状态会汇总全量任务的失败(跟可见行不一致,出现"1 条成功 / 部分失败"的歧义)
    const s = summary(tasksToShow);
    const pct = s.total > 0 ? Math.round((s.ok / s.total) * 100) : 0;

    block.innerHTML = `
      <div class="shop-head ${shop.expanded ? 'expanded' : ''}">
        <span class="shop-caret">▶</span>
        <span class="shop-status ${s.cls}">${s.text}</span>
        <span class="shop-name">${shop.name}</span>
        <span class="shop-progress-bar"><span class="shop-progress-bar-fill" style="width:${pct}%"></span></span>
        <span class="shop-progress-text">${s.total ? `${s.ok}/${s.total}` : ''}</span>
      </div>
      ${shop.expanded ? `
        <div class="task-list">
          ${renderTaskRows(tasksToShow)}
        </div>
      ` : ''}
    `;
    block.querySelector('.shop-head').addEventListener('click', () => {
      shop.expanded = !shop.expanded;
      renderProgress();
    });
    bindRetryButtons(block);
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
  // 用真实数据重建视图(未连上 ERP 时为空)。
  // 不再重置 selectedShops —— 它是跨 full/semi 的持久 scope,对不上的 ID 会被 applyShopScope 自然滤掉。
  refreshShopViews();
  renderModules();
  renderProgress();
  CHROME.storage.local.set({ custody: c });
}
$$('.custody-tab').forEach((b) => b.addEventListener('click', () => selectCustody(b.dataset.custody)));

// ──────────────────────────────────────────────────────────────
// 5. 操作按钮
// ──────────────────────────────────────────────────────────────
function getManualReportTypes() {
  // 报告类型 = 左侧全部采集类型(与 MODULES_BY_CUSTODY 一致);标签去掉「获取」前缀更像报告名
  const list = MODULES_BY_CUSTODY[activeCustody] || MODULES_BY_CUSTODY.full;
  const types = list.map((m) => ({ key: m.key, label: m.label.replace(/^获取\s*/, '') }));
  // 手动专属:逐日销量按区间回填(全托)。日常已由「近30天销量」合并采集;此项用于补任意历史区间。
  if (activeCustody === 'full') {
    types.push({ key: DAILY_BACKFILL_MODULE_KEY, label: 'SKU每日销量(按区间回填)' });
  }
  return types;
}

function manualSelectionNeedsDate() {
  return selectedManualModuleKeys().some((k) => MODULE_NEEDS_DATE.has(k));
}

// 根据所选报告类型是否需要时间,启用/置灰时间范围控件
function updateManualDateState() {
  const needsDate = manualSelectionNeedsDate();
  const row = $('#manual-date-row');
  if (row) row.classList.toggle('manual-date-disabled', !needsDate);
  ['manual-date-from', 'manual-date-to'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.disabled = !needsDate;
  });
  $$('.manual-shortcut').forEach((b) => { b.disabled = !needsDate; });
  const hint = $('#manual-date-need-hint');
  if (hint) hint.hidden = needsDate;
}

function getManualTargetShops() {
  return _apiShops.filter((s) => s.platform === 'temu'
    && s.shopType === activeCustody
    && s.status === 'active'
    && (selectedShops === null || selectedShops.includes(s.id)));
}

function setManualError(message = '') {
  const el = $('#manual-fetch-error');
  if (el) el.textContent = message;
}

function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function manualRangeDays(from, to) {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

function setManualDateRange(rangeKey) {
  const dates = dateRangeToDates(rangeKey);
  $('#manual-date-from').value = dates.startDate;
  $('#manual-date-to').value = dates.endDate;
  setManualError('');
}

function selectedManualModuleKeys() {
  return $$('#manual-report-types input[type="checkbox"]:checked').map((input) => input.value);
}

function validateManualFetch() {
  if (selectedManualModuleKeys().length === 0) return '请至少选择一个报告类型';
  if (!manualSelectionNeedsDate()) return '';   // 所选类型都不需要时间 → 不校验日期(忽略时间范围)
  const from = $('#manual-date-from').value;
  const to = $('#manual-date-to').value;
  if (!from || !to) return '请选择时间范围';
  const days = manualRangeDays(from, to);
  if (days == null) return '时间范围格式不正确';
  if (days <= 0) return '开始日期不能晚于结束日期';
  if (days > MANUAL_MAX_RANGE_DAYS) return '单次时间范围不能超过 31 天';
  return '';
}

function openManualFetchModal() {
  ensureActiveModule();
  const shops = getManualTargetShops();
  const shopSelect = $('#manual-shop');
  shopSelect.innerHTML = [
    '<option value="">全部可派店铺</option>',
    ...shops.map((s) => {
      const name = s.displayName || s.platformShopId || s.id.slice(0, 8);
      return `<option value="${s.id}">${name}</option>`;
    }),
  ].join('');
  shopSelect.disabled = shops.length === 0;

  const reportTypes = getManualReportTypes();
  const preferred = reportTypes.some((item) => item.key === activeModule) ? activeModule : reportTypes[0]?.key;
  $('#manual-report-types').innerHTML = reportTypes.map((item) => `
    <label class="manual-report-row">
      <input type="checkbox" value="${item.key}" ${item.key === preferred ? 'checked' : ''} />
      <span>${item.label}</span>
    </label>
  `).join('');
  // 勾选变化 → 同步时间控件启用态 + 清错误(校验在提交时做)
  $$('#manual-report-types input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener('change', () => { updateManualDateState(); setManualError(''); }));

  setManualDateRange('7d');
  updateManualDateState();
  setManualError(shops.length === 0 ? '当前没有可派单的店铺' : '');
  $('#manual-fetch-modal').hidden = false;
}

function closeManualFetchModal() {
  $('#manual-fetch-modal').hidden = true;
  setManualError('');
}

async function submitManualFetch() {
  const err = validateManualFetch();
  if (err) {
    setManualError(err);
    return;
  }
  const btn = $('#manual-fetch-submit');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '派单中…';
  try {
    const created = await createTasksForSelected({
      shopId: $('#manual-shop').value || null,
      moduleKeys: selectedManualModuleKeys(),
      dates: {
        startDate: $('#manual-date-from').value,
        endDate: $('#manual-date-to').value,
      },
    });
    $('#last-sync').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 通知 service_worker 立刻拉一次（不等下个 10s 周期）
    try { chrome.runtime?.sendMessage?.({ type: 'AGENT_PULL_NOW' }); } catch {}
    console.log(`[popup] 已创建 ${created.length} 个任务`);
    closeManualFetchModal();
    // 短延迟后刷新真实进度
    setTimeout(refreshFromApi, 600);
  } catch (e) {
    setManualError('派单失败:' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$('#btn-fetch').addEventListener('click', () => openManualFetchModal());
$('#manual-fetch-close').addEventListener('click', closeManualFetchModal);
$('#manual-fetch-cancel').addEventListener('click', closeManualFetchModal);
$('#manual-fetch-submit').addEventListener('click', submitManualFetch);
$('#manual-fetch-modal').addEventListener('click', (e) => {
  if (e.target.id === 'manual-fetch-modal') closeManualFetchModal();
});
$$('.manual-shortcut').forEach((btn) => {
  btn.addEventListener('click', () => setManualDateRange(btn.dataset.manualRange));
});
['manual-date-from', 'manual-date-to'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', () => setManualError(validateManualFetch()));
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
  // 真"实测":让 SW 开 4 个 hidden tab 到各域名首页,看是否跳登录页 → 写 loginHealth
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
      headers: {
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        ...(cfg.erpGateKey ? { 'X-ERP-Key': cfg.erpGateKey } : {}),
      },
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
// 9. 店铺 scope —— 现由账号匹配引导自动写入 selectedShopIds(见 runOnboard)。
//    selectedShops = null → 全部(未匹配前);数组 → 仅本机匹配到的店。
//    手动选店 picker 已移除(纯自动 scope)。
// ──────────────────────────────────────────────────────────────
let selectedShops = null;

// ──────────────────────────────────────────────────────────────
// 10. 启动渲染
// ──────────────────────────────────────────────────────────────
// 点左上角手机号 → 重新跑账号匹配 + 授权
document.getElementById('account-name')?.addEventListener('click', () => runOnboard());
renderModules();
renderProgress();
