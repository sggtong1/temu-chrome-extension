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
const AGENT_BUILD_ID   = 'agent-semi-sales-20260605a';

// plugin 能处理的 task kind 列表 — claim 时上报给 server,server 据此过滤派单
// 老 plugin 不会上报这个,server 兼容路径会给它派所有 kind(但 dispatch 不认识就抛 UNSUPPORTED_KIND)
const SUPPORTED_KINDS = [
  'scrape:marketing-activity',
  'scrape:activity-products',
  'scrape:sales-30d',
  'scrape:activity-data',
  'scrape:declared-price',
  'scrape:lifecycle-management',
  'scrape:flux-analysis',
  'scrape:flux-analysis-detail',
  'scrape:settlement',
  'submit:price-confirm',
  'submit:activity-enroll',
];

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

// 等 tab 加载完成(complete 状态)。timeout 触发抛 TAB_LOAD_TIMEOUT。
export async function waitTabComplete(tabId, signal, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const onUpdated = (uTabId, changeInfo) => {
      if (uTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearInterval(poll);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const poll = setInterval(async () => {
      if (signal?.aborted) {
        clearInterval(poll);
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        return;
      }
      try {
        const t = await chrome.tabs.get(tabId);
        if (t?.status === 'complete') {
          clearInterval(poll);
          try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
          resolve();
          return;
        }
      } catch (e) {
        clearInterval(poll);
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
        reject(e);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll);
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
        reject(Object.assign(new Error('TAB_LOAD_TIMEOUT'), { code: 'TAB_LOAD_TIMEOUT' }));
      }
    }, 500);
  });
}

// ── 登录流转 URL 识别 ────────────────────────────────────────────
// 子域 token 过期后 Temu 把 tab 跳到:
//  - agentseller(-eu/-us).temu.com/auth/authentication?redirectUrl=…  — portal(图1)
//  - seller.kuajingmaihuo.com/settle/seller-login?redirectUrl=…       — kjmh SSO 中转 / 登陆表单(图2)
//  - 其它子域 /login /sign-in 路径(少见)
// ★ kjmh /main 是 user dashboard 主页(已登 kjmh 时正常),不能视为 login flow,
//   否则 handleRecheckLogin 第一步 nav kjmh/main 就被当 expired。
export function isLoginFlowUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // 明确的认证 path
  if (/\/(seller-login|sign-?in|authentication)/i.test(url)) return true;
  if (/\/login(\b|\?|\/)/i.test(url)) return true;
  return false;
}

// ── 自动登陆 v2:SSO via kjmh userInfo(2026-05-26)──────────────
// 机制:Sellfox 实测验证 — kjmh `userInfo` API 返回的 `userId` 等价于 SSO `validateid`,
// 跨 3 个子域(global / eu / us)同一个值。流程:
//   1. SW fetch kjmh `/bg/quiet/api/mms/userInfo` 拿 userId(依赖 kjmh 主域 cookies)
//   2. 根据当前 tab URL 推断要登的子域(global=1 / eu=2 / us=3)
//   3. chrome.tabs.update 到 `https://agentseller-<region>.temu.com/settle/seller-login?validateid=<userId>&region=<N>`
//   4. 子域 server 用 validateid 完成 SSO,自动 302 回业务页
// 整个流程 < 3s,无任何 DOM click。kjmh 主域 token 也过期才会 fail(此时只能 user 手动登)。

// region 编号 ←→ host 映射。验证来源:
//   - Sellfox 实测:agentseller.temu.com → region=1
//   - User 实测:agentseller-eu.temu.com → region=2
//   - 推测:agentseller-us.temu.com → region=3(待 user 验证)
const REGION_SSO_MAP = {
  global: { host: 'agentseller.temu.com',    regionNum: 1 },
  eu:     { host: 'agentseller-eu.temu.com', regionNum: 2 },
  us:     { host: 'agentseller-us.temu.com', regionNum: 3 },
};

// 解析"当前 tab URL"该属于哪个子域。
// 优先看 hostname,然后看 portal URL 里 redirectUrl 参数指向哪个子域。
function inferRegionKeyForSSO(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const directMap = {
      'agentseller.temu.com':    'global',
      'agentseller-eu.temu.com': 'eu',
      'agentseller-us.temu.com': 'us',
    };
    if (directMap[u.hostname]) return directMap[u.hostname];
    // portal URL: `?redirectUrl=https%3A%2F%2Fagentseller-X.temu.com%2F...`
    const m = url.match(/[?&]redirectUrl=([^&]+)/);
    if (m) {
      const decoded = decodeURIComponent(m[1]);
      const ru = new URL(decoded);
      if (directMap[ru.hostname]) return directMap[ru.hostname];
    }
  } catch {}
  return null;
}

// userId 5 分钟缓存,避免重复 fetch
const _userIdCache = { value: null, mallId: null, expiresAt: 0 };

// ★ 在指定 tab(必须已在 kjmh 主域 page context 上)拿 userId + mallId。
//   返回 { userId, mallId } 或 { error }。
//   mallId 是 SSO URL 必需参数(Sellfox URL pattern: ?init=true&mallId&uId&validateid)。
export async function fetchKjmhUserIdInTab(tabId, signal) {
  if (_userIdCache.value && _userIdCache.mallId && Date.now() < _userIdCache.expiresAt) {
    return { userId: _userIdCache.value, mallId: _userIdCache.mallId, fromCache: true };
  }
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });

  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        try {
          const resp = await fetch('/bg/quiet/api/mms/userInfo', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (!resp.ok) return { error: `http-${resp.status}` };
          const data = await resp.json();
          if (!data?.success) return { error: `api-failed: ${data?.errorCode}/${data?.errorMsg}` };
          const userId = data?.result?.userId;
          if (userId == null) return { error: 'userid-missing' };
          // mallId:companyList[0].malInfoList[0].mallId(跟 Sellfox 取法一致)
          const mallId = data?.result?.companyList?.[0]?.malInfoList?.[0]?.mallId;
          return { userId: String(userId), mallId: mallId != null ? String(mallId) : '' };
        } catch (e) {
          return { error: `fetch: ${e?.message}` };
        }
      },
    });
    const result = r?.result || { error: 'no-result' };
    if (result.userId) {
      _userIdCache.value = result.userId;
      _userIdCache.mallId = result.mallId || '';
      _userIdCache.expiresAt = Date.now() + 5 * 60_000;
    }
    return result;
  } catch (e) {
    return { error: `exec: ${e?.message}` };
  }
}

// (清理:waitSsoComplete 已删除 — Sellfox SSO 流程无 dialog click)

// ★ Sellfox 实测路径:调 kjmh `/bg/quiet/api/auth/obtainCode` API 预授权 server-side state,
//   然后直接 navigate 同 tab 到子域 `/?validateid=<userId>` —— server 看预授权状态接受 SSO,
//   不弹 confirm dialog,不需要任何 click。
// 子域中文显示名
const REGION_DISPLAY_NAME = { global: '全球', us: '美区', eu: '欧区' };

