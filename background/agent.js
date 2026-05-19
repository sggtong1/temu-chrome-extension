// ────────────────────────────────────────────────────────────────────
// 派单中枢 (agent)
//
// 长轮询 ERP 后端的 /api/agent/tasks 队列：
//   1. chrome.alarms 每 10s 触发 pollOnce()
//   2. pollOnce → POST /api/agent/tasks/claim   原子领最多 N 个任务
//   3. 每个 task 异步 executeTask()
//      - 启 60s heartbeat 续租
//      - dispatch(task) 根据 kind 派发执行（先 stub，后续接 transform）
//      - 完成 → POST /:id/result (success | failed)
//
// 配置来源：chrome.storage.local
//   apiUrl              ERP 网关，如 https://duoshou.868818.xyz
//   token               Bearer token，dev 期就用 "demo"
//   pluginInstanceId    本插件实例 ID（首次自动生成，持久化）
//   selectedShopIds     限定派单到这些店铺（null = 不限）
// ────────────────────────────────────────────────────────────────────

import {
  transformAvailableActivities,
  transformActivityProducts,
  transformActivityEnrollments,
} from './transform/activity_transform.js';
import {
  transformSales30dResponse,
  transformPriceAdjustResponse,
  transformFluxAnalysisResponse,
  transformFluxAnalysisDetailResponse,
  transformLifecycleResponse,
} from './transform/sku_transform.js';

const POLL_PERIOD_MIN  = 1 / 6;   // 10s
const HEARTBEAT_PERIOD = 60_000;  // 60s
const CLAIM_LIMIT      = 3;       // 每次最多领 3 个
const LEASE_SECONDS    = 300;     // 5min 租约
const ALARM_NAME       = 'agent-poll';

// Bump this when diagnosing Chrome MV3 service-worker/module cache issues.
// It is written into logs and successful task results, so we can prove which
// evaluated module, not just which fetched source file, handled a task.
const AGENT_BUILD_ID   = 'agent-mallcache-fix-20260519d';

// 全托管流量分析按地区分 3 个 tab,Temu 后端用 siteId 区分。具体数字暂占位
// (TODO:实测全球/美国/欧洲页面的请求 body 后修正)。Frontend 也可以传明确
// siteId 覆盖这个默认表。
const REGION_TO_SITE_ID = {
  global: 0,       // 全球(已实测)
  us:     100,     // 美国 — TODO 实测
  eu:     200,     // 欧洲 — TODO 实测
};

// ★ 流量页 region-aware endpoint(2026-05-18 用户确认):三个 region 的 API path
// 完全一致,只是 origin(域名前缀)不同。plugin 走 dispatchViaHiddenTab → 打开
// pageUrl 拿 session.origin → 拼接 apiUrlPattern 后 fetch,所以 path 共用即可。
const REGION_TO_FLUX_PAGE_URL = {
  global: 'https://agentseller.temu.com/main/flux-analysis-full',
  us:     'https://agentseller-us.temu.com/main/flux-analysis-full',
  eu:     'https://agentseller-eu.temu.com/main/flux-analysis-full',
};
const FLUX_LIST_API_PATH   = '/api/seller/full/flow/analysis/goods/list';
const FLUX_DETAIL_API_PATH = '/api/seller/full/flow/analysis/goods/detail';
const REGION_TO_FLUX_LIST_API = {
  global: FLUX_LIST_API_PATH,
  us:     FLUX_LIST_API_PATH,
  eu:     FLUX_LIST_API_PATH,
};
const REGION_TO_FLUX_DETAIL_API = {
  global: FLUX_DETAIL_API_PATH,
  us:     FLUX_DETAIL_API_PATH,
  eu:     FLUX_DETAIL_API_PATH,
};
const AGENT_IMPORT_URL = import.meta.url;

function agentDiag() {
  return {
    buildId: AGENT_BUILD_ID,
    importUrl: AGENT_IMPORT_URL,
    extensionId: chrome.runtime?.id ?? null,
    manifestVersion: chrome.runtime?.getManifest?.().version ?? null,
  };
}

// 正在执行的 task: taskId → { heartbeatTimer, abort }
const _running = new Map();

// ── 登录健康度(plugin 实测)─────────────────────────────────────
// chrome.cookies 只能查存在性,查不出 token 是否过期。plugin 端在每次 capture
// 成功/失败时把对应子域的真实状态写进 chrome.storage.local,popup 的"在线情况"
// 优先读这个实测值,覆盖 cookie 检测。
const LOGIN_HEALTH_KEY = 'agent:loginHealth';

function regionKeyFromPageUrl(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    const HOST_TO_KEY = {
      'agentseller.temu.com':    'global',
      'agentseller-us.temu.com': 'us',
      'agentseller-eu.temu.com': 'eu',
      'seller.kuajingmaihuo.com': 'kjmh',
    };
    return HOST_TO_KEY[host] ?? null;
  } catch {
    return null;
  }
}

// ★ 从 captured headers 抽 Temu 当前登录的 mallId。Temu agentseller 用 lowercase 'mallid' header,
// 部分接口经 cookies 出现 mall_id_cookies 等变种 — 这里尽量宽容多 alias。
function extractMallIdFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const aliases = ['mallid', 'mallId', 'mall-id', 'mall_id', 'mall_id_cookies', 'mallid_cookies'];
  for (const k of aliases) {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

async function updateLoginHealth(regionKey, status, reason = null) {
  if (!regionKey) return;
  try {
    const stored = await chrome.storage.local.get(LOGIN_HEALTH_KEY);
    const cur = stored[LOGIN_HEALTH_KEY] || {};
    cur[regionKey] = { status, reason, updatedAt: Date.now() };
    await chrome.storage.local.set({ [LOGIN_HEALTH_KEY]: cur });
  } catch (e) {
    console.warn(`[agent] updateLoginHealth(${regionKey}=${status}) failed:`, e?.message);
  }
}

// ── 配置 ───────────────────────────────────────────────────────────
async function getCfg() {
  return await chrome.storage.local.get([
    'apiUrl', 'token', 'pluginInstanceId', 'selectedShopIds',
  ]);
}

async function ensurePluginInstanceId() {
  const { pluginInstanceId } = await chrome.storage.local.get('pluginInstanceId');
  if (pluginInstanceId) return pluginInstanceId;
  const id = 'pi-' + (crypto.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));
  await chrome.storage.local.set({ pluginInstanceId: id });
  console.log('[agent] generated pluginInstanceId:', id);
  return id;
}

