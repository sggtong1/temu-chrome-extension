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
} from './transform/sku_transform.js';

const POLL_PERIOD_MIN  = 1 / 6;   // 10s
const HEARTBEAT_PERIOD = 60_000;  // 60s
const CLAIM_LIMIT      = 3;       // 每次最多领 3 个
const LEASE_SECONDS    = 300;     // 5min 租约
const ALARM_NAME       = 'agent-poll';

// Bump this when diagnosing Chrome MV3 service-worker/module cache issues.
// It is written into logs and successful task results, so we can prove which
// evaluated module, not just which fetched source file, handled a task.
const AGENT_BUILD_ID   = 'agent-real-declared-price-20260517a';
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
    buildBody: (_payload) => ({}),
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

    // 其他 scrape:* kinds 暂时仍 stub, 后续 plan 接入
    case 'scrape:settlement':
    case 'scrape:flux-analysis':
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
    case 'submit:price-confirm':
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

async function setCachedSession(mallId, headers, origin) {
  const entry = { headers, origin, expiresAt: Date.now() + SESSION_TTL_MS };
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
  let session = await getCachedSession(mallId);

  if (!session) {
    console.log(`[agent ${AGENT_BUILD_ID}] session MISS mall=${mallId} — capturing via tab`);
    checkAbort();
    session = await captureSessionViaTab(spec, payload, signal);
    await setCachedSession(mallId, session.headers, session.origin);
  } else {
    console.log(`[agent ${AGENT_BUILD_ID}] session HIT mall=${mallId} — skipping tab(SW fetch)`);
  }

  // SW 上下文分页 fetch — host_permissions + credentials:include → cookies 自动带
  checkAbort();
  const targetUrl = `${session.origin}${spec.apiUrlPattern}`;
  const rawItems = await paginatedFetchInSW(spec, payload, targetUrl, session.headers, signal);

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
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureHeadersInTab,
      args: [{
        apiUrlPattern: spec.apiUrlPattern,
        captureTimeoutMs: CAPTURE_TIMEOUT_MS,
      }],
    });
    if (!result || result.ok !== true) {
      throw Object.assign(
        new Error(`CAPTURE_FAILED: ${result?.error ?? 'unknown'} (phase=${result?.phase ?? 'n/a'})`),
        { code: 'CAPTURE_FAILED', detail: result },
      );
    }
    return { headers: result.headers, origin: result.origin };
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
    } else {
      body = { ...bodyTemplate, pageNo, pageSize };
    }

    const resp = await fetch(url, {
      method: spec.method,
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
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
              return t === '营销活动首页' || t === '报名记录' || t === '活动机遇商品';
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
              return t === '营销活动首页' || t === '报名记录' || t === '活动机遇商品';
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