export async function runSsoForRegion(tabId, regionKey, userId, signal, mallId = '') {
  const region = REGION_SSO_MAP[regionKey];
  const regionName = REGION_DISPLAY_NAME[regionKey] || regionKey;
  const actions = [];
  const log = (msg) => console.log(`[Temu授权] ${msg}`);
  const step = (msg) => { actions.push(msg); log(`  ${msg}`); };

  if (!region) {
    step(`✗ 未知区域: ${regionKey}`);
    return { ok: false, reason: 'unknown-region', actions };
  }
  const baseUrl = `https://${region.host}`;
  log(`—— 区域: ${regionName} (${region.host}) ——`);

  // 1. 同 tab nav kjmh main
  step('1. 跳转商家中心建立 referrer');
  try {
    await chrome.tabs.update(tabId, { url: 'https://seller.kuajingmaihuo.com/main' });
    await waitTabComplete(tabId, signal, 15_000);
  } catch (e) {
    step(`✗ 跳转商家中心失败: ${e?.message}`);
    return { ok: false, reason: 'kjmh-nav-failed', actions };
  }
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      step('✗ 商家中心登录态失效');
      return { ok: false, reason: 'kjmh-not-logged-in', actions };
    }
  } catch {}
  await sleep(500, signal);

  // 2. obtainCode 预授权
  step('2. 调用 obtainCode 预授权');
  let codeResult;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (redirectUrl) => {
        try {
          const resp = await fetch('/bg/quiet/api/auth/obtainCode', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirectUrl }),
          });
          if (!resp.ok) return { error: `http-${resp.status}` };
          const data = await resp.json();
          if (data?.result?.code) return { code: data.result.code, success: data.success };
          return { error: `no-code: errorCode=${data?.errorCode} errorMsg=${data?.errorMsg}` };
        } catch (e) {
          return { error: `fetch: ${e?.message}` };
        }
      },
      args: [`${baseUrl}/main/authentication`],
    });
    codeResult = r?.result;
  } catch (e) {
    step(`✗ obtainCode 调用失败(执行错误): ${e?.message}`);
    return { ok: false, reason: 'obtainCode-exec-error', actions };
  }
  if (!codeResult?.code) {
    step(`✗ obtainCode 调用失败: ${codeResult?.error || 'unknown'}`);
    return { ok: false, reason: `obtainCode-failed-${codeResult?.error || 'unknown'}`, actions };
  }
  step(`   ↳ 授权码 ${codeResult.code.slice(0, 24)}…(共 ${codeResult.code.length} 字符)`);

  // 3. nav tab 到子域 (即使被 redirect 到子域 portal,page origin = 子域,后续 fetch loginByCode 同源)
  //    Sellfox 走法:content script 注入到所有子域,所以子域 page 上调用 loginByCode 是同源,不会被 CORS 拦。
  step('3. 跳转子域(切换 page origin 为 ' + region.host + ')');
  try {
    await chrome.tabs.update(tabId, { url: `${baseUrl}/labor/bill` });
    await waitTabComplete(tabId, signal, 15_000);
  } catch (e) {
    step(`✗ 跳转子域失败: ${e?.message}`);
    return { ok: false, reason: 'subdomain-nav-failed', actions };
  }
  await sleep(500, signal);

  // 4. 在子域 page context (same origin) fetch loginByCode
  step('4. 调用子域 loginByCode 完成登录');
  let loginResult;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (body) => {
        try {
          const resp = await fetch('/api/seller/auth/loginByCode', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await resp.json().catch(() => null);
          return { ok: resp.ok, status: resp.status, success: data?.success, errorMsg: data?.errorMsg, errorCode: data?.errorCode };
        } catch (e) {
          return { error: e?.message };
        }
      },
      args: [{ code: codeResult.code, confirm: true, targetMallId: mallId ? Number(mallId) : undefined }],
    });
    loginResult = r?.result;
  } catch (e) {
    step(`✗ loginByCode 执行错误: ${e?.message}`);
    return { ok: false, reason: 'loginByCode-exec-error', actions };
  }
  if (!loginResult || loginResult.error) {
    step(`✗ loginByCode 网络错误: ${loginResult?.error}`);
    return { ok: false, reason: 'loginByCode-network-error', actions };
  }
  if (!loginResult.ok) {
    step(`✗ loginByCode HTTP ${loginResult.status}`);
    return { ok: false, reason: `loginByCode-http-${loginResult.status}`, actions };
  }
  if (loginResult.success === false) {
    step(`✗ loginByCode 业务失败: ${loginResult.errorCode}/${loginResult.errorMsg}`);
    return { ok: false, reason: `loginByCode-biz-${loginResult.errorCode}`, actions };
  }
  step(`✓ ${regionName} 授权完成 (子域 cookies 已写入)`);
  return { ok: true, finalUrl: null, actions };
}

// 单个 task 流程(captureSessionViaTab 等)中检测到 login redirect 调用。
// 用调用方提供的 tab(原本在 agentseller 子域上),先 nav 它去 kjmh main 拿 userId + 建 referrer,
// 然后 nav SSO URL → 等完成。调用方负责 SSO 完事后把 tab navigate 回任务页。
export async function attemptAutoLogin(tabId, signal) {
  const actions = [];
  const log = (msg) => console.log(`[Temu授权] ${msg}`);
  const step = (msg) => { actions.push(msg); log(`  ${msg}`); };

  log('▶ 任务流程触发自动授权');

  // 0. 已不在 login flow 了 → 直接 ok
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.url && !isLoginFlowUrl(t.url)) {
      step(`✓ 当前 URL 不在登录流程,无需操作`);
      return { ok: true, finalUrl: t.url, actions };
    }
  } catch {}

  // 1. 推断 region(从当前 URL)
  let initialUrl = null;
  try { const t = await chrome.tabs.get(tabId); initialUrl = t?.url || ''; } catch {}
  const regionKey = inferRegionKeyForSSO(initialUrl);
  if (!regionKey) {
    step(`✗ 无法识别区域(当前 URL: ${(initialUrl || '').slice(0, 80)})`);
    return { ok: false, reason: 'region-unknown', actions };
  }
  const regionName = REGION_DISPLAY_NAME[regionKey] || regionKey;
  step(`识别区域: ${regionName} (${regionKey})`);

  // 2. 拿 userId(cache 优先)
  let userId = null;
  if (_userIdCache.value && Date.now() < _userIdCache.expiresAt) {
    userId = _userIdCache.value;
    step(`使用缓存的 userId = ${userId}`);
  } else {
    step('跳转商家中心获取 userId');
    try {
      await chrome.tabs.update(tabId, { url: 'https://seller.kuajingmaihuo.com/main' });
      await waitTabComplete(tabId, signal, 15_000);
    } catch (e) {
      step(`✗ 跳转商家中心失败: ${e?.message}`);
      return { ok: false, reason: 'kjmh-nav-failed', actions };
    }
    try {
      const t = await chrome.tabs.get(tabId);
      if (t?.url && isLoginFlowUrl(t.url)) {
        step('✗ 商家中心登录态失效,需手动登录');
        return { ok: false, reason: 'kjmh-not-logged-in', actions };
      }
    } catch {}
    await sleep(800, signal);
    const res = await fetchKjmhUserIdInTab(tabId, signal);
    if (!res?.userId) {
      step(`✗ 获取 userId 失败: ${res?.error}`);
      return { ok: false, reason: `userid-failed-${res?.error || 'unknown'}`, actions };
    }
    userId = res.userId;
    step(`✓ 获取 userId = ${userId}${res.mallId ? ` | mallId = ${res.mallId}` : ''}`);
  }
  const mallId = _userIdCache.mallId || '';

  // 3. 跑 SSO
  const r = await runSsoForRegion(tabId, regionKey, userId, signal, mallId);
  actions.push(...r.actions);
  return { ok: r.ok, finalUrl: r.finalUrl, reason: r.reason, actions };
}

// (清理:clickSsoConfirmDialog 已删除)
// DEPRECATED placeholder — 老 form-click 路径已废除,保留空 export 防止 import 失败。

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
    console.warn(`[Temu后台] updateLoginHealth(${regionKey}=${status}) failed:`, e?.message);
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
  console.log('生成 pluginInstanceId:', id);
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
        kinds: SUPPORTED_KINDS,                    // capability dispatch — server 只派我会的 kind
        buildId: AGENT_BUILD_ID,
        extensionId: chrome.runtime?.id,
        manifestVersion: chrome.runtime?.getManifest?.()?.version,
        limit: CLAIM_LIMIT,
        leaseSeconds: LEASE_SECONDS,
      }),
    });
  } catch (e) {
    console.warn(`[Temu后台] ✗ 领取任务失败: ${e.message}`);
    return;
  }

  const tasks = resp?.tasks || [];
  if (tasks.length === 0) return;
  console.log(`一、领取 ${tasks.length} 个任务:`, tasks.map((t) => taskKindLabel(t.kind)).join(' / '));
  for (const t of tasks) executeTask(t, pluginInstanceId);
}

// kind → 中文展示名
const KIND_LABELS = {
  'scrape:marketing-activity': '营销活动',
  'scrape:activity-products':  '活动可报商品',
  'scrape:sales-30d':          '近30天销量',
  'scrape:activity-data':      '活动报名记录',
  'scrape:declared-price':     '申报价确认',
  'scrape:lifecycle-management': '商品生命周期',
  'scrape:flux-analysis':      '流量分析',
  'scrape:flux-analysis-detail': '流量分析详情',
  'scrape:settlement':         '结算账单',
  'submit:price-confirm':      '核价确认',
  'submit:price-reject':       '核价驳回',
  'submit:activity-enroll':    '活动报名',
};
function taskKindLabel(kind) { return KIND_LABELS[kind] || kind; }