// ── HTTP 辅助 ─────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const { apiUrl, token } = await getCfg();
  if (!apiUrl) throw new Error('agent-not-configured');
  const res = await fetch(apiUrl + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token || 'demo'}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`http ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── 派单轮询 ──────────────────────────────────────────────────────
export async function pollOnce() {
  const cfg = await getCfg();
  if (!cfg.apiUrl) return; // 还没配 ERP 地址，跳过

  const pluginInstanceId = await ensurePluginInstanceId();

  let resp;
  try {
    resp = await api('/api/agent/tasks/claim', {
      method: 'POST',
      body: JSON.stringify({
        pluginInstanceId,
        shopIds: cfg.selectedShopIds && cfg.selectedShopIds.length > 0 ? cfg.selectedShopIds : undefined,
        limit: CLAIM_LIMIT,
        leaseSeconds: LEASE_SECONDS,
      }),
    });
  } catch (e) {
    console.warn('[agent] claim 失败:', e.message);
    return;
  }

  const tasks = resp?.tasks || [];
  if (tasks.length === 0) return;
  console.log(`[agent] 领取 ${tasks.length} 个任务`);
  for (const t of tasks) executeTask(t, pluginInstanceId);
}

// ── 任务执行 ────────────────────────────────────────────────────
async function executeTask(task, pluginInstanceId) {
  if (_running.has(task.id)) return; // 重复防护

  const abort = new AbortController();
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(task.id, pluginInstanceId).catch((e) =>
      console.warn(`[agent] heartbeat ${task.id} fail:`, e.message),
    );
  }, HEARTBEAT_PERIOD);
  _running.set(task.id, { abort, heartbeatTimer });

  console.log(`[agent] ▶ ${task.id.slice(0, 8)} kind=${task.kind}`);

  try {
    const result = await dispatch(task, abort.signal);
    await reportResult(task.id, pluginInstanceId, { status: 'success', result });
    console.log(`[agent] ✓ ${task.id.slice(0, 8)}`);
  } catch (e) {
    await reportResult(task.id, pluginInstanceId, {
      status: 'failed',
      errorCode: e.code || 'UNKNOWN',
      errorMessage: `[${AGENT_BUILD_ID}] ${String(e.message || e)}`.slice(0, 1500),
    });
    console.error(`[agent] ✗ ${task.id.slice(0, 8)}:`, e.message);
  } finally {
    clearInterval(heartbeatTimer);
    _running.delete(task.id);
  }
}

// ── 每个 scrape:* kind 对应的 fetch + transform 配置 ─────────────
// dispatchViaHiddenTab 在 page same-origin 上下文跑:
//   1. 打开 pageUrl  → page 自然发起对 apiUrlPattern 的请求
//   2. Request 构造器 proxy 捕获那个请求的 headers(含 anti-content + mallid + content-type)
//   3. 用同一组 headers 自己分页发 fetch,buildBody(payload, pageNo) 控制每页 body
// raw rows → transform → task.result.rows[](Activity 主表 schema)
const KIND_TO_FETCH_SPEC = {
  'scrape:marketing-activity': {
    pageUrl: 'https://agentseller.temu.com/activity/marketing-activity',
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/activity/list',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    // buildBody 返 base body — runFetchInTab 在 pageNo 模式下注入 pageNo+pageSize
    // needSessionItem/needCanEnrollCnt:tips.txt 2026-05-18 实测 cURL 揭示后台真用这俩 flag
    // 拿到 thematicList[].sessionItem(场次)+ canEnrollCnt(可报数量),不带 flag 时这两块字段为空。
    buildBody: (_payload) => ({ needSessionItem: true, needCanEnrollCnt: true }),
    listPath: 'result.activityList',
    totalPath: 'result.total',
    transform: (rawItems, payload) =>
      transformAvailableActivities(
        { result: { activityList: rawItems } },
        {
          shopName: payload.shopName ?? `mall${payload.mallId}`,
          mallId: payload.mallId,
          region: payload.region,
        },
      ),
  },
  // scrape:activity-products — 抓"某活动可报商品 SKU 列表"
  // payload: { mallId, activityType, activityThematicId, activityId(duoshou uuid) }
  'scrape:activity-products': {
    // pageUrl 由 payload 算 — type 和 thematicId 每个 task 不同
    pageUrl: (payload) =>
      `https://agentseller.temu.com/activity/marketing-activity/detail-new?type=${payload.activityType}&thematicId=${payload.activityThematicId}`,
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/scroll/match',
    method: 'POST',
    paginationMode: 'scroll',
    cursorOutPath: 'result.searchScrollContext',
    hasMorePath: 'result.hasMore',
    cursorInKey: 'scrollContext',
    buildBody: (payload) => ({
      activityType: payload.activityType,
      activityThematicId: payload.activityThematicId,
      rowCount: 50,
      filterUnsalableWarning: false,
    }),
    listPath: 'result.matchList',
    transform: (rawItems) => transformActivityProducts(rawItems),
  },
  // scrape:activity-data — 抓本店"已报名活动 SKU 价格"快照
  // payload: { mallId }  其他不需要(API 按 mallid header 隔离店铺)
  // 落库:ActivityEnrollment(一行 = shop × activity × session × SKU)
  'scrape:activity-data': {
    pageUrl: 'https://agentseller.temu.com/activity/marketing-activity/log',
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/list',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    buildBody: (_payload) => ({}),     // runFetchInTab 注入 pageNo+pageSize
    listPath: 'result.list',
    totalPath: 'result.total',
    transform: (rawItems) => transformActivityEnrollments(rawItems),
  },
  // scrape:flux-analysis — 商品流量分析(全托管 SPU 级)
  // payload: { mallId, region?, statisticType?, siteId?, quickFilter? }
  //   region        'global'(默认) | 'us' | 'eu' — 全托管页 UI 三选一
  //   statisticType 期望值见 UI 标签:1=今日 / 2=昨日 / 3=本周 / 4=本月 / 5=近7日(默认) / 6=近30日
  //   siteId        直接覆盖 region 默认值;最终对照表见 REGION_TO_SITE_ID(实测 TODO)
  //   quickFilter   流量待增长 / 短期增长中 / 长期增长中 / Best Seller
  // 落库:flux_analysis_daily,unique 含 region
  'scrape:flux-analysis': {
    pageUrl: 'https://agentseller.temu.com/main/flux-analysis-full',
    apiUrlPattern: '/api/seller/full/flow/analysis/goods/list',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    buildBody: (payload) => ({
      statisticType: payload?.statisticType ?? 5,                                  // 5 = 近7日
      siteId:        payload?.siteId ?? REGION_TO_SITE_ID[payload?.region ?? 'global'],
      ...(payload?.quickFilter ? { quickFilter: payload.quickFilter } : {}),
    }),
    listPath: 'result.list',
    totalPath: 'result.total',
    transform: (rawItems, payload) => transformFluxAnalysisResponse(rawItems, payload),
  },
  // scrape:flux-analysis-detail — 单 SPU 历史日明细(每日真值)
  // payload: { mallId, region, goodsId, siteId?, statTimeDimension?, productName?, pictureUrl? }
  //   ★ 真 body 实测(2026-05-18 PM 提供):
  //     URL: /api/seller/full/flow/analysis/goods/detail
  //     body: { pageNum, pageSize, siteId, goodsId, statTimeDimension }
  //     siteId: -1=全部 / 10=加拿大 / 20=澳大利亚 / ...(其他从 site/list 查)
  //     statTimeDimension: 1=按日 / 2=按周 / 3=按月
  //     pageNum 字段名特殊 — paginatedFetchInSW 用 spec.pageNoKey override
  //   返:result.list[] 每行一日数据,result.total = 总天数
  // 落库:flux_analysis_daily,dataSource='detail',一行/天,真 statDate
  'scrape:flux-analysis-detail': {
    pageUrl: 'https://agentseller.temu.com/main/flux-analysis-full',
    apiUrlPattern: '/api/seller/full/flow/analysis/goods/detail',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 10,         // 默认 10 行/页 = 10 天/页;30 天 3 页
    pageNoKey: 'pageNum',     // ★ Temu detail 用 pageNum 不是 pageNo
    pageSizeKey: 'pageSize',
    buildBody: (payload) => ({
      goodsId:            Number(payload?.goodsId ?? payload?.productId),
      siteId:             payload?.siteId ?? -1,    // -1 全部站点
      statTimeDimension:  payload?.statTimeDimension ?? 1,  // 1 按日
    }),
    listPath: 'result.list',
    totalPath: 'result.total',
    transform: (rawItems, payload) => transformFluxAnalysisDetailResponse(rawItems, payload),
  },
  // scrape:lifecycle-management — 抓"上新生命周期 — 价格申报中"列表(对照 Sallfox Temu核价主表)
  // payload: { mallId, supplierTodoType?(默认1=价格申报中) }
  //   POST /api/kiana/mms/robin/searchForChainSupplier
  //   body: { pageSize, pageNum, removeStatus:0, supplierTodoTypeList:[type] }
  //   pagination: pageNum 字段(不是 pageNo)+ pageSize
  //   listPath: result.dataList  totalPath: result.total
  // 落库:price_review (展开 SPU → SKC → SKU → siteList)
  'scrape:lifecycle-management': {
    pageUrl: 'https://agentseller.temu.com/newon/product-select',
    apiUrlPattern: '/api/kiana/mms/robin/searchForChainSupplier',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 30,
    pageNoKey: 'pageNum',        // ★ Temu 用 pageNum 不是 pageNo
    pageSizeKey: 'pageSize',
    buildBody: (payload) => ({
      removeStatus: 0,
      supplierTodoTypeList: [payload?.supplierTodoType ?? 1],   // 1 = 价格申报中
    }),
    listPath: 'result.dataList',
    totalPath: 'result.total',
    transform: (rawItems, payload) => transformLifecycleResponse(rawItems, payload),
  },
  // scrape:declared-price — 抓商品"申报价/调价单"列表(全托管)
  // payload: { mallId }
  // 数据先存 agent_task.result;PriceReview / DeclaredPrice 表 schema 后续设计。
  // 对照 Sallfox 接口盘点:"Temu 调价单 magnus/mms/price-adjust/*"
  //   = 官方 bg.full.adjust.price.page.query
  'scrape:declared-price': {
    pageUrl: 'https://agentseller.temu.com/price-management/price-adjust',
    apiUrlPattern: '/api/kiana/magnus/mms/price-adjust/product-adjust-query',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    buildBody: (_payload) => ({}),
    listPath: 'result.list',
    totalPath: 'result.total',
    transform: (rawItems) => transformPriceAdjustResponse(rawItems),
  },
  // scrape:sales-30d — 近 30 天销量 + 库存(全托管 SKU 级 snapshot)
  'scrape:sales-30d': {
    pageUrl: 'https://agentseller.temu.com/stock/fully-mgt/sale-manage/main',
    apiUrlPattern: '/mms/venom/api/supplier/sales/management/listOverall',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    buildBody: (_payload) => ({ isLack: 0 }),     // runFetchInTab 注入 pageNo+pageSize
    listPath: 'result.subOrderList',
    totalPath: 'result.total',
    transform: (rawItems) => transformSales30dResponse(rawItems),
  },
  // 其他 4 个 scrape:* kind 由后续 plan 添加
};