// ── 任务执行 ────────────────────────────────────────────────────
async function executeTask(task, pluginInstanceId) {
  if (_running.has(task.id)) return; // 重复防护

  const abort = new AbortController();
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(task.id, pluginInstanceId).catch((e) =>
      console.warn(`[Temu后台] heartbeat ${task.id.slice(0, 8)} 失败: ${e.message}`),
    );
  }, HEARTBEAT_PERIOD);
  _running.set(task.id, { abort, heartbeatTimer });

  const tid = task.id.slice(0, 8);
  const label = taskKindLabel(task.kind);
  console.log(`二、开始执行 [${tid}] ${label}`);

  try {
    const onProgress = (partial) => reportProgress(task.id, pluginInstanceId, partial);
    const result = await dispatch(task, abort.signal, onProgress);
    await reportResult(task.id, pluginInstanceId, { status: 'success', result });
    const count = Array.isArray(result?.rows) ? result.rows.length : '-';
    console.log(`四、✓ 完成 [${tid}] ${label} (${count} 条)`);
  } catch (e) {
    await reportResult(task.id, pluginInstanceId, {
      status: 'failed',
      errorCode: e.code || 'UNKNOWN',
      errorMessage: `[${AGENT_BUILD_ID}] ${String(e.message || e)}`.slice(0, 1500),
    });
    console.error(`四、✗ 失败 [${tid}] ${label}: ${e.message}`);
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
    // 半托 endpoint 路径推测同 namespace,需绑真半托店实测(同 scrape:sales-30d 模式)
    pageUrl: (payload) => payload?.shopType === 'semi'
      ? 'https://seller.kuajingmaihuo.com/activity/marketing-activity'
      : 'https://agentseller.temu.com/activity/marketing-activity',
    apiUrlPattern: (_payload) => '/api/kiana/gamblers/marketing/enroll/activity/list',
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
  // payload: { mallId, activityType, activityId(duoshou uuid), activityThematicId?(顶层活动可空) }
  // 顶层活动(官方大促/秒杀/清仓等)无 thematicId,Sellfox 路径(参 background.js 顶层活动分支):
  //   - pageUrl 用 marketing-activity 主页(不能编出 detail-new URL)
  //   - body 不传 activityThematicId,只传 activityType + rowCount + addSite
  //   - Temu server 自动返该活动所有可报商品
  'scrape:activity-products': {
    pageUrl: (payload) => payload.activityThematicId
      ? `https://agentseller.temu.com/activity/marketing-activity/detail-new?type=${payload.activityType}&thematicId=${payload.activityThematicId}`
      : `https://agentseller.temu.com/activity/marketing-activity`,
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/scroll/match',
    method: 'POST',
    paginationMode: 'scroll',
    cursorOutPath: 'result.searchScrollContext',
    hasMorePath: 'result.hasMore',
    cursorInKey: 'scrollContext',
    buildBody: (payload) => ({
      activityType: payload.activityType,
      ...(payload.activityThematicId ? { activityThematicId: payload.activityThematicId } : {}),
      rowCount: 50,
      addSite: true,            // Sellfox 顶层活动分支带这个
      filterUnsalableWarning: false,
    }),
    listPath: 'result.matchList',
    transform: (rawItems) => transformActivityProducts(rawItems),
  },
  // scrape:activity-data — 抓本店"已报名活动 SKU 价格"快照
  // payload: { mallId }  其他不需要(API 按 mallid header 隔离店铺)
  // 落库:ActivityEnrollment(一行 = shop × activity × session × SKU)
  'scrape:activity-data': {
    pageUrl: (payload) => payload?.shopType === 'semi'
      ? 'https://seller.kuajingmaihuo.com/activity/marketing-activity/log'
      : 'https://agentseller.temu.com/activity/marketing-activity/log',
    apiUrlPattern: (_payload) => '/api/kiana/gamblers/marketing/enroll/list',
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
    pageUrl: (payload) => payload?.shopType === 'semi'
      ? 'https://seller.kuajingmaihuo.com/newon/product-select'
      : 'https://agentseller.temu.com/newon/product-select',
    apiUrlPattern: (_payload) => '/api/kiana/mms/robin/searchForChainSupplier',
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
  // scrape:sales-30d — 近 30 天销量 + 库存(SKU 级 snapshot)
  // 全托 / 半托共用:按 payload.shopType 分支 pageUrl + apiUrlPattern
  //   - 全托管:agentseller.temu.com 销售管理页 → listOverall
  //   - 半托管:seller.kuajingmaihuo.com 销售管理页 → querySkuSalesNumber(详见 docs/sellfox-plugin-rev-eng.md §3.2 + §3.6)
  // ★ 半托 endpoint 路径尚未实测(用户绑了真半托店之后才能跑通);path 来自 sellfox-crx 反编译
  'scrape:sales-30d': {
    pageUrl: (payload) => payload?.shopType === 'semi'
      ? 'https://seller.kuajingmaihuo.com/main/sale-manage/main'
      : 'https://agentseller.temu.com/stock/fully-mgt/sale-manage/main',
    apiUrlPattern: (payload) => payload?.shopType === 'semi'
      ? '/oms/bg/venom/api/supplier/sales/management/querySkuSalesNumber'
      : '/mms/venom/api/supplier/sales/management/listOverall',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    buildBody: (_payload) => ({ isLack: 0 }),
    listPath: 'result.subOrderList',
    totalPath: 'result.total',
    transform: (rawItems) => transformSales30dResponse(rawItems),
  },
  // 其他 4 个 scrape:* kind 由后续 plan 添加
};

// ── kind → 实际执行的派发表 ───────────────────────────────────────
// scrape:marketing-activity + scrape:activity-products 走实际 dispatch,
// 其他 5 个 scrape:* 暂时 stub。submit:* 留到第三阶段。
async function dispatch(task, signal, onProgress) {
  switch (task.kind) {
    case 'scrape:marketing-activity':   return dispatchMarketingActivity(task, signal);
    case 'scrape:activity-products':    return dispatchActivityProducts(task, signal);
    case 'scrape:sales-30d':            return dispatchSales30d(task, signal);
    case 'scrape:activity-data':        return dispatchActivityData(task, signal);
    case 'scrape:declared-price':       return dispatchDeclaredPrice(task, signal);
    case 'scrape:lifecycle-management': return dispatchLifecycleManagement(task, signal);
    case 'scrape:flux-analysis':        return dispatchFluxAnalysis(task, signal);
    case 'scrape:flux-analysis-detail': return dispatchFluxAnalysisDetail(task, signal);
    case 'scrape:settlement':           return dispatchSettlement(task, signal, onProgress);
    case 'submit:price-confirm':        return dispatchPriceConfirm(task, signal);
    case 'submit:activity-enroll':      return dispatchActivityEnroll(task, signal);

    case 'submit:price-reject':
      throw Object.assign(new Error('写操作还没接，第三阶段做'), { code: 'NOT_IMPLEMENTED' });
    default:
      // 不再 stub — 服务端会按 SUPPORTED_KINDS 过滤,理论上不会派不认识的 kind 给我们;
      // 真到了 default 说明 server-side 派单逻辑或 SUPPORTED_KINDS 没同步,fail-fast
      throw Object.assign(
        new Error(`UNSUPPORTED_KIND: plugin build=${AGENT_BUILD_ID} 不支持 kind=${task.kind};请升级插件或更新 SUPPORTED_KINDS`),
        { code: 'UNSUPPORTED_KIND' },
      );
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
// payload 必须有:mallId, activityType, activityId(duoshou uuid 用于 ingester)
// payload.activityThematicId 可选 — 顶层活动(官方大促/秒杀/清仓等)无 thematicId,
//   Sellfox 路径(参 background.js 顶层活动分支)= 同 endpoint 不传 thematicId
async function dispatchActivityProducts(task, signal) {
  const payload = task.payload ?? {};
  const required = ['mallId', 'activityType', 'activityId'];
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
    console.warn(`[Temu后台] flux-analysis: list 完成但 session 丢失(罕见),跳过 detail`);
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
            console.warn(`[Temu后台] detail rate-limited at SPU ${i + 1}/${candidates.length},停止 detail batch`);
            idx = candidates.length;       // 让其他 worker 也退出
            detailStats.failed++;
            return;
          }
          console.warn(`[Temu后台] detail fetch fail spu=${r.platformProductId}: ${e.message}`);
          detailStats.failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    console.log(`[Temu后台] flux-analysis detail batch: ` +
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
    console.log(`[Temu后台] submit session MISS mall=${mallId} — capturing`);
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
  console.log(`[Temu后台] enroll always fresh-capture (detail-new) thematic=${payload.thematicId}`);
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

// ── scrape:settlement 专用 wrapper(2026-05-24c: 多 variant)──────────
// 4 个 variant 各自在自己的域 create + poll + download(独立),不依赖跨域 id 翻译
//   - drIndex=0 (卖家中心): seller.kuajingmaihuo.com, taskType=19
//   - drIndex=1 (全球):    agentseller.temu.com,     taskType=31
//   - drIndex=2 (欧洲):    agentseller-eu.temu.com,  taskType=31
//   - drIndex=3 (美国):    agentseller-us.temu.com,  taskType=31
// payload.drIndex 指定单个 → 只跑那一个;否则跑所有 4 个,partial fail 不影响其他
// 任一 variant 失败不会抛 — 在 variants[i] 里返回 ok=false + error
// region 用 popup 同款短 key('global'/'eu'/'us'/'kjmh'),保证 updateLoginHealth() 写的
// key 跟 popup 读的 key 一致(否则实测结果永远显示不出来)
const SETTLEMENT_VARIANTS = [
  { drIndex: 0, name: '卖家中心', origin: 'https://seller.kuajingmaihuo.com', pageUrl: 'https://seller.kuajingmaihuo.com/labor/bill', taskType: 19, region: 'kjmh' },
  { drIndex: 1, name: '全球',     origin: 'https://agentseller.temu.com',    pageUrl: 'https://agentseller.temu.com/labor/bill',    taskType: 31, region: 'global' },
  { drIndex: 2, name: '欧洲',     origin: 'https://agentseller-eu.temu.com', pageUrl: 'https://agentseller-eu.temu.com/labor/bill', taskType: 31, region: 'eu' },
  { drIndex: 3, name: '美国',     origin: 'https://agentseller-us.temu.com', pageUrl: 'https://agentseller-us.temu.com/labor/bill', taskType: 31, region: 'us' },
];

async function dispatchSettlement(task, signal, onProgress) {
  const payload = task.payload ?? {};
  if (!payload.dateFrom || !payload.dateTo) {
    throw Object.assign(
      new Error('payload.dateFrom/dateTo missing for scrape:settlement'),
      { code: 'BAD_PAYLOAD' },
    );
  }
  // 必须显式加 +08:00 时区!Chrome SW context 对无 TZ 后缀的 date-time string
  // 解析为 UTC(不是 user 浏览器 local +08),会让 endTime 跨日导致跟 Temu history
  // row 的 day 比对差 1 天,Step 1 永远 miss
  const beginTime = new Date(`${payload.dateFrom}T00:00:00+08:00`).getTime();
  const endTime = new Date(`${payload.dateTo}T23:59:59.999+08:00`).getTime();
  if (!Number.isFinite(beginTime) || !Number.isFinite(endTime)) {
    throw Object.assign(new Error('invalid dateFrom/dateTo'), { code: 'BAD_PAYLOAD' });
  }
  const mallIdToSend = payload.mallId ? String(payload.mallId) : null;
  if (!mallIdToSend) {
    throw Object.assign(
      new Error('payload.mallId missing for scrape:settlement (server requires mallid header)'),
      { code: 'BAD_PAYLOAD' },
    );
  }

  // 架构(2026-05-24h 重构):
  //   1. 在 kjmh 上 create + poll + 下载 drIndex=0(卖家中心)— 唯一的 create
  //   2. kjmh exportRow 含 agentSellerExportParams + agentSellerExportSign(跨域票据)
  //   3. 对 drIndex 1/2/3:打开 agentseller-{region}.temu.com/labor/bill-download-with-detail?params=&sign=
  //      让页面 mount → MAIN world hook fetch 收集 XHR → 找到 fileUrl 或返回诊断
  // 注:暂不支持 payload.drIndex(因为 agentseller 依赖 kjmh row 的票据,必须先跑 kjmh)
  const kjmhVariant = SETTLEMENT_VARIANTS[0];
  const agentVariants = SETTLEMENT_VARIANTS.slice(1);

  console.log(`[Temu后台] settlement: kjmh + ${agentVariants.length} agentseller variants, mall=${mallIdToSend}`);

  const variants = [];
  let kjmhRow = null;

  // push 当前 variants 快照到 server,前端轮询能看见进度。失败静默(不阻塞主流程)
  const push = (extra = {}) => {
    if (!onProgress) return;
    onProgress({
      variants,
      okCount: variants.filter(v => v.ok).length,
      totalCount: 1 + agentVariants.length,
      currentlyRunning: extra.runningName ?? null,
      phase: extra.phase ?? 'running',
      dateFrom: payload.dateFrom,
      dateTo: payload.dateTo,
      agent: agentDiag(),
    });
  };

  // ── Phase 1: kjmh ─────────────────────────────────────────────────
  push({ runningName: kjmhVariant.name, phase: 'phase1' });
  try {
    const r = await runOneSettlementVariant(kjmhVariant, { beginTime, endTime, mallId: mallIdToSend }, signal);
    const entry = { drIndex: kjmhVariant.drIndex, name: kjmhVariant.name, region: kjmhVariant.region, taskType: kjmhVariant.taskType, ...r };
    // 不把 exportRow 整个塞进 result(体积大),只挑关键字段
    if (entry.exportRow) {
      kjmhRow = entry.exportRow;
      entry.exportRowKeys = Object.keys(kjmhRow);
      delete entry.exportRow;
    }
    variants.push(entry);
    if (r.ok) {
      console.log(`[Temu后台] settlement[卖家中心]: ✓ ok bytes=${r.fileBytes} polls=${r.polls}`);
      console.log(`[Temu后台] settlement[卖家中心]: kjmh row keys=${entry.exportRowKeys?.join(',')}`);
    } else {
      console.warn(`[Temu后台] settlement[卖家中心]: ✗ phase=${r.phase} code=${r.code} error=${String(r.error ?? '').slice(0, 250)}`);
    }
  } catch (e) {
    variants.push({
      drIndex: 0, name: '卖家中心', region: kjmhVariant.region, taskType: kjmhVariant.taskType,
      ok: false, code: e?.code ?? 'VARIANT_FAILED', error: String(e?.message ?? e),
    });
    console.warn(`[Temu后台] settlement[卖家中心]: ✗ throw ${e?.message ?? e}`);
  }
  push();  // kjmh 完成,推一次

  // ── Phase 2: agentseller 3 个(需要 kjmh 的跨域票据)──────────────────
  // 字段名候选:agentSellerExportParams / agentSellerExportSign 是我从 download-with-detail
  // 页面的 query string 反推的。如果实际 row 字段名不同(从 kjmh row keys log 可看),
  // 后面我再加映射。
  const agentParams = kjmhRow?.agentSellerExportParams;
  const agentSign   = kjmhRow?.agentSellerExportSign;

  const runAgent = async (variant) => {
    const r = await runAgentsellerVariantDiag(variant, { params: agentParams, sign: agentSign, mallId: mallIdToSend }, signal);
    return { drIndex: variant.drIndex, name: variant.name, region: variant.region, taskType: variant.taskType, ...r };
  };

  for (const variant of agentVariants) {
    if (signal?.aborted) {
      variants.push({ drIndex: variant.drIndex, name: variant.name, region: variant.region, taskType: variant.taskType, ok: false, code: 'ABORTED', error: 'task aborted' });
      push();
      continue;
    }
    if (!agentParams || !agentSign) {
      variants.push({
        drIndex: variant.drIndex, name: variant.name, region: variant.region, taskType: variant.taskType,
        ok: false, code: 'NO_KJMH_TICKET',
        error: `kjmh row 缺 agentSellerExportParams/Sign(kjmh row keys=${kjmhRow ? Object.keys(kjmhRow).join(',') : 'no-row'})`,
      });
      push();
      continue;
    }
    push({ runningName: variant.name, phase: 'phase2' });
    try {
      const r = await runAgent(variant);
      variants.push(r);
      console.log(`[Temu后台] settlement[${variant.name}]: ${r.ok ? '✓ ok' : '✗ fail'} code=${r.code ?? 'OK'} bytes=${r.fileBytes ?? 0}`);
    } catch (e) {
      variants.push({
        drIndex: variant.drIndex, name: variant.name, region: variant.region, taskType: variant.taskType,
        ok: false, code: e?.code ?? 'VARIANT_FAILED', error: String(e?.message ?? e),
      });
      console.warn(`[Temu后台] settlement[${variant.name}]: ✗ throw ${e?.message ?? e}`);
    }
    push();  // 每个 variant 完成,推一次
  }

  // ── Phase 3: 重试失败的 agentseller variants(最多 2 轮)──────────
  // 常见失败:NO_FILEURL(欧洲表大,首次 60s 不够);LOGIN_REQUIRED 不重试
  const RETRY_MAX = 2;
  // LOGIN_REQUIRED 也允许 retry(retry 之间 60+90s sleep,给 user 时间打开 agentseller-eu/us 登录页)
  // 真不登的话 retry 也 fail,只多浪费 30s × 2 = 1 分钟
  const NO_RETRY_CODES = new Set(['NO_KJMH_TICKET', 'ABORTED']);
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    const toRetry = variants.filter(v =>
      !v.ok && v.drIndex !== 0 && !NO_RETRY_CODES.has(v.code)
    );
    if (toRetry.length === 0) break;
    // 给 server 时间继续生成 xlsx(欧洲大表常 NO_FILEURL 是 server 还在生成)
    // 第 1 次 retry 前 sleep 60s,第 2 次 90s
    const sleepBefore = attempt === 1 ? 60_000 : 90_000;
    console.log(`[Temu后台] settlement retry #${attempt}: ${toRetry.length} variant(s) (${toRetry.map(v => v.name).join(',')}) — 先 sleep ${sleepBefore/1000}s 给 server 时间生成`);
    await sleep(sleepBefore, signal);
    for (const failed of toRetry) {
      if (signal?.aborted) break;
      const variant = agentVariants.find(v => v.drIndex === failed.drIndex);
      if (!variant) continue;
      try {
        const r = await runAgent(variant);
        // 替换原 failed entry
        const idx = variants.indexOf(failed);
        if (idx >= 0) variants[idx] = r;
        console.log(`[Temu后台] settlement[${variant.name}] retry #${attempt}: ${r.ok ? '✓ ok' : '✗ fail'} code=${r.code ?? 'OK'} bytes=${r.fileBytes ?? 0}`);
      } catch (e) {
        console.warn(`[Temu后台] settlement[${variant.name}] retry #${attempt}: ✗ throw ${e?.message ?? e}`);
      }
    }
  }

  const okCount = variants.filter(v => v.ok).length;
  console.log(`[Temu后台] settlement: done ${okCount}/${variants.length} variant(s) ok`);

  return {
    variants,
    okCount,
    totalCount: variants.length,
    dateFrom: payload.dateFrom,
    dateTo: payload.dateTo,
    completedAt: new Date().toISOString(),
    agent: agentDiag(),
  };
}

// 跑一个 variant — 开 tab → 等加载 → 登录检测 → executeScript → 关 tab
// 返回 { ok, xlsxBase64?, filename?, fileBytes?, exportRowId?, polls?, phase?, code?, error? }
async function runOneSettlementVariant(variant, { beginTime, endTime, mallId }, signal) {
  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 6 * 60_000;

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
    const tab = await chrome.tabs.create({ url: variant.pageUrl, active: true, pinned: false });
    tabId = tab.id;
    console.log(`[Temu后台] settlement[${variant.name}]: tab ${tabId} → ${variant.pageUrl}`);

    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      onUpdatedListener = (uTabId, changeInfo) => {
        if (uTabId === tabId && changeInfo.status === 'complete') resolve();
      };
      chrome.tabs.onUpdated.addListener(onUpdatedListener);
      const poll = setInterval(async () => {
        if (signal?.aborted) { clearInterval(poll); reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); return; }
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

    let t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      console.log(`[Temu后台] settlement[${variant.name}]: login redirect (${t.url.slice(0,120)}) → 尝试自动登陆`);
      const loginResult = await attemptAutoLogin(tabId, signal);
      console.log(`[Temu后台] auto-login result: ok=${loginResult.ok} actions=${JSON.stringify(loginResult.actions)}`);
      if (!loginResult.ok) {
        await updateLoginHealth(variant.region, 'expired', `auto-login failed: ${loginResult.reason}`);
        return { ok: false, phase: 'login', code: 'LOGIN_REQUIRED', error: `${variant.region} auto-login ${loginResult.reason} (last actions: ${loginResult.actions.slice(-3).map(a => a.action).join(',')})` };
      }
      // 登陆成功后 redirectUrl 可能不指向 variant.pageUrl,强制 navigate 回任务页
      await chrome.tabs.update(tabId, { url: variant.pageUrl });
      await waitTabComplete(tabId, signal, 30_000);
      t = await chrome.tabs.get(tabId);
      if (t?.url && isLoginFlowUrl(t.url)) {
        await updateLoginHealth(variant.region, 'expired', `re-redirect after auto-login: ${t.url}`);
        return { ok: false, phase: 'login', code: 'LOGIN_REQUIRED', error: `${variant.region} auto-login 后仍跳登录` };
      }
      await updateLoginHealth(variant.region, 'ok', 'auto-login restored');
    }
    await sleep(2000, signal);

    console.log(`[Temu后台] settlement[${variant.name}]: executeScript (taskType=${variant.taskType}, mall=${mallId})`);
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runSettlementInTab,
      args: [{
        taskType: variant.taskType,
        beginTime, endTime,
        mallId,
        drIndex: variant.drIndex,
        pollIntervalMs: 5000,
        maxPolls: 60,
      }],
    });
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })),
        SCRIPT_TIMEOUT_MS,
      )),
    ]);

    if (!result) return { ok: false, phase: 'script', code: 'NO_RESULT', error: 'executeScript returned no result' };
    // 成功路径写 loginHealth(ok) — popup 会显示"实测在线"
    if (result.ok) await updateLoginHealth(variant.region, 'ok', null);
    return result; // {ok, xlsxBase64, filename, ...} or {ok:false, phase, code, error}
  } finally {
    await cleanup();
  }
}

// ── agentseller-{region} 跨域 download 诊断版本(2026-05-24h)──────
// 用 kjmh row 拿到的 params + sign 拼 /labor/bill-download-with-detail URL
// 打开 hidden tab → MAIN world hook fetch → 等 15s 让 page mount + 自动调 XHR
// 返回:{ ok: false, code: 'DIAG_COLLECTED', captured: [...] }
// 后续根据 captured 内容知道 fileUrl 哪儿来,再升级到真实下载
async function runAgentsellerVariantDiag(variant, { params, sign, mallId }, signal) {
  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const downloadUrl = `${variant.origin}/labor/bill-download-with-detail?params=${encodeURIComponent(params)}&sign=${encodeURIComponent(sign)}`;

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
    const tab = await chrome.tabs.create({ url: downloadUrl, active: true, pinned: false });
    tabId = tab.id;
    console.log(`[Temu后台] settlement[${variant.name}]: tab ${tabId} → ${downloadUrl.slice(0, 150)}`);

    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      onUpdatedListener = (uTabId, changeInfo) => {
        if (uTabId === tabId && changeInfo.status === 'complete') resolve();
      };
      chrome.tabs.onUpdated.addListener(onUpdatedListener);
      const poll = setInterval(async () => {
        if (signal?.aborted) { clearInterval(poll); reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); return; }
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

    let t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      console.log(`[Temu后台] diag[${variant.name}]: login redirect (${t.url.slice(0,120)}) → 尝试自动登陆`);
      const loginResult = await attemptAutoLogin(tabId, signal);
      console.log(`[Temu后台] auto-login result: ok=${loginResult.ok} actions=${JSON.stringify(loginResult.actions)}`);
      if (!loginResult.ok) {
        await updateLoginHealth(variant.region, 'expired', `auto-login failed: ${loginResult.reason}`);
        return { ok: false, phase: 'login', code: 'LOGIN_REQUIRED', error: `${variant.region} auto-login ${loginResult.reason}` };
      }
      // download tab 跳回的 redirectUrl 是任务 download URL,这里直接 navigate 回去触发 fetch
      await chrome.tabs.update(tabId, { url: downloadUrl });
      await waitTabComplete(tabId, signal, 30_000);
      t = await chrome.tabs.get(tabId);
      if (t?.url && isLoginFlowUrl(t.url)) {
        await updateLoginHealth(variant.region, 'expired', `re-redirect after auto-login: ${t.url}`);
        return { ok: false, phase: 'login', code: 'LOGIN_REQUIRED', error: `${variant.region} auto-login 后仍跳登录` };
      }
      await updateLoginHealth(variant.region, 'ok', 'auto-login restored');
    }

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: hookAndDownloadXlsx,
      args: [{ waitMs: 120_000 }],  // 欧洲一个月 25k 行,server 生成可能 1-3 min;给 page 2 min 等 fileUrl
    });
    const SCRIPT_TIMEOUT_MS_INNER = 6 * 60_000; // 总外层 6 分钟覆盖 wait + xlsx download
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })),
        SCRIPT_TIMEOUT_MS_INNER,
      )),
    ]);
    if (!result) return { ok: false, phase: 'script', code: 'NO_RESULT', error: 'executeScript returned no result' };
    // 成功 download 也写 loginHealth(ok) — popup 实测"在线"
    if (result.ok) await updateLoginHealth(variant.region, 'ok', null);
    return result; // {ok, xlsxBase64, ...} 或 {ok:false, phase, code, error}
  } finally {
    await cleanup();
  }
}