// ── kind → 实际执行的派发表 ───────────────────────────────────────
// scrape:marketing-activity + scrape:activity-products 走实际 dispatch,
// 其他 5 个 scrape:* 暂时 stub。submit:* 留到第三阶段。
async function dispatch(task, signal) {
  console.log(`[agent ${AGENT_BUILD_ID}] dispatch(kind=${task.kind}) url=${AGENT_IMPORT_URL}`);
  switch (task.kind) {
    case 'scrape:marketing-activity':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchMarketingActivity (REAL path)`);
      return dispatchMarketingActivity(task, signal);

    case 'scrape:activity-products':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchActivityProducts (REAL path)`);
      return dispatchActivityProducts(task, signal);

    case 'scrape:sales-30d':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchSales30d (REAL path)`);
      return dispatchSales30d(task, signal);

    case 'scrape:activity-data':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchActivityData (REAL path)`);
      return dispatchActivityData(task, signal);

    case 'scrape:declared-price':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchDeclaredPrice (REAL path)`);
      return dispatchDeclaredPrice(task, signal);

    case 'scrape:lifecycle-management':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchLifecycleManagement (REAL path)`);
      return dispatchLifecycleManagement(task, signal);

    case 'submit:price-confirm':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchPriceConfirm (REAL path)`);
      return dispatchPriceConfirm(task, signal);

    case 'scrape:flux-analysis':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchFluxAnalysis (REAL path)`);
      return dispatchFluxAnalysis(task, signal);

    case 'scrape:flux-analysis-detail':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchFluxAnalysisDetail (REAL path)`);
      return dispatchFluxAnalysisDetail(task, signal);

    // 其他 scrape:* kinds 暂时仍 stub, 后续 plan 接入
    case 'scrape:settlement':
    case 'scrape:promo': {
      console.log(`[agent ${AGENT_BUILD_ID}] → 走 stub branch`);
      // TODO[wire]: 接到现有 background/service_worker.js 里的 handleStartCollection
      // 暂时返回 stub 结果，让端到端环路先通
      await sleep(2000 + Math.random() * 3000, signal);
      return {
        stub: true,
        kind: task.kind,
        shopId: task.shop_id,
        payload: task.payload,
        completedAt: new Date().toISOString(),
        agent: agentDiag(),
      };
    }
    case 'submit:activity-enroll':
      console.log(`[agent ${AGENT_BUILD_ID}] → 进入 dispatchActivityEnroll (REAL path)`);
      return dispatchActivityEnroll(task, signal);

    case 'submit:price-reject':
      throw Object.assign(new Error('写操作还没接，第三阶段做'), { code: 'NOT_IMPLEMENTED' });
    default:
      throw Object.assign(new Error(`未知 kind: ${task.kind}`), { code: 'UNKNOWN_KIND' });
  }
}

// ── scrape:marketing-activity 专用 wrapper ───────────────────────
// 任务语义:抓"可报名活动列表"(Activity 主表),不是已报名记录。
// 只要 mallId 即可定位 hidden tab 用哪个店登录态;region 仅作 transform 的元信息透传。
async function dispatchMarketingActivity(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:marketing-activity (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }

  const spec = KIND_TO_FETCH_SPEC['scrape:marketing-activity'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:activity-products 专用 wrapper ────────────────────────
// 任务语义:抓某活动可报商品 SKU 列表(行展开后台 lazy 抓)。
// payload 必须有:mallId, activityType, activityThematicId, activityId(duoshou uuid 用于 ingester)
async function dispatchActivityProducts(task, signal) {
  const payload = task.payload ?? {};
  const required = ['mallId', 'activityType', 'activityThematicId', 'activityId'];
  for (const k of required) {
    if (payload[k] == null || payload[k] === '') {
      throw Object.assign(
        new Error(`payload.${k} missing for scrape:activity-products (got ${JSON.stringify(payload)})`),
        { code: 'BAD_PAYLOAD' },
      );
    }
  }

  const spec = KIND_TO_FETCH_SPEC['scrape:activity-products'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    activityId: payload.activityId,  // 透传给 ingester,免去二次 lookup
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:sales-30d 专用 wrapper ────────────────────────────────
// 任务语义:全托管 SKU 级近 30 天销量 + 库存 snapshot。落到 ShopSkuSnapshot。
// payload: { mallId } — 其他都不必要(API 内部按 mallid header 隔离店铺)
async function dispatchSales30d(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:sales-30d (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const spec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:activity-data 专用 wrapper ────────────────────────────
// 任务语义:抓本店"已报名活动 SKU 列表+活动价",落到 ActivityEnrollment。
// payload: { mallId } — API 按 mallid header 隔离店铺,其他不必要
async function dispatchActivityData(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:activity-data (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const spec = KIND_TO_FETCH_SPEC['scrape:activity-data'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:flux-analysis 专用 wrapper ────────────────────────────
// 任务语义:抓"商品流量"(全托管 SPU 级,Sallfox 产品分析的数据源)。
// ★ 2026-05-18 改为 list+detail 捆绑:
//   1) 跑 list 拉 SPU 汇总
//   2) 复用同 session(已 captured headers / origin)对 exposureNum>0 的 SPU
//      并发 fetch detail(单 SPU 30 天明细),累积进 result.detailRows
//   server ingester 同时落 list rows + detail rows,不再走 chain-trigger 派
//   单独的 scrape:flux-analysis-detail task。
// payload: { mallId, region?, statisticType?, siteId?, quickFilter?, detailPageSize? }
async function dispatchFluxAnalysis(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:flux-analysis (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const region = payload.region ?? 'global';
  const listApi = REGION_TO_FLUX_LIST_API[region];
  const detailApi = REGION_TO_FLUX_DETAIL_API[region];
  const pageUrl = REGION_TO_FLUX_PAGE_URL[region];
  if (!listApi || !detailApi) {
    throw Object.assign(
      new Error(`flux endpoints not configured for region=${region}`),
      { code: 'BAD_REGION' },
    );
  }
  const spec = {
    ...KIND_TO_FETCH_SPEC['scrape:flux-analysis'],
    apiUrlPattern: listApi,
    pageUrl,
  };
  const { rawItems, transformed: listRows } = await dispatchViaHiddenTab(spec, payload, signal);

  // ── Phase 2:同 session 批量 fetch detail ────────────────────────
  // dispatchViaHiddenTab 跑完后 mallId session 已 cached(setCachedSession),拿来直接 POST detail。
  const session = await getCachedSession(payload.mallId);
  let detailRows = [];
  let detailStats = { candidates: 0, success: 0, failed: 0, skipped: 0 };
  if (!session) {
    console.warn(`[agent ${AGENT_BUILD_ID}] flux-analysis: list 完成但 session 丢失(罕见),跳过 detail`);
  } else {
    const candidates = listRows.filter((r) => Number(r?.exposureNum ?? 0) > 0 && r?.platformProductId);
    detailStats.candidates = candidates.length;
    const detailUrl = `${session.origin}${detailApi}`;
    const detailHeaders = { ...session.headers, 'content-type': 'application/json' };
    const detailPageSize = payload.detailPageSize ?? 30;   // 一次 30 天够覆盖 weekly + 月度对比窗口
    const CONCURRENCY = 3;
    let idx = 0;
    async function worker() {
      while (idx < candidates.length) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        const i = idx++;
        const r = candidates[i];
        const goodsId = r?.platformPayload?.goodsId
          ?? r?.platformPayload?.productSpuId
          ?? null;
        if (!goodsId) { detailStats.skipped++; continue; }
        try {
          const body = {
            goodsId: Number(goodsId),
            siteId: payload.siteId ?? -1,
            statTimeDimension: 1,
            pageNum: 1,
            pageSize: detailPageSize,
          };
          const resp = await fetch(detailUrl, {
            method: 'POST',
            credentials: 'include',
            headers: detailHeaders,
            body: JSON.stringify(body),
          });
          if (resp.status === 429) {
            const retryAfterSec = Number(resp.headers.get('Retry-After')) || 0;
            throw rateLimitedError({
              retryAfterMs: retryAfterSec ? retryAfterSec * 1000 : null,
              httpStatus: 429,
              msg: `detail HTTP 429 Too Many Requests`,
            });
          }
          if (!resp.ok) throw new Error(`detail HTTP ${resp.status}`);
          const data = await resp.json();
          const rl = detectRateLimitInBody(data);
          if (rl) {
            throw rateLimitedError({
              retryAfterMs: rl.retryAfterMs ?? null, httpStatus: 200,
              msg: `Temu rate-limited (detail): ${rl.reason}`,
            });
          }
          const dayItems = data?.result?.list ?? [];
          const rows = transformFluxAnalysisDetailResponse(dayItems, {
            region,
            productSpuId: r.platformProductId,
            productName:  r.productName,
            pictureUrl:   r.pictureUrl,
            goodsId,
          });
          detailRows.push(...rows);
          detailStats.success++;
        } catch (e) {
          if (e?.code === 'RATE_LIMITED') {
            // 限流时直接停止其余 detail fetch — list 仍正常返回,detail 部分留给下次任务
            console.warn(`[agent ${AGENT_BUILD_ID}] detail rate-limited at SPU ${i + 1}/${candidates.length},停止 detail batch`);
            idx = candidates.length;       // 让其他 worker 也退出
            detailStats.failed++;
            return;
          }
          console.warn(`[agent ${AGENT_BUILD_ID}] detail fetch fail spu=${r.platformProductId}: ${e.message}`);
          detailStats.failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    console.log(`[agent ${AGENT_BUILD_ID}] flux-analysis detail batch: ` +
      `${detailStats.success}/${detailStats.candidates} ok, ${detailStats.failed} failed, ` +
      `${detailStats.skipped} no-goodsId — ${detailRows.length} day-rows`);
  }

  return {
    rows: listRows,
    detailRows,
    detailStats,
    rawCount: rawItems.length,
    statisticType: payload.statisticType ?? 5,
    siteId: payload.siteId ?? 0,
    region,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:flux-analysis-detail 专用 wrapper ─────────────────────
// 任务语义:抓单 SPU 在指定窗口内的每日真值明细。Block C 核心。
// payload: { mallId, region, productId, productName?, pictureUrl?, statisticType?, siteId? }
async function dispatchFluxAnalysisDetail(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(new Error(`payload.mallId missing for scrape:flux-analysis-detail`), { code: 'BAD_PAYLOAD' });
  }
  // 接受 goodsId 或 productId(向后兼容旧 payload)
  if (!payload.goodsId && !payload.productId) {
    throw Object.assign(new Error(`payload.goodsId (or productId) missing for scrape:flux-analysis-detail`), { code: 'BAD_PAYLOAD' });
  }
  const region = payload.region ?? 'global';
  const detailApi = REGION_TO_FLUX_DETAIL_API[region];
  const pageUrl = REGION_TO_FLUX_PAGE_URL[region];
  if (!detailApi) {
    throw Object.assign(
      new Error(`flux detail endpoint not configured for region=${region} (US/EU pending real URL)`),
      { code: 'BAD_REGION' },
    );
  }
  const spec = {
    ...KIND_TO_FETCH_SPEC['scrape:flux-analysis-detail'],
    apiUrlPattern: detailApi,
    // ★ 关键:flux-analysis-full 列表页默认只发 /list 不发 /detail,所以 capture
    //   阶段必须等 list 请求(同 mallId session 跨 path 通用)。fetch 仍走 detail。
    captureApiUrlPattern: REGION_TO_FLUX_LIST_API[region],
    pageUrl,
  };
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    productId: payload.productId,
    region: payload.region ?? 'global',
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── submit:price-confirm 专用 wrapper ────────────────────────────
// 任务语义:把用户在 ERP "查看并确认申报价" modal 里填的新价提交回 Temu。
// payload: { mallId, priceOrderId, action, items?, reference?, bargainReasonList? }
//   action='set-ref' / 'set-new' / 'abandon'
//     set-ref:   bargain-no-bom POST body supplierResult=1, price=参考申报价
//     set-new:   bargain-no-bom POST body supplierResult=2, price=新申报价(items 必传)
//     abandon:   reject-remark POST body { orderId }
//   items: [{ productSkuId, priceCents }]
// 走 captureSessionViaTab 跟 scrape:lifecycle-management 复用同一 pageUrl(/newon/product-select)
// 等 list 请求自然发生时 capture anti-content+mallid headers,然后 SW 端 POST 提交。
async function dispatchPriceConfirm(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId || !payload.priceOrderId) {
    throw Object.assign(
      new Error(`payload.mallId/priceOrderId missing for submit:price-confirm`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const action = String(payload.action || 'set-new');
  const isAbandon = action === 'abandon';

  // Capture spec:复用 lifecycle 同一页 + list endpoint 作为 capture 锚点
  const captureSpec = {
    pageUrl: 'https://agentseller.temu.com/newon/product-select',
    apiUrlPattern: '/api/kiana/mms/robin/searchForChainSupplier',
  };

  // 拿 session(可能 cache 命中)
  const mallId = payload.mallId;
  let session = await getCachedSession(mallId);
  let freshlyCaptured = false;
  if (!session) {
    console.log(`[agent ${AGENT_BUILD_ID}] submit session MISS mall=${mallId} — capturing`);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    session = await captureSessionViaTab(captureSpec, payload, signal);
    freshlyCaptured = true;
    // 暂不写缓存 — 先 MALL_MISMATCH 检测,避免缓存污染
  }
  // MALL_MISMATCH 防御
  const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
  if (capturedMall && String(capturedMall) !== String(mallId)) {
    await invalidateSession(mallId);
    throw Object.assign(
      new Error(`MALL_MISMATCH: submit expects mallId=${mallId} but chrome is ${capturedMall}`),
      { code: 'MALL_MISMATCH' },
    );
  }
  if (freshlyCaptured) {
    await setCachedSession(mallId, session.headers, session.origin, session.mallId);
  }

  // 构造请求
  const submitUrl = isAbandon
    ? `${session.origin}/api/kiana/mms/magneto/api/price-review-order/no-bom/reject-remark`
    : `${session.origin}/api/kiana/mms/magneto/price/bargain-no-bom`;
  const submitBody = isAbandon
    ? { orderId: Number(payload.priceOrderId) }
    : {
        supplierResult: action === 'set-ref' ? 1 : 2,
        priceOrderId: Number(payload.priceOrderId),
        items: Array.isArray(payload.items)
          ? payload.items.map((it) => ({
              productSkuId: Number(it.productSkuId),
              price: Number(it.priceCents),    // already in cents
            }))
          : [],
        reference: payload.reference ?? '',
        bargainReasonList: Array.isArray(payload.bargainReasonList) ? payload.bargainReasonList : [],
      };

  const headers = { ...session.headers, 'content-type': 'application/json' };

  let respJson;
  try {
    const resp = await fetch(submitUrl, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(submitBody),
    });
    if (resp.status === 429) {
      const ra = Number(resp.headers.get('Retry-After')) || 0;
      throw rateLimitedError({ retryAfterMs: ra ? ra * 1000 : null, httpStatus: 429, msg: 'submit HTTP 429' });
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw Object.assign(new Error(`SUBMIT_FAILED: HTTP ${resp.status}: ${txt.slice(0, 200)}`), { code: 'SUBMIT_FAILED' });
    }
    respJson = await resp.json();
  } catch (e) {
    if (e?.code === 'RATE_LIMITED' || e?.code === 'SUBMIT_FAILED' || e?.code === 'MALL_MISMATCH') throw e;
    throw Object.assign(new Error(`SUBMIT_NETWORK: ${e.message}`), { code: 'SUBMIT_NETWORK' });
  }

  const rl = detectRateLimitInBody(respJson);
  if (rl) throw rateLimitedError({ retryAfterMs: rl.retryAfterMs ?? null, httpStatus: 200, msg: `submit rate-limited: ${rl.reason}` });

  const ok = respJson?.success === true;
  return {
    success: ok,
    action,
    endpoint: isAbandon ? 'reject-remark' : 'bargain-no-bom',
    priceOrderId: payload.priceOrderId,
    items: submitBody.items ?? null,
    response: respJson,
    errorCode: respJson?.errorCode ?? null,
    errorMsg: respJson?.errorMsg ?? null,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── submit:activity-enroll 专用 wrapper ─────────────────────────
// 任务语义:报名营销活动(Sallfox "申报" 按钮提交)。
// payload: { mallId, thematicId, activityType?, sessionId?, items: [{...}] }
//   items: [{ productId, skcId, productSkuId, supplyPrice(cents), targetActivityStock }]
// 端点:POST /api/kiana/gamblers/marketing/enroll/submit
// body 结构 推断(基于 /enroll/* 系列字段命名,实战可能需要 1-2 轮迭代修正)
//
// 重要:Temu 返回 errorCode/errorMsg 全量上抛 result(包括 requestBody),
//      方便事后 debug 字段名是否对得上。
async function dispatchActivityEnroll(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(new Error('payload.mallId missing'), { code: 'BAD_PAYLOAD' });
  }
  if (!payload.thematicId || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw Object.assign(new Error('payload.thematicId/items missing'), { code: 'BAD_PAYLOAD' });
  }
  if (payload.activityType == null) {
    throw Object.assign(new Error('payload.activityType missing (Temu detail-new 页必须 type 参数)'), { code: 'BAD_PAYLOAD' });
  }

  // ★ capture 锚点 = activity detail-new 页(对应 thematicId),NOT 顶层 list 页
  //   原因:Temu submit 不接受随便一个 session,必须是"已经看过这个 thematic 详情页"的 session,
  //   否则服务端找不到 enrollment context,返回 errorCode=3000000 "报名货品不可为空"。
  //   detail-new 页自然会触发 /enroll/scroll/match(可报 SKU 列表),从那里捕 headers。
  const captureSpec = {
    pageUrl: (p) => `https://agentseller.temu.com/activity/marketing-activity/detail-new?type=${p.activityType}&thematicId=${p.thematicId}`,
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/scroll/match',
  };

  const mallId = payload.mallId;
  // ★ NOT 走 getCachedSession — submit 必须每次 fresh capture 在 detail-new 页上下文,
  //   再用一遍 list-page cached session 会让 Temu 服务端"忘了"当前正在哪个 thematic 上。
  console.log(`[agent ${AGENT_BUILD_ID}] enroll always fresh-capture (detail-new) thematic=${payload.thematicId}`);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
  const session = await captureSessionViaTab(captureSpec, payload, signal);
  // MALL_MISMATCH 防御
  const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
  if (capturedMall && String(capturedMall) !== String(mallId)) {
    throw Object.assign(
      new Error(`MALL_MISMATCH: enroll expects mallId=${mallId} but chrome is ${capturedMall}`),
      { code: 'MALL_MISMATCH' },
    );
  }

  // ★ Temu /enroll/submit body 结构(2026-05-19 真 cURL 实测 — DevTools 不显示 Payload,
  //   用 window.fetch 注入 hook 在 console 捕到):
  //   {
  //     activityType: 13,
  //     activityThematicId: 2605120000000022,             // ← 数字 不是 string
  //     productList: [                                    // ← productList,NOT submitList
  //       { productId, activityStock, skcList: [
  //         { skcId, skuList: [{ skuId, activityPrice }] }
  //       ]}
  //     ]
  //   }
  // ★ 旧版本错用 submitList → Temu 找不到货品数组 → "报名货品不可为空"。
  // ★ 所有 ID 字段都是 number(实测 10-16 位都在 Number.MAX_SAFE_INTEGER 之内)。
  const byProduct = new Map();
  for (const it of payload.items) {
    if (it.productId == null || it.productId === '') {
      throw Object.assign(
        new Error(`BAD_PAYLOAD: items[].productId missing — Temu 必填,空值必返回"报名货品不可为空"`),
        { code: 'BAD_PAYLOAD', offendingItem: it },
      );
    }
    const pKey = String(it.productId);
    if (!byProduct.has(pKey)) {
      byProduct.set(pKey, {
        productId: Number(it.productId),                    // ★ number(真 body 是 numeric)
        activityStock: Number(it.targetActivityStock) || 0,
        skcMap: new Map(),
      });
    }
    const prod = byProduct.get(pKey);
    const sKey = String(it.skcId ?? '');
    if (!prod.skcMap.has(sKey)) prod.skcMap.set(sKey, { skcId: Number(it.skcId), skuList: [] });
    prod.skcMap.get(sKey).skuList.push({
      skuId: Number(it.productSkuId),
      activityPrice: Number(it.supplyPrice),                // cents
    });
  }
  const productList = Array.from(byProduct.values()).map((p) => ({
    productId: p.productId,
    activityStock: p.activityStock,
    skcList: Array.from(p.skcMap.values()),
  }));

  const submitBody = {
    activityType: Number(payload.activityType),
    activityThematicId: Number(payload.thematicId),
    productList,
    ...(payload.sessionId != null ? { sessionId: Number(payload.sessionId) } : {}),
  };

  const submitUrl = `${session.origin}/api/kiana/gamblers/marketing/enroll/submit`;
  const headers = { ...session.headers, 'content-type': 'application/json' };

  let respJson;
  try {
    const resp = await fetch(submitUrl, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(submitBody),
    });
    if (resp.status === 429) {
      const ra = Number(resp.headers.get('Retry-After')) || 0;
      throw rateLimitedError({ retryAfterMs: ra ? ra * 1000 : null, httpStatus: 429, msg: 'enroll HTTP 429' });
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw Object.assign(
        new Error(`SUBMIT_FAILED: HTTP ${resp.status}: ${txt.slice(0, 200)}`),
        { code: 'SUBMIT_FAILED', requestBody: submitBody, httpStatus: resp.status, rawText: txt.slice(0, 500) },
      );
    }
    respJson = await resp.json();
  } catch (e) {
    if (e?.code === 'RATE_LIMITED' || e?.code === 'SUBMIT_FAILED' || e?.code === 'MALL_MISMATCH') throw e;
    throw Object.assign(new Error(`SUBMIT_NETWORK: ${e.message}`), { code: 'SUBMIT_NETWORK' });
  }

  const rl = detectRateLimitInBody(respJson);
  if (rl) throw rateLimitedError({ retryAfterMs: rl.retryAfterMs ?? null, httpStatus: 200, msg: `enroll rate-limited: ${rl.reason}` });

  // 全量上抛 response + requestBody,便于 server 端 ingester debug + 后续修正 body schema
  return {
    success: respJson?.success === true,
    response: respJson,
    requestBody: submitBody,
    errorCode: respJson?.errorCode ?? respJson?.error_code ?? null,
    errorMsg: respJson?.errorMsg ?? respJson?.error_msg ?? null,
    submittedCount: payload.items.length,
    thematicId: payload.thematicId,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:lifecycle-management 专用 wrapper ─────────────────────
// 任务语义:抓 Temu "上新生命周期 — 价格申报中" 列表(Sallfox Temu核价 数据源)。
// payload: { mallId, supplierTodoType? }
async function dispatchLifecycleManagement(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:lifecycle-management`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const spec = KIND_TO_FETCH_SPEC['scrape:lifecycle-management'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    supplierTodoType: payload?.supplierTodoType ?? 1,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── scrape:declared-price 专用 wrapper ───────────────────────────
// 任务语义:抓"商品当前申报价 / 调价单"列表(Sallfox 申报价格任务)。
// payload: { mallId }
async function dispatchDeclaredPrice(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:declared-price (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const spec = KIND_TO_FETCH_SPEC['scrape:declared-price'];
  const { rawItems, transformed } = await dispatchViaHiddenTab(spec, payload, signal);
  return {
    rows: transformed,
    rawCount: rawItems.length,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// ── 限流检测 + per-mallId 冷却 ────────────────────────────────────
// 背景:Temu agentseller 在限流时常常 HTTP 200 + body 里塞 error_code/error_msg,
// 前端组件吞掉只显示"暂无数据";真要靠这个就出生产事故。所以双层检测:
//   1) HTTP 429 + Retry-After
//   2) body 启发式(error_code 模式 + 关键字)
// 命中后:抛 RATE_LIMITED → executeTask 兜底 → 同时把这个 mallId 标进冷却。
// 后续 task 来到 dispatchViaHiddenTab 先看冷却,active 就 fail-fast。
//
// 冷却时长:有 retryAfterMs 用之;没有则默认 10 分钟。
// 落 chrome.storage.session 让 SW 重启也不丢。

// inline 递增重试策略(借鉴 Python 插件实践):
// 初次失败后,先在任务内 sleep+re-capture session 重试 3 次,只有全部失败才进真冷却。
// 多数 Temu 限流是几十秒短窗口,内联重试常能拿回数据,不需要锁住 10min。
const RATE_LIMIT_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];   // 第 N 次重试前的延迟
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000;          // 3 min(原 10min 缩到 3min,内联重试已经给了 100s 恢复窗口)
const RATE_LIMIT_MIN_COOLDOWN_MS     = 30_000;                 // ≥ 30s(避免循环 burst)
const RATE_LIMIT_MAX_COOLDOWN_MS     = 30 * 60 * 1000;         // 30 min hard cap
const COOLDOWN_KEY = (mallId) => `agent:cooldown:${mallId}`;

// Temu / 通用限流 error_code 黑名单(已知 + 启发)。
// 边遇到边补,不要太严:误判会让正常 task 假死。
const RATE_LIMIT_ERROR_CODES = new Set([
  // Temu 系列(常见):
  // 4xx 系列里以 1xxx / 2xxx 结尾的常是"请求过于频繁/被风控"
  // 这里先按观察样本兜:遇到精确 code 时补 set
]);
const RATE_LIMIT_MSG_PATTERNS = [
  /频次/i, /频率/i, /请求过于频繁/i, /稍后(重试|再试)/i,
  /rate.?limit/i, /too many requests/i, /try again later/i, /throttl/i,
];

function rateLimitedError({ retryAfterMs, httpStatus, msg }) {
  return Object.assign(new Error(`RATE_LIMITED: ${msg}`), {
    code: 'RATE_LIMITED',
    retryAfterMs,
    httpStatus,
  });
}

function detectRateLimitInBody(data) {
  if (!data || typeof data !== 'object') return null;
  const code = data.error_code ?? data.errorCode ?? data.code;
  const msg = String(data.error_msg ?? data.errorMsg ?? data.message ?? data.msg ?? '');
  if (code != null && RATE_LIMIT_ERROR_CODES.has(Number(code))) {
    return { reason: `error_code=${code} ${msg.slice(0, 120)}`, retryAfterMs: null };
  }
  for (const pat of RATE_LIMIT_MSG_PATTERNS) {
    if (pat.test(msg)) {
      return { reason: `msg matches ${pat} (${msg.slice(0, 80)})`, retryAfterMs: null };
    }
  }
  return null;
}

async function getMallCooldown(mallId) {
  try {
    const key = COOLDOWN_KEY(mallId);
    const stored = await chrome.storage.session.get(key);
    const c = stored[key];
    if (c && c.untilMs > Date.now()) return c;
    if (c) await chrome.storage.session.remove(key).catch(() => {});
  } catch {}
  return null;
}

async function setMallCooldown(mallId, retryAfterMs, reason) {
  const dur = Math.min(
    Math.max(retryAfterMs ?? RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MIN_COOLDOWN_MS),
    RATE_LIMIT_MAX_COOLDOWN_MS,
  );
  const entry = { untilMs: Date.now() + dur, durationMs: dur, reason };
  try {
    await chrome.storage.session.set({ [COOLDOWN_KEY(mallId)]: entry });
    console.warn(`[agent ${AGENT_BUILD_ID}] cooldown SET mall=${mallId} for ${(dur/1000).toFixed(0)}s — ${reason}`);
  } catch (e) {
    console.warn('[agent] cooldown set failed:', e?.message);
  }
  return entry;
}

// 清掉本店的 session cache,强制下次 fetch 重开 tab 重抓 anti-content + mallid headers
async function invalidateSession(mallId) {
  sessionCacheMem.delete(mallId);
  try { await chrome.storage.session.remove(SESSION_KEY(mallId)); } catch {}
}

// ── Session cache:每个 mallId 一份 captured headers ───────────────────
// MV3 SW 在两次 task 之间(空闲 >30s)会被 chrome 终止,module-level Map 丢失。
// 用 chrome.storage.session(in-memory,跨 SW 重启 OK,浏览器关进程才清)
// + memory Map 双层(同次 SW 内不再异步往返)。
const sessionCacheMem = new Map();
const SESSION_TTL_MS = 90_000;
const SESSION_KEY = (mallId) => `agent:session:${mallId}`;

async function getCachedSession(mallId) {
  // 1) memory L1
  const memHit = sessionCacheMem.get(mallId);
  if (memHit && memHit.expiresAt > Date.now()) return memHit;
  if (memHit) sessionCacheMem.delete(mallId);

  // 2) chrome.storage.session L2(persists across SW restart)
  try {
    const key = SESSION_KEY(mallId);
    const stored = await chrome.storage.session.get(key);
    const c = stored[key];
    if (c && c.expiresAt > Date.now()) {
      sessionCacheMem.set(mallId, c);  // backfill L1
      return c;
    }
    if (c) {
      // stale — clean up
      await chrome.storage.session.remove(key).catch(() => {});
    }
  } catch (e) {
    console.warn('[agent] storage.session get failed:', e?.message);
  }
  return null;
}

async function setCachedSession(mallId, headers, origin, capturedMallId = null) {
  // capturedMallId = 从 captured headers 实测出的 mallId(可能跟 mallId arg 不一致,用于反向校验)
  const entry = { headers, origin, mallId: capturedMallId ?? mallId, expiresAt: Date.now() + SESSION_TTL_MS };
  sessionCacheMem.set(mallId, entry);
  try {
    await chrome.storage.session.set({ [SESSION_KEY(mallId)]: entry });
  } catch (e) {
    console.warn('[agent] storage.session set failed:', e?.message);
  }
}

// ── 通用: 调度入口 — 先看 sessionCache,有就 SW fetch,没就开 tab capture 再缓存 ──
// spec: { pageUrl, apiUrlPattern, method, buildBody(payload), listPath, totalPath, transform,
//         paginationMode, pageSize, cursorOutPath, hasMorePath, cursorInKey }
// 返回 { rawItems: [], transformed: [] }
async function dispatchViaHiddenTab(spec, payload, signal) {
  const checkAbort = () => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
  };

  const mallId = payload.mallId || 'default';

  // 冷却 check —— 真冷却窗口内 fail-fast,不浪费 tab capture
  const cd = await getMallCooldown(mallId);
  if (cd) {
    const remainSec = ((cd.untilMs - Date.now()) / 1000).toFixed(0);
    throw Object.assign(
      new Error(`RATE_LIMITED: mall=${mallId} cooldown active, ${remainSec}s remaining (${cd.reason})`),
      { code: 'RATE_LIMITED', retryAfterMs: cd.untilMs - Date.now(), source: 'cooldown-cache' },
    );
  }

  // 内联递增重试 — 灵感来自 user Python 插件经验。
  // 多数 Temu 限流是短窗口(几十秒),内联 sleep + re-capture session 常能拿回数据,
  // 不需要直接锁 10min。延迟节奏 0 / 10s / 30s / 60s,共 4 次 attempt(初次 + 3 retry)。
  // 每次重试前 invalidateSession 让下一次 fetch 重抓 anti-content + mallid。
  let rawItems = null;
  let lastErr = null;

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[agent ${AGENT_BUILD_ID}] rate-limit retry ${attempt}/${RATE_LIMIT_RETRY_DELAYS_MS.length} ` +
        `mall=${mallId} — sleeping ${delayMs/1000}s + invalidating session (will re-capture)`,
      );
      await sleep(delayMs, signal);
      await invalidateSession(mallId);
    }

    let session = await getCachedSession(mallId);
    let freshlyCaptured = false;
    if (!session) {
      console.log(`[agent ${AGENT_BUILD_ID}] session MISS mall=${mallId} attempt=${attempt} — capturing via tab`);
      checkAbort();
      session = await captureSessionViaTab(spec, payload, signal);
      freshlyCaptured = true;
      // ★ 注意:暂时不写缓存 — 先做 MALL_MISMATCH 检测,
      //   chrome 登的是别的 mall 时 capture 出来的 headers 跟 task 期望对不上,
      //   写进缓存会污染下次同 mallId 任务(造成 "session HIT" + MALL_MISMATCH 怪象)
    } else {
      console.log(`[agent ${AGENT_BUILD_ID}] session HIT mall=${mallId} attempt=${attempt} — SW fetch`);
    }

    // ★ 跨店数据污染防御:plugin 打开的 hidden tab 永远是 chrome 当前登录的 mallId,
    // 跟 payload.mallId 不一致就 fail-fast,避免把 A 店的数据写进 B 店。
    // (例如同 chrome profile 多个 ERP 店共享一个 Temu 登录账号时)
    const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
    if (capturedMall && String(capturedMall) !== String(mallId)) {
      // 把脏缓存清掉,下次任务来再 capture 一次(用户可能切登过来了)
      await invalidateSession(mallId);
      throw Object.assign(
        new Error(`MALL_MISMATCH: task expects mallId=${mallId} but chrome is logged in as ${capturedMall}`),
        { code: 'MALL_MISMATCH', expectedMallId: mallId, capturedMallId: capturedMall },
      );
    }

    // 校验通过才写缓存(只在 fresh capture 时;HIT 路径不重复写)
    if (freshlyCaptured) {
      await setCachedSession(mallId, session.headers, session.origin, session.mallId);
    }

    checkAbort();
    const targetUrl = `${session.origin}${spec.apiUrlPattern}`;
    try {
      rawItems = await paginatedFetchInSW(spec, payload, targetUrl, session.headers, signal);
      // 成功 — 跳出重试循环
      lastErr = null;
      break;
    } catch (e) {
      if (e?.code === 'RATE_LIMITED') {
        lastErr = e;
        if (attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          continue;  // 还有重试机会
        }
        // 最后一次也限流 → 写短冷却 + 上抛
        await setMallCooldown(mallId, e.retryAfterMs, `after ${RATE_LIMIT_RETRY_DELAYS_MS.length} inline retries: ` + (e.message?.slice(0, 160) ?? ''));
        throw e;
      }
      // 非限流错误:直接上抛,不重试
      throw e;
    }
  }

  // transform
  checkAbort();
  let transformed;
  try {
    transformed = spec.transform(rawItems, payload);
  } catch (e) {
    throw Object.assign(new Error(`TRANSFORM_FAILED: ${e.message}`), { code: 'TRANSFORM_FAILED' });
  }
  return { rawItems, transformed };
}