// MAIN world:hook fetch,拦截 /file/export/download 的响应拿 fileUrl → fetch xlsx → base64
// 必须是纯函数(executeScript 序列化)
function hookAndDownloadXlsx(args) {
  return (async () => {
    const { waitMs } = args;
    try {
      let fileUrl = null;
      let downloadResp = null;

      const origFetch = window.fetch;
      window.fetch = async function (...callArgs) {
        const req = callArgs[0];
        const url = typeof req === 'string' ? req : (req?.url ?? '');
        const resp = await origFetch.apply(this, callArgs);
        // 拦截 /file/export/download:取 fileUrl 给我们自己用,
        // 同时返回一个把 fileUrl 抹空的 Response 给页面 — 防止页面用 <a download> 触发本地下载
        if (/\/api\/merchant\/file\/export\/download/.test(url)) {
          try {
            const clone = resp.clone();
            const json = await clone.json();
            if (json?.result?.fileUrl) {
              if (!fileUrl) {
                fileUrl = json.result.fileUrl;
                downloadResp = json;
              }
              // 篡改 response — 把 fileUrl 抹空,让页面拿到的是空 URL,无法触发本地下载
              const mutated = { ...json, result: { ...json.result, fileUrl: '' } };
              return new Response(JSON.stringify(mutated), {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
              });
            }
          } catch {}
        }
        return resp;
      };

      // 轮询等 fileUrl 出现(或 waitMs 超时)
      const startedAt = Date.now();
      while (!fileUrl && Date.now() - startedAt < waitMs) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (!fileUrl) {
        return { ok: false, phase: 'wait', code: 'NO_FILEURL', error: `${waitMs}ms 内页面没发出 /download response` };
      }

      // 拿到 fileUrl → fetch xlsx 二进制
      const blobResp = await fetch(fileUrl, { method: 'GET', credentials: 'include' });
      if (!blobResp.ok) {
        return { ok: false, phase: 'blob', code: 'BLOB_FAILED', error: `HTTP ${blobResp.status}` };
      }
      const contentType = blobResp.headers.get('content-type') || '';
      const buf = await blobResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isXlsx = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
      if (!isXlsx) {
        const preview = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(200, bytes.length)));
        return { ok: false, phase: 'blob', code: 'NOT_XLSX', error: `non-xlsx (ct=${contentType}, bytes=${bytes.length}): ${preview.slice(0, 150)}` };
      }
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const xlsxBase64 = btoa(binary);
      const filenameMatch = fileUrl.match(/\/([^/?]+\.xlsx)/);
      const filename = filenameMatch ? filenameMatch[1] : `agentseller-${Date.now()}.xlsx`;
      return { ok: true, xlsxBase64, filename, fileBytes: buf.byteLength, fileUrl };
    } catch (e) {
      return { ok: false, phase: 'unexpected', code: 'UNEXPECTED', error: String(e?.message ?? e) };
    }
  })();
}

// MAIN world(诊断版本,保留备用):hook fetch + XMLHttpRequest,收集 waitMs 内所有调用
// 必须是纯函数(executeScript 序列化)
function hookFetchAndCollect(args) {
  return (async () => {
    const { waitMs } = args;
    const captured = [];
    const MAX_BODY_LEN = 800;
    const trim = (s) => typeof s === 'string' && s.length > MAX_BODY_LEN ? s.slice(0, MAX_BODY_LEN) + '…' : s;

    try {
      const origFetch = window.fetch;
      window.fetch = async function (...callArgs) {
        const req = callArgs[0];
        const init = callArgs[1] ?? {};
        const url = typeof req === 'string' ? req : req?.url;
        const method = init?.method ?? (typeof req === 'object' ? req?.method : 'GET') ?? 'GET';
        const reqBody = init?.body != null ? String(init.body) : null;
        const startedAt = Date.now();
        const entry = { src: 'fetch', method, url: trim(String(url)), reqBody: trim(reqBody), startedAt };
        captured.push(entry);
        try {
          const resp = await origFetch.apply(this, callArgs);
          entry.status = resp.status;
          // 克隆 response 偷一份 body
          try {
            const clone = resp.clone();
            const ct = clone.headers.get('content-type') || '';
            if (/json|text|xml/i.test(ct)) {
              const txt = await clone.text();
              entry.respBody = trim(txt);
            } else {
              entry.respBody = `[non-text content-type=${ct}]`;
            }
          } catch (e) { entry.respBodyErr = String(e?.message ?? e); }
          return resp;
        } catch (e) {
          entry.error = String(e?.message ?? e);
          throw e;
        }
      };

      // XHR hook(同样收集)
      const OrigXHR = window.XMLHttpRequest;
      function XHRProxy() {
        const xhr = new OrigXHR();
        const entry = { src: 'xhr', startedAt: Date.now() };
        captured.push(entry);
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
          entry.method = method; entry.url = trim(String(url));
          return origOpen.call(this, method, url, ...rest);
        };
        const origSend = xhr.send;
        xhr.send = function (body) {
          entry.reqBody = trim(body != null ? String(body) : null);
          xhr.addEventListener('loadend', () => {
            entry.status = xhr.status;
            try {
              const ct = xhr.getResponseHeader('content-type') || '';
              if (/json|text|xml/i.test(ct)) entry.respBody = trim(xhr.responseText);
              else entry.respBody = `[non-text ct=${ct}]`;
            } catch {}
          });
          return origSend.call(this, body);
        };
        return xhr;
      }
      XHRProxy.prototype = OrigXHR.prototype;
      window.XMLHttpRequest = XHRProxy;

      // 等 page mount + 自动 XHR
      await new Promise(r => setTimeout(r, waitMs));

      // 取一下 body 文本 snippet 帮助判断页面是否正常 mount
      const docTextSnippet = String(document.body?.innerText ?? '').slice(0, 300);
      return { captured, docTextSnippet };
    } catch (e) {
      return { captured, error: String(e?.message ?? e) };
    }
  })();
}