// ── 第一次:开 tab → 等 page 自然发请求 → Request Proxy 捕获 headers → 关 tab ──
// 返回 { headers, origin }
async function captureSessionViaTab(spec, payload, signal) {
  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const CAPTURE_TIMEOUT_MS = 30_000;

  let tabId = null;
  let onUpdatedListener = null;
  const cleanup = async () => {
    if (onUpdatedListener) {
      try { chrome.tabs.onUpdated.removeListener(onUpdatedListener); } catch {}
      onUpdatedListener = null;
    }
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch {}
      tabId = null;
    }
  };

  try {
    const resolvedPageUrl = typeof spec.pageUrl === 'function' ? spec.pageUrl(payload) : spec.pageUrl;
    const tab = await chrome.tabs.create({ url: resolvedPageUrl, active: true, pinned: false });
    tabId = tab.id;

    // 等 tab 加载完
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      onUpdatedListener = (uTabId, changeInfo) => {
        if (uTabId === tabId && changeInfo.status === 'complete') resolve();
      };
      chrome.tabs.onUpdated.addListener(onUpdatedListener);
      const poll = setInterval(async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          if (t?.status === 'complete') { clearInterval(poll); resolve(); return; }
        } catch (e) { clearInterval(poll); reject(e); return; }
        if (Date.now() - startedAt > TAB_LOAD_TIMEOUT_MS) {
          clearInterval(poll);
          reject(Object.assign(new Error('TAB_LOAD_TIMEOUT'), { code: 'TAB_LOAD_TIMEOUT' }));
        }
      }, 500);
    });
    if (onUpdatedListener) {
      try { chrome.tabs.onUpdated.removeListener(onUpdatedListener); } catch {}
      onUpdatedListener = null;
    }

    // executeScript:只捕 headers,不 fetch(fetch 移到 SW 上下文)
    // ★ captureApiUrlPattern 优先:detail 接口页面不会主动发,要等 list 请求来捕 mallId/anti-content
    //   headers(同 mallId session 跨 path 通用),fetch 时仍走原 spec.apiUrlPattern。
    const captureUrlPattern = spec.captureApiUrlPattern ?? spec.apiUrlPattern;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureHeadersInTab,
      args: [{
        apiUrlPattern: captureUrlPattern,
        captureTimeoutMs: CAPTURE_TIMEOUT_MS,
      }],
    });
    if (!result || result.ok !== true) {
      // ★ capture 失败时,先看 tab 是不是被 redirect 到登录页 — 这是子域 token 过期
      // 最常见的症状。识别到了就标 LOGIN_REQUIRED + 更新 loginHealth,popup 实时反映。
      const regionKey = regionKeyFromPageUrl(resolvedPageUrl);
      let currentUrl = null;
      try {
        const t = await chrome.tabs.get(tabId);
        currentUrl = t?.url || null;
      } catch {}
      const isLoginRedirect = currentUrl && /\/(login|sign-?in|auth|oauth|seller-login)/i.test(currentUrl);
      if (isLoginRedirect && regionKey) {
        await updateLoginHealth(regionKey, 'expired', `redirected to login: ${currentUrl}`);
        throw Object.assign(
          new Error(`LOGIN_REQUIRED: ${regionKey} 子域 token 已过期,需要重新登录 (now at ${currentUrl})`),
          { code: 'LOGIN_REQUIRED', region: regionKey, currentUrl },
        );
      }
      if (regionKey) await updateLoginHealth(regionKey, 'unknown', result?.error ?? 'capture failed');
      throw Object.assign(
        new Error(`CAPTURE_FAILED: ${result?.error ?? 'unknown'} (phase=${result?.phase ?? 'n/a'})`),
        { code: 'CAPTURE_FAILED', detail: result },
      );
    }
    // ★ 成功 — region 已确认登录态有效
    const okRegionKey = regionKeyFromPageUrl(resolvedPageUrl);
    if (okRegionKey) await updateLoginHealth(okRegionKey, 'ok', null);
    const capturedMallId = extractMallIdFromHeaders(result.headers);
    return { headers: result.headers, origin: result.origin, mallId: capturedMallId };
  } finally {
    await cleanup();
  }
}