// MAIN world 注入函数:在页面上下文内跑整套 settlement(派任务 + 轮询 + 下载 + base64)
// 必须是纯函数(executeScript 会序列化它),不能引用外部变量
function runSettlementInTab(args) {
  return (async () => {
    try {
      const { taskType, beginTime, endTime, mallId, drIndex, pollIntervalMs, maxPolls } = args;

      // 关键 header:
      // - content-type:application/json
      // - mallid:server 用来路由 + 判权限,缺这条 → "没权限访问"
      // - anti-content 由页面 WAF SDK 自动注入(我们裸 fetch 也会触发 Request 构造器代理)
      const headers = {
        'content-type': 'application/json',
        'mallid': String(mallId),
      };
      const post = (path, body) => fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body),
      });
      const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

      // 翻 5 页 × 50 条找匹配 row —— 在 create 之前先用 + create 失败兜底也用
      // 用"日历日"比较(+08 时区下的 YYYY-MM-DD)而不是 epoch ms,容忍服务端时区偏移
      // 例如 plugin 发 endTime epoch 跟 history 里 searchExportTimeEnd 可能差 8-9 小时,但同一天
      const epochToCnDay = (e) => {
        if (e == null) return '';
        const d = new Date(Number(e) + 8 * 3600 * 1000);
        return d.toISOString().slice(0, 10);  // YYYY-MM-DD 在 +08 时区下
      };
      const beginDay = epochToCnDay(beginTime);
      const endDay   = epochToCnDay(endTime);
      const matchesRangeStrict = (row, _endT) => row
        && epochToCnDay(row.searchExportTimeBegin) === beginDay
        && epochToCnDay(row.searchExportTimeEnd)   === endDay;
      async function fetchAllHistoryPages() {
        const all = [];
        for (let pg = 1; pg <= 5; pg++) {
          try {
            const resp = await post('/api/merchant/file/export/history/page', { taskType, pageSize: 50, pageNum: pg });
            if (!resp.ok) break;
            const json = await resp.json();
            const list = json?.result?.merchantMerchantFileExportHistoryList ?? [];
            if (list.length === 0) break;
            all.push(...list);
            if (list.length < 50) break;
          } catch { break; }
        }
        return all;
      }

      // ── Step 1:先看 history 有没有现成匹配 row,有就跳过 create(节省 quota + 更快)──
      let exportRow = null;
      let skippedCreate = false;
      let pollCount = 0;
      const step1Diag = { expectedBegin: beginDay, expectedEnd: endDay, historyCount: 0, sampleRows: [], fetchError: null };
      try {
        const existing = await fetchAllHistoryPages();
        step1Diag.historyCount = existing.length;
        step1Diag.sampleRows = existing.slice(0, 8).map(r => ({
          id: r?.id,
          beginEpoch: r?.searchExportTimeBegin,
          endEpoch: r?.searchExportTimeEnd,
          beginDay: epochToCnDay(r?.searchExportTimeBegin),
          endDay: epochToCnDay(r?.searchExportTimeEnd),
          status: r?.status,
          keys: r ? Object.keys(r).slice(0, 20) : [],
        }));
        exportRow = existing.find(r => r?.status === 2 && matchesRangeStrict(r, endTime));
        if (exportRow) {
          skippedCreate = true;
        }
      } catch (e) {
        step1Diag.fetchError = String(e?.message ?? e);
      }

      // snap baseline createTime(给 create 后轮询新 row 用)
      let beforeMaxCreate = 0;
      try {
        const r = await post('/api/merchant/file/export/history/page', { taskType, pageSize: 10, pageNum: 1 });
        if (r.ok) {
          const j = await r.json();
          const list = j?.result?.merchantMerchantFileExportHistoryList ?? [];
          for (const row of list) if (row?.createTime > beforeMaxCreate) beforeMaxCreate = row.createTime;
        }
      } catch {}

      // 2. POST /export 派任务(已有 ready row 跳过这步)
      let createBody = {
        fundDetailExport: true,
        taskType,
        beginTime,
        endTime,
        mallId: Number(mallId),
        drList: drIndex != null ? [drIndex] : [0, 1, 2, 3],
      };
      let createOk = false;
      let dupCreate = false;
      let lastCreateErr = '';

      // 关键 optimization:如果上面 Step 1 已经找到 ready row,直接跳过 create + 轮询
      if (skippedCreate) {
        // exportRow 已设,跳到 download
      } else {

      // 平台限制类错误的 errorMsg 关键词识别(不分 errorCode,服务端时不时变)
      // - "当前创建的导出任务过多,请明日再来" → 每日配额耗尽
      // - "请稍后再试" / "频繁" → 短期限流
      const RATE_LIMIT_PATTERNS = [
        /导出任务过多/, /明日再来/, /明天再试/,
        /频繁/, /频次/, /稍后再试/,
        /限流/, /配额/, /quota/i, /too many/i, /rate.?limit/i,
      ];

      for (let attempt = 0; attempt <= 3; attempt++) {
        const resp = await post('/api/merchant/file/export', createBody);
        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          return { ok: false, phase: 'create', code: 'CREATE_FAILED', error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
        }
        const j = await resp.json();
        if (j?.success === true) { createOk = true; break; }
        const msg = String(j?.errorMsg ?? '');
        // 平台配额限制 → fail-fast,不走 dup 兜底(因为根本没创建)
        if (RATE_LIMIT_PATTERNS.some(p => p.test(msg))) {
          console.warn(`[runSettlementInTab] EXPORT_RATE_LIMITED: ${msg} (code=${j?.errorCode})`);
          return {
            ok: false, phase: 'create', code: 'EXPORT_RATE_LIMITED',
            error: `Temu 平台导出配额已用尽:"${msg}"。每个店铺每天可导出次数有限,明日再试 或者 改其他店铺`,
            step1Diag,
          };
        }
        if (Number(j?.errorCode) !== 2000000) {
          // 其他非 dup 错误,fail-fast
          const dump = JSON.stringify(j).slice(0, 400);
          console.warn(`[runSettlementInTab] CREATE_FAILED: ${dump}`);
          return { ok: false, phase: 'create', code: 'CREATE_FAILED', error: `${j?.errorMsg ?? 'unknown'} (errorCode=${j?.errorCode})` };
        }
        // dup
        lastCreateErr = msg ?? 'dup';
        if (attempt < 3) {
          createBody = { ...createBody, endTime: createBody.endTime - (attempt + 1) };  // -1, -2, -3 ms
          console.log(`[runSettlementInTab] dup #${attempt + 1},微调 endTime=${createBody.endTime} 重试`);
          await sleepMs(500);
        } else {
          dupCreate = true;  // 3 次都 dup,认了
          console.warn(`[runSettlementInTab] 3 次微调都 dup,转入 polling 兜底:${lastCreateErr}`);
        }
      }

      // 3. 轮询 history 找 status=2 的 row
      // 正常路径:看 createTime > baseline 的新 row(确保是本次 create 的产物)
      // dupCreate 路径:服务端说"已创建,请勿重复" → 取最近一条 status=2 的 row(不按 filter 匹配,
      // 因为 row 字段名/类型未知;dup 窗口短,最近一条几乎必然就是用户/我们刚创建的)
      // dup 时按 row.searchExportTimeBegin / searchExportTimeEnd **严格匹配**当前 task 的日期范围
      // 注意:如果上面 dup retry 微调过 endTime,要用最终发出去的(createBody.endTime),
      // 不能用 outer endTime —— history 里 row 的 searchExportTimeEnd 是我们 actually sent 的值
      const matchEndTime = createBody.endTime;
      const matchesRange = (row) => row
        && Number(row.searchExportTimeBegin) === Number(beginTime)
        && Number(row.searchExportTimeEnd)   === Number(matchEndTime);

      // 翻 5 页 × 50 条 = 250 条 history,在多页中找匹配 row(server 长尾 dedup 可能在后页)
      async function fetchAllHistoryPages() {
        const all = [];
        for (let pg = 1; pg <= 5; pg++) {
          try {
            const resp = await post('/api/merchant/file/export/history/page', { taskType, pageSize: 50, pageNum: pg });
            if (!resp.ok) break;
            const json = await resp.json();
            const list = json?.result?.merchantMerchantFileExportHistoryList ?? [];
            if (list.length === 0) break;
            all.push(...list);
            if (list.length < 50) break;  // 不足 50 条说明已到底
          } catch { break; }
        }
        return all;
      }

      if (dupCreate) {
        try {
          const allRows = await fetchAllHistoryPages();
          if (allRows[0]) {
            console.log(`[runSettlementInTab] dupCreate 共 ${allRows.length} 条 history row,row[0] keys=${Object.keys(allRows[0]).join(',')}`);
          }
          exportRow = allRows.find(r => r?.status === 2 && matchesRange(r));
          if (exportRow) {
            console.log(`[runSettlementInTab] dupCreate ✓ 匹配 row id=${exportRow.id} begin=${exportRow.searchExportTimeBegin} end=${exportRow.searchExportTimeEnd}`);
          } else {
            const sample = allRows.slice(0, 3).map(r => `(${r.searchExportTimeBegin}→${r.searchExportTimeEnd} status=${r.status})`).join(', ');
            console.warn(`[runSettlementInTab] dupCreate ✗ 共扫 ${allRows.length} 条没找匹配,开头 3 条:${sample}`);
          }
        } catch (e) {
          console.warn(`[runSettlementInTab] dupCreate fetch fail: ${e.message}`);
        }
      }
      if (!exportRow) {
        const polls = dupCreate ? Math.min(6, maxPolls) : maxPolls;
        for (let i = 0; i < polls; i++) {
          await sleepMs(pollIntervalMs);
          pollCount++;
          try {
            const all = await fetchAllHistoryPages();
            const candidates = dupCreate
              ? all.filter(matchesRange)
              : all.filter(r => r?.createTime > beforeMaxCreate && matchesRange(r));
            if (candidates.length === 0) continue;
            const ready = candidates.find(r => r?.status === 2);
            if (ready) { exportRow = ready; break; }
            if (!dupCreate) {
              const failed = candidates.find(r => r?.status !== 1 && r?.status !== 2);
              if (failed) {
                return { ok: false, phase: 'poll', code: 'EXPORT_FAILED', error: `new row status=${failed.status} (id=${failed.id})`, polls: pollCount };
              }
            }
          } catch (e) { /* 继续轮询 */ }
        }
        if (!exportRow && dupCreate) {
          return {
            ok: false, phase: 'poll', code: 'DUP_NO_MATCH',
            error: `服务端 dedup 但翻 history 5 页都没找匹配 row。30 min 后再试 / 改日期范围 / 在 Temu UI 手动点导出再让 plugin 抓`,
            polls: pollCount,
          };
        }
      }
      if (!exportRow) {
        return { ok: false, phase: 'poll', code: 'EXPORT_TIMEOUT', error: `${maxPolls * pollIntervalMs / 1000}s 内未就绪 (dup=${dupCreate})`, polls: pollCount };
      }
      }  // end of `else { create + poll }`

      // 4. POST /download 拿 signed URL
      const dlResp = await post('/api/merchant/file/export/download', { id: exportRow.id, taskType });
      if (!dlResp.ok) {
        const txt = await dlResp.text().catch(() => '');
        return { ok: false, phase: 'download', code: 'DOWNLOAD_FAILED', error: `HTTP ${dlResp.status}: ${txt.slice(0, 200)}` };
      }
      const dlJson = await dlResp.json();
      const fileUrl = dlJson?.result?.fileUrl;
      if (!fileUrl) {
        return { ok: false, phase: 'download', code: 'DOWNLOAD_NO_URL', error: JSON.stringify(dlJson).slice(0, 300) };
      }

      // 5. fetch signed URL 拿 xlsx 二进制
      // 文件托管在 seller.kuajingmaihuo.com/mall-finance-files/*,看似有 COS 签名其实
      // 同域 path,server 前置 session 检查 → 必须带 cookie('include')否则被重定向到登录页
      // 返回 HTML 而不是 xlsx
      const blobResp = await fetch(fileUrl, { method: 'GET', credentials: 'include' });
      if (!blobResp.ok) {
        return { ok: false, phase: 'blob', code: 'BLOB_FAILED', error: `HTTP ${blobResp.status}` };
      }
      const contentType = blobResp.headers.get('content-type') || '';
      const buf = await blobResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // xlsx magic bytes:`PK\x03\x04`(ZIP signature),验证不是 HTML / JSON 错误页
      const isXlsx = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
      if (!isXlsx) {
        // 不是 xlsx — 多半是登录重定向页或错误页,取前 200 字符给出 clue
        const preview = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(200, bytes.length)));
        return {
          ok: false, phase: 'blob', code: 'NOT_XLSX',
          error: `fileUrl returned non-xlsx (content-type=${contentType}, bytes=${bytes.length}): ${preview.slice(0, 150)}`,
        };
      }
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const xlsxBase64 = btoa(binary);

      const filenameMatch = fileUrl.match(/\/([^/?]+\.xlsx)/);
      const filename = filenameMatch ? filenameMatch[1] : `settlement-${taskType}-${Date.now()}.xlsx`;

      return {
        ok: true,
        xlsxBase64,
        filename,
        fileBytes: buf.byteLength,
        exportRowId: exportRow.id,
        exportRow,  // 整行回传 — SW 用 row.agentSellerExportParams + row.agentSellerExportSign 走跨域 download
        polls: pollCount,
      };
    } catch (e) {
      return { ok: false, phase: 'unexpected', code: 'UNEXPECTED', error: String(e?.message ?? e) };
    }
  })();
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
    console.warn(`[Temu后台] cooldown SET mall=${mallId} for ${(dur/1000).toFixed(0)}s — ${reason}`);
  } catch (e) {
    console.warn('[Temu后台] cooldown set failed:', e?.message);
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
    console.warn('[Temu后台] storage.session get failed:', e?.message);
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
    console.warn('[Temu后台] storage.session set failed:', e?.message);
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

  // ★ apiUrlPattern 可以是 string 或 function(payload) — 这里统一解析成 string,
  //   downstream(SW fetch + capture matcher)继续按 string 处理。
  //   pageUrl 同样的处理逻辑(以前只有 activity-products 用函数形态)。
  if (typeof spec.apiUrlPattern === 'function') {
    spec = { ...spec, apiUrlPattern: spec.apiUrlPattern(payload) };
  }

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
        `[Temu后台] rate-limit retry ${attempt}/${RATE_LIMIT_RETRY_DELAYS_MS.length} ` +
        `mall=${mallId} — sleeping ${delayMs/1000}s + invalidating session (will re-capture)`,
      );
      await sleep(delayMs, signal);
      await invalidateSession(mallId);
    }

    let session = await getCachedSession(mallId);
    let freshlyCaptured = false;
    if (!session) {
      console.log(`三、session 缓存未命中 mall=${mallId} — 开 hidden tab 抓 headers`);
      checkAbort();
      session = await captureSessionViaTab(spec, payload, signal);
      freshlyCaptured = true;
      // ★ 注意:暂时不写缓存 — 先做 MALL_MISMATCH 检测,
      //   chrome 登的是别的 mall 时 capture 出来的 headers 跟 task 期望对不上,
      //   写进缓存会污染下次同 mallId 任务(造成 "session HIT" + MALL_MISMATCH 怪象)
    } else {
      console.log(`三、session 缓存命中 mall=${mallId}`);
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
      // ★ Temu 5xx:同样 transient,重试时 invalidate session 让下次 re-capture anti-content
      //    经验上 HTTP 500 常因 anti-content header 时效(几分钟)失效引起。
      if (e?.code === 'TEMU_SERVER_ERROR') {
        lastErr = e;
        // 完整诊断 log:body + payload,帮排查是哪种 5xx(server bug / activity 不存在 / 等)
        console.warn(
          `[Temu后台] HTTP ${e.httpStatus} attempt=${attempt} kind=${spec.kind} ` +
          `payload=${JSON.stringify(payload).slice(0, 300)} body=${(e.message || '').slice(0, 300)}`,
        );
        if (attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          console.warn(`[Temu后台] → invalidate session + retry (attempt ${attempt+1}/${RATE_LIMIT_RETRY_DELAYS_MS.length})`);
          continue;
        }
        // 多次 5xx 还失败 → 不再 retry,上抛
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
    const captureRegionKey = regionKeyFromPageUrl(resolvedPageUrl);

    const runCapture = async () => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: captureHeadersInTab,
        args: [{
          apiUrlPattern: captureUrlPattern,
          captureTimeoutMs: CAPTURE_TIMEOUT_MS,
        }],
      });
      return r?.result;
    };

    // ★ short-circuit:tab load 完成后 URL 已经是 login flow → 跳过 capture(白等 30s),直接 auto-login
    let result;
    let earlyLoginUrl = null;
    try { const t = await chrome.tabs.get(tabId); earlyLoginUrl = (t?.url && isLoginFlowUrl(t.url)) ? t.url : null; } catch {}
    if (earlyLoginUrl) {
      console.log(`[Temu后台] capture[${spec.kind}]: 早期检测 login redirect (${earlyLoginUrl.slice(0,120)}) → 跳过 capture 直接 auto-login`);
      result = { ok: false, phase: 'pre-capture', error: 'login redirect detected before capture' };
    } else {
      result = await runCapture();
    }

    // capture 失败 → 看是不是 login redirect → 尝试 auto-login → 重 navigate → 重 capture 一次
    if (!result || result.ok !== true) {
      let currentUrl = null;
      try {
        const t = await chrome.tabs.get(tabId);
        currentUrl = t?.url || null;
      } catch {}
      if (currentUrl && isLoginFlowUrl(currentUrl) && captureRegionKey) {
        console.log(`[Temu后台] capture[${spec.kind}]: login redirect (${currentUrl.slice(0,120)}) → 尝试自动登陆`);
        const loginResult = await attemptAutoLogin(tabId, signal);
        console.log(`[Temu后台] auto-login result: ok=${loginResult.ok} actions=${JSON.stringify(loginResult.actions)}`);
        if (loginResult.ok) {
          try {
            await chrome.tabs.update(tabId, { url: resolvedPageUrl });
            await waitTabComplete(tabId, signal, 30_000);
            const t2 = await chrome.tabs.get(tabId);
            if (t2?.url && !isLoginFlowUrl(t2.url)) {
              await updateLoginHealth(captureRegionKey, 'ok', 'auto-login restored');
              result = await runCapture(); // 重抓 headers
            } else {
              await updateLoginHealth(captureRegionKey, 'expired', `re-redirect after auto-login: ${t2?.url}`);
            }
          } catch (e) {
            await updateLoginHealth(captureRegionKey, 'expired', `post-login navigate failed: ${e?.message}`);
          }
        } else {
          await updateLoginHealth(captureRegionKey, 'expired', `auto-login failed: ${loginResult.reason}`);
        }
      }
    }

    if (!result || result.ok !== true) {
      let currentUrl = null;
      try {
        const t = await chrome.tabs.get(tabId);
        currentUrl = t?.url || null;
      } catch {}
      const isLoginRedirect = currentUrl && isLoginFlowUrl(currentUrl);
      if (isLoginRedirect && captureRegionKey) {
        await updateLoginHealth(captureRegionKey, 'expired', `redirected to login: ${currentUrl}`);
        throw Object.assign(
          new Error(`LOGIN_REQUIRED: ${captureRegionKey} 子域 token 已过期,自动登陆未恢复 (now at ${currentUrl})`),
          { code: 'LOGIN_REQUIRED', region: captureRegionKey, currentUrl },
        );
      }
      if (captureRegionKey) await updateLoginHealth(captureRegionKey, 'unknown', result?.error ?? 'capture failed');
      throw Object.assign(
        new Error(`CAPTURE_FAILED: ${result?.error ?? 'unknown'} (phase=${result?.phase ?? 'n/a'})`),
        { code: 'CAPTURE_FAILED', detail: result },
      );
    }
    // ★ 成功 — region 已确认登录态有效
    if (captureRegionKey) await updateLoginHealth(captureRegionKey, 'ok', null);
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
      // 5xx = transient(server 自己挂或 anti-content 失效)→ 标 transient code 让上游 retry
      if (resp.status >= 500 && resp.status < 600) {
        throw Object.assign(
          new Error(`TEMU_SERVER_ERROR: HTTP ${resp.status}: ${txt.slice(0, 300)}`),
          { code: 'TEMU_SERVER_ERROR', httpStatus: resp.status },
        );
      }
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

    // ★ 详显获取的 JSON — Sellfox 风格:第 N 页 listLen=X total=Y,对象引用直接展开
    const pageLabel = mode === 'scroll'
      ? `游标第 ${iter + 1} 页`
      : `第 ${pageNo} 页`;
    try {
      const totalSuffix = spec.totalPath ? ` total=${getPath(data, spec.totalPath) ?? '?'}` : '';
      console.log(`  ${pageLabel} listLen=${list.length}${totalSuffix}`, data);
    } catch {}

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
    console.error(`[Temu后台] result ${taskId} 上报失败:`, e.message);
  }
}

async function sendHeartbeat(taskId, pluginInstanceId) {
  await api(`/api/agent/tasks/${taskId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ pluginInstanceId, leaseSeconds: LEASE_SECONDS }),
  });
}

// 中途上报进度 — plugin 完成一个 sub-step 推一次,前端轮询能看见进展
async function reportProgress(taskId, pluginInstanceId, partialResult) {
  try {
    await api(`/api/agent/tasks/${taskId}/progress`, {
      method: 'POST',
      body: JSON.stringify({ pluginInstanceId, partialResult, leaseSeconds: LEASE_SECONDS }),
    });
  } catch (e) {
    // 进度上报失败不影响主流程
    console.warn(`[Temu后台] progress ${taskId} 上报失败:`, e.message);
  }
}

// ── 启动 ─────────────────────────────────────────────────────────
export function startAgent() {
  Promise.resolve(chrome.alarms.clear(ALARM_NAME))
    .catch(() => {})
    .finally(() => chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN }));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      pollOnce().catch((e) => console.error(`轮询错误: ${e.message}`));
    }
  });
  // Service worker 唤醒后立刻拉一次(不必等下个 alarm 周期)
  pollOnce().catch(() => {});
  console.log(`▶ 派单中枢启动 build=${AGENT_BUILD_ID} 每 ${POLL_PERIOD_MIN * 60}s 轮询一次`);
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