// SW 上下文分页 fetch — 用 captured headers 直接 fetch,host_permissions 保证 cookies 带上
async function paginatedFetchInSW(spec, payload, url, capturedHeaders, signal) {
  const checkAbort = () => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
  };
  const headers = { ...capturedHeaders, 'content-type': 'application/json' };
  const bodyTemplate = spec.buildBody(payload);
  const mode = spec.paginationMode ?? 'pageNo';
  const pageSize = spec.pageSize ?? 50;
  const maxPages = 200;
  const collected = [];
  const getPath = (obj, path) => {
    if (!path) return undefined;
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  };

  let pageNo = 1;
  let cursor = null;
  let iter = 0;

  while (iter < maxPages) {
    checkAbort();
    let body;
    if (mode === 'scroll') {
      body = { ...bodyTemplate };
      if (cursor) body[spec.cursorInKey ?? 'scrollContext'] = cursor;
    } else if (mode === 'single') {
      // 不分页 — 单次 fetch,适合 detail 这类一次性返完整数据的接口
      body = { ...bodyTemplate };
    } else {
      // pageNo/pageSize 默认字段名为 pageNo,但部分接口要 pageNum(detail / flow analysis)
      const pNoKey = spec.pageNoKey ?? 'pageNo';
      const pSizeKey = spec.pageSizeKey ?? 'pageSize';
      body = { ...bodyTemplate, [pNoKey]: pageNo, [pSizeKey]: pageSize };
    }

    const resp = await fetch(url, {
      method: spec.method,
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
    // 限流检测(HTTP 层):429 + Retry-After
    if (resp.status === 429) {
      const retryAfterSec = Number(resp.headers.get('Retry-After')) || 0;
      throw rateLimitedError({
        retryAfterMs: retryAfterSec ? retryAfterSec * 1000 : null,
        httpStatus: 429,
        msg: `HTTP 429 Too Many Requests${retryAfterSec ? ` (Retry-After=${retryAfterSec}s)` : ''}`,
      });
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw Object.assign(
        new Error(`TEMU_FETCH_FAILED: HTTP ${resp.status}: ${txt.slice(0, 300)}`),
        { code: 'TEMU_FETCH_FAILED' },
      );
    }
    let data;
    try { data = await resp.json(); }
    catch (e) { throw Object.assign(new Error(`PARSE_FAILED: ${e.message}`), { code: 'PARSE_FAILED' }); }

    // 限流检测(应用层):Temu 经常 HTTP 200 + body 里塞 error_code/error_msg。
    // 走 detectRateLimit 启发式判断,命中就抛 RATE_LIMITED 让上游做冷却。
    const rl = detectRateLimitInBody(data);
    if (rl) {
      throw rateLimitedError({
        retryAfterMs: rl.retryAfterMs ?? null,
        httpStatus: 200,
        msg: `Temu rate-limited: ${rl.reason}`,
      });
    }

    const list = getPath(data, spec.listPath);
    if (!Array.isArray(list)) {
      throw Object.assign(
        new Error(`SHAPE_BAD: listPath '${spec.listPath}' not array; keys: ${Object.keys(data || {}).join(',')}`),
        { code: 'SHAPE_BAD' },
      );
    }
    collected.push(...list);

    if (mode === 'scroll') {
      if (!getPath(data, spec.hasMorePath)) break;
      cursor = getPath(data, spec.cursorOutPath);
      if (!cursor) break;
    } else if (mode === 'single') {
      // 单次 fetch 模式 — 一次就够,直接退出
      break;
    } else {
      if (list.length === 0) break;
      if (spec.totalPath) {
        const total = Number(getPath(data, spec.totalPath) ?? list.length);
        const lastPage = Math.ceil(total / pageSize) || 1;
        if (pageNo >= lastPage) break;
      } else if (list.length < pageSize) {
        break;
      }
      pageNo++;
    }
    iter++;
  }
  return collected;
}

// 这个函数会被 chrome.scripting.executeScript 序列化注入到 tab MAIN world,
// 不能引用外部闭包变量,所有依赖通过 args 传入。
//
// 职责: ONLY capture headers — 不再分页 fetch(那个移到 SW 端 paginatedFetchInSW)。
//
// 流程:
//   1. Patch Request 构造器 — page 后续发起的所有 fetch 都会经过这个 proxy
//   2. 命中 apiUrlPattern 时抓 URL+headers(含 anti-content / mallid / content-type)
//   3. 2s 内没捕获就尝试 click 一个 nav tab 强制触发刷新
//   4. 拿到 captured 后立即返回(SW 端会关 tab)
function captureHeadersInTab(spec) {
  return (async () => {
    try {
      const captured = { resolved: false, url: null, headers: null, refreshTry: 0 };
      const ReqOrig = window.Request;
      window.Request = new Proxy(ReqOrig, {
        construct(target, args) {
          const inst = new target(...args);
          try {
            if (!captured.resolved && typeof inst.url === 'string' && inst.url.includes(spec.apiUrlPattern)) {
              const h = {};
              inst.headers.forEach((v, k) => { h[k] = v; });
              captured.url = inst.url;
              captured.headers = h;
              captured.resolved = true;
            }
          } catch {}
          return inst;
        }
      });

      const startedAt = Date.now();
      while (!captured.resolved) {
        if (Date.now() - startedAt > spec.captureTimeoutMs) {
          return {
            ok: false,
            phase: 'capture-timeout',
            error: `page never called ${spec.apiUrlPattern} within ${spec.captureTimeoutMs}ms`,
          };
        }
        // 2s 还没捕获就 click 个 nav tab 强制 SPA 重渲染
        if (Date.now() - startedAt > 2000 && captured.refreshTry === 0) {
          captured.refreshTry++;
          try {
            const candidates = Array.from(document.querySelectorAll('a, [role="tab"], button'));
            const target = candidates.find(el => {
              const t = (el.textContent || '').trim();
              return t === '营销活动首页' || t === '报名记录' || t === '活动机遇商品'
                  || t === '商品流量' || t === '店铺流量' || t === '查询';
            });
            if (target) target.click();
          } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // 解析 origin —— SW 后续会用 origin + 不同 apiUrlPattern 拼新 URL 复用 headers
      let origin;
      try {
        origin = new URL(captured.url).origin;
      } catch {
        origin = 'https://agentseller.temu.com';  // fallback
      }
      return { ok: true, origin, headers: captured.headers, capturedUrl: captured.url };
    } catch (e) {
      return { ok: false, phase: 'unknown', error: String(e?.message ?? e) };
    }
  })();
}

// 旧版 runFetchInTab 已不再使用(SW 端接管分页 fetch),保留 stub 兼容性避免外部 import 报错
function runFetchInTab(fetchSpec) {
  return (async () => {
    try {
      const captured = { resolved: false, url: null, headers: null, refreshTry: 0 };
      const ReqOrig = window.Request;
      window.Request = new Proxy(ReqOrig, {
        construct(target, args) {
          const inst = new target(...args);
          try {
            if (!captured.resolved && typeof inst.url === 'string' && inst.url.includes(fetchSpec.apiUrlPattern)) {
              const h = {};
              inst.headers.forEach((v, k) => { h[k] = v; });
              captured.url = inst.url;
              captured.headers = h;
              captured.resolved = true;
            }
          } catch {}
          return inst;
        }
      });

      // 等捕获,带主动触发 fallback
      const startedAt = Date.now();
      while (!captured.resolved) {
        if (Date.now() - startedAt > fetchSpec.captureTimeoutMs) {
          return {
            ok: false,
            phase: 'capture-timeout',
            error: `page never called ${fetchSpec.apiUrlPattern} within ${fetchSpec.captureTimeoutMs}ms`,
          };
        }
        // 2s 还没捕获:可能是 inject 晚于 page 首次 fetch,主动 click 一个 nav tab 强制 SPA 重渲染
        if (Date.now() - startedAt > 2000 && captured.refreshTry === 0) {
          captured.refreshTry++;
          try {
            const candidates = Array.from(document.querySelectorAll('a, [role="tab"], button'));
            const target = candidates.find(el => {
              const t = (el.textContent || '').trim();
              return t === '营销活动首页' || t === '报名记录' || t === '活动机遇商品'
                  || t === '商品流量' || t === '店铺流量' || t === '查询';
            });
            if (target) target.click();
          } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // 用借来的 headers 自己分页(支持 pageNo 和 scroll 两种模式)
      const headers = { ...captured.headers, 'content-type': 'application/json' };
      const url = captured.url;
      const collected = [];
      const getPath = (obj, path) => {
        if (!path) return undefined;
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
      };
      const mode = fetchSpec.paginationMode || 'pageNo';
      let pageNo = 1;
      let cursor = null;
      let iter = 0;

      while (iter < fetchSpec.maxPages) {
        // 构造本页 body — pageNo 模式注入 pageNo+pageSize,scroll 模式注入 cursor
        let body;
        if (mode === 'scroll') {
          body = { ...fetchSpec.bodyTemplate };
          if (cursor) body[fetchSpec.cursorInKey] = cursor;
        } else {
          body = { ...fetchSpec.bodyTemplate, pageNo, pageSize: fetchSpec.pageSize };
        }

        const resp = await fetch(url, {
          method: fetchSpec.method,
          credentials: 'include',
          headers,
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          return { ok: false, phase: 'http', error: `HTTP ${resp.status}: ${txt.slice(0, 300)}` };
        }
        let data;
        try { data = await resp.json(); }
        catch (e) { return { ok: false, phase: 'parse', error: e.message }; }

        const list = getPath(data, fetchSpec.listPath);
        if (!Array.isArray(list)) {
          return {
            ok: false, phase: 'shape',
            error: `listPath '${fetchSpec.listPath}' not array; keys: ${Object.keys(data || {}).join(',')}`,
          };
        }
        collected.push(...list);

        // 分页结束判定
        if (mode === 'scroll') {
          const hasMore = !!getPath(data, fetchSpec.hasMorePath);
          if (!hasMore) break;
          cursor = getPath(data, fetchSpec.cursorOutPath);
          if (!cursor) break;  // 防御:hasMore=true 但没 cursor 时也退出
        } else {
          if (list.length === 0) break;
          if (fetchSpec.totalPath) {
            const total = Number(getPath(data, fetchSpec.totalPath) ?? list.length);
            const lastPage = Math.ceil(total / fetchSpec.pageSize) || 1;
            if (pageNo >= lastPage) break;
          } else if (list.length < fetchSpec.pageSize) {
            break;
          }
          pageNo++;
        }
        iter++;
      }
      return { ok: true, items: collected, pages: iter + 1 };
    } catch (e) {
      return { ok: false, phase: 'unknown', error: String(e?.message ?? e) };
    }
  })();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      }, { once: true });
    }
  });
}

// ── 上报 ─────────────────────────────────────────────────────────
async function reportResult(taskId, pluginInstanceId, payload) {
  try {
    await api(`/api/agent/tasks/${taskId}/result`, {
      method: 'POST',
      body: JSON.stringify({ pluginInstanceId, ...payload }),
    });
  } catch (e) {
    console.error(`[agent] result ${taskId} 上报失败:`, e.message);
  }
}

async function sendHeartbeat(taskId, pluginInstanceId) {
  await api(`/api/agent/tasks/${taskId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ pluginInstanceId, leaseSeconds: LEASE_SECONDS }),
  });
}

// ── 启动 ─────────────────────────────────────────────────────────
export function startAgent() {
  Promise.resolve(chrome.alarms.clear(ALARM_NAME))
    .catch(() => {})
    .finally(() => chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN }));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      pollOnce().catch((e) => console.error('[agent] poll err:', e));
    }
  });
  // Service worker 唤醒后立刻拉一次（不必等下个 alarm 周期）
  pollOnce().catch(() => {});
  console.log(`[agent ${AGENT_BUILD_ID}] 已启动，每 ${POLL_PERIOD_MIN * 60}s 拉一次任务 url=${AGENT_IMPORT_URL}`);
}

// 让 popup 通过 message 强制立刻拉一次
export function attachMessageHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'AGENT_DIAG') {
      Promise.all([
        chrome.alarms.getAll().catch(() => []),
        chrome.storage.local.get(['apiUrl', 'pluginInstanceId', 'selectedShopIds']).catch(() => ({})),
      ]).then(([alarms, cfg]) => {
        sendResponse({
          ok: true,
          ...agentDiag(),
          alarms,
          config: {
            apiUrl: cfg.apiUrl ?? null,
            pluginInstanceId: cfg.pluginInstanceId ? `${String(cfg.pluginInstanceId).slice(0, 8)}...` : null,
            selectedShopIds: cfg.selectedShopIds ?? null,
          },
        });
      }).catch((e) => sendResponse({ ok: false, error: e.message, ...agentDiag() }));
      return true;
    }
    if (msg.type === 'AGENT_PULL_NOW') {
      pollOnce().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
}
