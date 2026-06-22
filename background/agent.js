// ────────────────────────────────────────────────────────────────────
// 派单中枢 (agent)
//
// 长轮询 ERP 后端的 /api/agent/tasks 队列：
//   1. chrome.alarms 每 10s 触发 pollOnce()
//   2. pollOnce → POST /api/agent/tasks/claim   原子领 1 个任务
//   3. 串行 await executeTask()
//      - 启 60s heartbeat 续租
//      - dispatch(task) 根据 kind 派发执行（先 stub，后续接 transform）
//      - 完成 → POST /:id/result (success | failed)
//
// 配置来源：chrome.storage.local
//   apiUrl              ERP 网关，如 https://duoshou.868818.xyz
//   token               Bearer token，dev 期就用 "demo"
//   pluginInstanceId    本插件实例 ID（首次自动生成，持久化）
//   selectedShopIds     限定派单到这些店铺（空/null = 本机未完成账号匹配 → 不领单）
// ────────────────────────────────────────────────────────────────────

import {
  transformAvailableActivities,
  transformActivityProducts,
  transformActivityEnrollments,
} from './transform/activity_transform.js';
import {
  transformSales30dResponse,
  transformSemiSalesResponse,
  transformSemiSalesDailyResponse,
  transformSkuSalesDailyResponse,
  transformPriceAdjustResponse,
  transformFluxAnalysisResponse,
  transformFluxAnalysisDetailResponse,
  transformLifecycleResponse,
} from './transform/sku_transform.js';
// order_transform.js 已退役(2026-06-11 薄插件化):订单行解析迁至 ERP 后端
// AgentResultIngestor.parseOrderAmounts,插件只回传 raw pageItems+bqResponses。

const POLL_PERIOD_MIN  = 1 / 6;   // 10s
const HEARTBEAT_PERIOD = 60_000;  // 60s
// 一次领多个:结算报表注入类子项(发货/退货面单费、EPR)按区共用一个 tab 并发采集
// (见 acquireRegionTab / closeRegionTabPool),不再每子项一个 tab。非池化任务仍逐个串行跑。
const CLAIM_LIMIT      = 12;      // 够一次领齐 3 区结算报表的注入子项(各区共用 1 tab)
const LEASE_SECONDS    = 300;     // 5min 租约
const ALARM_NAME       = 'agent-poll';

// 结算报表里"同区同源、注入式 fetch"的子项 —— 这些可共用一个区域 tab 并发采。
// (scrape:settlement 账务明细是跨域导出流程,不在此列,仍走自己的多 tab 流程。)
const POOLABLE_SETTLEMENT_KINDS = new Set([
  'scrape:logistics-bill',
  'scrape:reverse-logistics-bill',
  'scrape:epr-goods-fee',
  'scrape:epr-package-fee',
  'scrape:epr-platform-fee',
]);

// Bump this when diagnosing Chrome MV3 service-worker/module cache issues.
// It is written into logs and successful task results, so we can prove which
// evaluated module, not just which fetched source file, handled a task.
const AGENT_BUILD_ID   = 'agent-logistics-selene-20260622c';

// plugin 能处理的 task kind 列表 — claim 时上报给 server,server 据此过滤派单
// 老 plugin 不会上报这个,server 兼容路径会给它派所有 kind(但 dispatch 不认识就抛 UNSUPPORTED_KIND)
const SUPPORTED_KINDS = [
  'scrape:marketing-activity',
  'scrape:activity-products',
  'scrape:sales-30d',
  'scrape:sku-sales-daily',
  'scrape:activity-data',
  'scrape:declared-price',
  'scrape:lifecycle-management',
  'scrape:flux-analysis',
  'scrape:flux-analysis-detail',
  'scrape:order-amounts',
  'scrape:returns',
  'scrape:logistics-bill',
  'scrape:reverse-logistics-bill',
  'scrape:epr-goods-fee',
  'scrape:epr-package-fee',
  'scrape:epr-platform-fee',
  'scrape:settle-flow',
  'scrape:violation-appeals',
  'scrape:semi-ad',
  'scrape:settlement',
  'submit:price-confirm',
  'submit:activity-enroll',
];

// endpoint / 权限 mismatch 错误码集合 —— 命中其中任何一个说明 endpoint 写错了
// (半托推测 URL 不对)或 token 没绑对应权限包,没有重试意义,直接上报 ENDPOINT_MISMATCH。
// 40010 = 未知接口;7000020 = access_token invalid;400020037 = 无权限
const MISMATCH_CODES = new Set([40010, 7000020, 400020037, '40010', '7000020', '400020037']);

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

// 订单管理:recentOrderList 按区域走 agentseller 子域(us/eu/global)
const REGION_TO_ORDER_HOST = {
  global: 'https://agentseller.temu.com',
  us:     'https://agentseller-us.temu.com',
  eu:     'https://agentseller-eu.temu.com',
};
const ORDER_LIST_PATH = '/kirogi/bg/mms/recentOrderList';
const ORDER_SUPPLIER_PRICE_PATH = '/bg-visage-agent-seller/product/sku/supplierPrice/batchQueryByOrder';
const REGION_TO_ORDER_PAGE_URL = {
  global: 'https://agentseller.temu.com/mmsos/orders.html',
  us:     'https://agentseller-us.temu.com/mmsos/orders.html',
  eu:     'https://agentseller-eu.temu.com/mmsos/orders.html',
};

// 退货退款:专属页 return-refund-list.html(referer 匹配 garen 接口);列表全区域同 path;
// 详情按区分流(global=ReturnDetails,eu/us=RefundDetails)。
const REGION_TO_RETURNS_PAGE_URL = {
  global: 'https://agentseller.temu.com/mmsos/return-refund-list.html',
  us:     'https://agentseller-us.temu.com/mmsos/return-refund-list.html',
  eu:     'https://agentseller-eu.temu.com/mmsos/return-refund-list.html',
};
const RETURNS_LIST_PATH = '/garen/mms/afterSales/queryReturnAndRefundPaList';
const REGION_TO_RETURNS_DETAIL_PATH = {
  global: '/garen/mms/afterSales/queryReturnDetails',
  eu:     '/garen/mms/afterSales/queryRefundDetails',
  us:     '/garen/mms/afterSales/queryRefundDetails',
};

// 半托广告:独立域名 ads.temu.com(实测注入页直 fetch,无需 x-phan-data/list_id/mallid,cookie 自带)。
const SEMI_AD_PAGE_URL = 'https://ads.temu.com/data-report.html';
const SEMI_AD_REPORT_PATH = '/api/v1/coconut/ad/ads_report';

// ★ 半托管数据中心「商品数据」页(销量 /api/sale/analysis/detail)。
// ★★ 实测确认:销量 detail 的 host 固定主域 agentseller.temu.com,【不分区】(跟店铺区域无关);
//   只有流量 /api/flow/analysis/list 才按区域走 agentseller-us/-eu 子域。
//   销量和流量的 host 规则不同 —— 销量不要按 region 选 host。
const SEMI_SALES_PAGE_URL = 'https://agentseller.temu.com/main/data-center/goods-data';
const SEMI_SALES_API_PATH = '/api/sale/analysis/detail';
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

// userId 5 分钟缓存,避免重复 fetch。mallIdList = 该账号所有授权 mall(全托+半托一起,
// 同 Sellfox logInMallIdList)— MALL_MISMATCH 用它判"同账号多 mall"。
const _userIdCache = { value: null, mallId: null, mallIdList: [], expiresAt: 0 };

// 该账号是否拥有此 mallId(全托/半托属同账号 → captured session 可服务任意自有 mall)
function accountOwnsMall(mallId) {
  if (mallId == null) return false;
  return (_userIdCache.mallIdList || []).map(String).includes(String(mallId));
}
// 把 headers 里所有 mallid 别名覆盖成指定 mallId(同账号切 mall 只需换 header)
function overrideMallidHeader(headers, mallId) {
  const out = { ...(headers || {}) };
  for (const k of ['mallid', 'mallId', 'mall-id', 'mall_id', 'mall_id_cookies', 'mallid_cookies']) {
    if (k in out) delete out[k];
  }
  out.mallid = String(mallId);
  return out;
}

// ★ 在指定 tab(必须已在 kjmh 主域 page context 上)拿 userId + mallId。
//   返回 { userId, mallId } 或 { error }。
//   mallId 是 SSO URL 必需参数(Sellfox URL pattern: ?init=true&mallId&uId&validateid)。
export async function fetchKjmhUserIdInTab(tabId, signal) {
  if (_userIdCache.value && _userIdCache.mallId && Date.now() < _userIdCache.expiresAt) {
    return { userId: _userIdCache.value, mallId: _userIdCache.mallId, mallIdList: _userIdCache.mallIdList, fromCache: true };
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
          // ★ 账号所有授权 mall(全托+半托):companyList[].malInfoList[].mallId 全收
          //   (之前只取 [0][0] → 多 mall 账号被当单 mall,全托任务 MALL_MISMATCH)。
          const mallIdList = (data?.result?.companyList ?? [])
            .flatMap((c) => (c?.malInfoList ?? []).map((m) => m?.mallId))
            .filter((x) => x != null)
            .map(String);
          const mallId = mallIdList[0] ?? '';
          return { userId: String(userId), mallId, mallIdList };
        } catch (e) {
          return { error: `fetch: ${e?.message}` };
        }
      },
    });
    const result = r?.result || { error: 'no-result' };
    if (result.userId) {
      _userIdCache.value = result.userId;
      _userIdCache.mallId = result.mallId || '';
      _userIdCache.mallIdList = Array.isArray(result.mallIdList) ? result.mallIdList : [];
      _userIdCache.expiresAt = Date.now() + 5 * 60_000;
      console.log(`[Temu后台] userInfo: userId=${result.userId} 账号 mall 列表=[${_userIdCache.mallIdList.join(',')}]`);
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
    await chrome.tabs.update(tabId, { url: baseUrl });
    await waitTabComplete(tabId, signal, 15_000);
  } catch (e) {
    step(`✗ 跳转子域失败: ${e?.message}`);
    return { ok: false, reason: 'subdomain-nav-failed', actions };
  }
  await sleep(500, signal);

  // 3.5 现有 session 已有效则直接判在线,跳过 SSO 重登。
  //     根因修复:原先无脑跑 loginByCode、按其成败判在线/过期,但「能否 SSO 重登」
  //     ≠「登录态是否有效」——美区现有 cookie 能采(orders 采集成功),但 loginByCode
  //     失败(targetMallId 取 kjmh 单一 mallId、美区店是另一个 mall 等)→ 被误报"去登录"。
  //     子域首页没被跳登录,即说明该子域 session 有效 → 在线。
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.url && !isLoginFlowUrl(t.url)) {
      step(`✓ ${regionName} 现有登录态有效(子域业务页未跳登录),跳过 SSO`);
      return { ok: true, reason: 'session-valid', finalUrl: t.url, actions };
    }
  } catch {}

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
// targetMallId(2026-06-11 加,T-SettleMall):任务目标店。不传 → 老行为(列表[0],
// 多 mall 账号会随 userInfo 列表顺序漂移选错店 → 子域 SSO 落错店 → 导出失败/数据归错店)。
// 传了 → 精确选目标店;不在账号列表 → fail-fast。
export async function attemptAutoLogin(tabId, signal, targetMallId = '') {
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
  // ★ mall 选择:目标店优先(在账号列表内才放行);不传 target 用列表[0](老行为,兜底)
  const list = _userIdCache.mallIdList ?? [];
  let mallId;
  if (targetMallId) {
    if (!list.includes(String(targetMallId))) {
      step(`✗ 目标店 ${targetMallId} 不在账号 mall 列表 [${list.join(',')}] — MALL_MISMATCH`);
      return { ok: false, reason: 'target-mall-not-in-account', actions };
    }
    mallId = String(targetMallId);
    step(`✓ 选定目标店 mallId = ${mallId}(任务指定)`);
  } else {
    mallId = _userIdCache.mallId || '';
    if (list.length > 1) step(`⚠ 未指定目标店,默认列表[0]=${mallId}(多 mall 账号有选错风险)`);
  }

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
// 固定 ERP 网关:走 Tailscale,客户机在同一 tailnet 内开箱即用。
// storage 里有非空值才覆盖(本机 dev 可 chrome.storage.local.set 切到 LAN)。
const DEFAULT_API_URL = 'https://duoshouapi.868818.xyz'; // 香港 VPS 反代 → Tailscale → mini
const DEFAULT_TOKEN = 'demo'; // TODO: 权限系统上线后改每客户独立 token
// 反代鉴权头:VPS nginx 校验 X-ERP-Key,必须与 popup 同值、与 setup-vps.sh --gate-secret 同值。
const DEFAULT_ERP_GATE_KEY = 'f79063b32edd405e547f5ff2e3174ecddf14132feff78e50';

async function getCfg() {
  const c = await chrome.storage.local.get([
    'apiUrl', 'token', 'pluginInstanceId', 'selectedShopIds', 'erpGateKey',
  ]);
  if (!c.apiUrl) c.apiUrl = DEFAULT_API_URL;
  if (!c.token) c.token = DEFAULT_TOKEN;
  if (!c.erpGateKey) c.erpGateKey = DEFAULT_ERP_GATE_KEY;
  return c;
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
  const { apiUrl, token, erpGateKey } = await getCfg();
  if (!apiUrl) throw new Error('agent-not-configured');
  const res = await fetch(apiUrl + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token || 'demo'}`,
      'Content-Type': 'application/json',
      ...(erpGateKey ? { 'X-ERP-Key': erpGateKey } : {}),
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

let _pollInFlight = false;

// ── 派单轮询 ──────────────────────────────────────────────────────
export async function pollOnce() {
  if (_pollInFlight) {
    console.log(`· 轮询跳过:上一轮任务仍在执行 (build=${AGENT_BUILD_ID})`);
    return;
  }
  _pollInFlight = true;
  try {
  const cfg = await getCfg();
  if (!cfg.apiUrl) {
    console.warn('· 轮询跳过:未配置 ERP API 地址(popup 顶部"切换账号"填)');
    return;
  }
  // ★ 账号匹配 gate:scope 为空 = 本机还没匹配成功(或无已绑店),不领单。
  //   否则会把整个 org 所有店的任务领过来跑,而本机登录账号并不拥有这些店 → 全失败。
  //   匹配成功后 onboarding 写入 selectedShopIds,下一轮(10s 内)自动开始领单。
  if (!cfg.selectedShopIds || cfg.selectedShopIds.length === 0) {
    console.log('· 轮询跳过:本机未完成账号匹配(无 scope),不领单');
    return;
  }

  const pluginInstanceId = await ensurePluginInstanceId();

  let resp;
  try {
    resp = await api('/api/agent/tasks/claim', {
      method: 'POST',
      body: JSON.stringify({
        pluginInstanceId,
        shopIds: cfg.selectedShopIds,   // gate 已保证非空;只领本机匹配到的店
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
  if (tasks.length === 0) {
    console.log(`· 轮询 OK,本轮 0 任务 (build=${AGENT_BUILD_ID})`);
    return;
  }
  console.log(`一、领取 ${tasks.length} 个任务:`, tasks.map((t) => taskKindLabel(t.kind)).join(' / '));
  try {
    // 非池化任务:逐个串行(各自开关 tab,行为不变)
    const others = tasks.filter((t) => !POOLABLE_SETTLEMENT_KINDS.has(t.kind));
    for (const t of others) await executeTask(t, pluginInstanceId);
    // 池化任务(结算报表注入子项):同区共用一个 tab 并发跑;一轮跑完统一关 tab
    const poolable = tasks.filter((t) => POOLABLE_SETTLEMENT_KINDS.has(t.kind));
    if (poolable.length) {
      console.log(`三、结算报表 ${poolable.length} 子项 → 按区共享 tab 并发采集`);
      await Promise.allSettled(poolable.map((t) => executeTask(t, pluginInstanceId)));
    }
  } finally {
    await closeRegionTabPool();
  }
  } finally {
    _pollInFlight = false;
  }
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
  'scrape:order-amounts':      '订单产品金额',
  'scrape:returns':            '退货退款',
  'scrape:logistics-bill':     '物流对账账单',
  'scrape:reverse-logistics-bill': '退货面单费',
  'scrape:epr-goods-fee':      '商品环保费',
  'scrape:epr-package-fee':    '物流包装环保费',
  'scrape:epr-platform-fee':   '代付服务费',
  'scrape:settle-flow':        '结算流水(已到账)',
  'scrape:violation-appeals':  '违规罚款',
  'scrape:semi-ad':            '半托广告数据',
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
    // 含成功路径 reportResult 抛出(如 413 上报失败)→ 一律按失败处理。
    // failed 上报是小 payload(无 raw result),不会再撞 413;但仍 try/catch 兜底,
    // 防失败上报本身再抛(网络断)把 catch 冲出去。
    const errorCode = e.mismatch ? 'ENDPOINT_MISMATCH' : (e.code || 'UNKNOWN');
    try {
      await reportResult(task.id, pluginInstanceId, {
        status: 'failed',
        errorCode,
        errorMessage: `[${AGENT_BUILD_ID}] ${String(e.message || e)}`.slice(0, 1500),
      });
    } catch (e2) {
      console.error(`[Temu后台] failed 上报也失败 [${tid}]: ${e2.message}`);
    }
    console.error(`四、✗ 失败 [${tid}] ${label}: ${e.message}`);
  } finally {
    clearInterval(heartbeatTimer);
    _running.delete(task.id);
  }
}

// payload 字段名兼容:
//   - scheduled-task.cron(ERP)派任务用 `shopType`
//   - popup 手动派任务用 `siteType`(legacy plugin 词汇,值同 'semi'/'full')
// 两种来源都正确把 shop.shopType 透传过来,只是字段名不同。统一在 SPEC 函数里 OR 一下。
function isSemiPayload(payload) {
  const v = payload?.shopType ?? payload?.siteType;
  return v === 'semi';
}

// ── 每个 scrape:* kind 对应的 fetch + transform 配置 ─────────────
// dispatchViaHiddenTab 在 page same-origin 上下文跑:
//   1. 打开 pageUrl  → page 自然发起对 apiUrlPattern 的请求
//   2. Request 构造器 proxy 捕获那个请求的 headers(含 anti-content + mallid + content-type)
//   3. 用同一组 headers 自己分页发 fetch,buildBody(payload, pageNo) 控制每页 body
// raw rows → transform → task.result.rows[](Activity 主表 schema)
const KIND_TO_FETCH_SPEC = {
  'scrape:marketing-activity': {
    // 2026-06-06 CRX 1.0.101 反编译修正:半托数据 API 同样走 agentseller.temu.com(非 kjmh)。
    // sellfox 用 temuPostNew(url, body, mallId) 直调 agentseller,靠 mallid header 区分店铺。
    // #9 半托 == 全托(同 host 同 path),之前的 kjmh 分支是 capture 超时根因。详见 docs §3.6.1。
    pageUrl: (_payload) => 'https://agentseller.temu.com/activity/marketing-activity',
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
    // 2026-06-09 capture-timeout 根因修复(同 scrape:order-amounts 教训):
    //   detail-new 页冷加载**不主动发** /enroll/scroll/match(需先选站点 / 点查询),
    //   旧 spec 直接捕 scroll/match → 每个任务 capture 超时 → session 永不入缓存 →
    //   每个任务都新开 tab(tab 风暴)。
    //   修法:pageUrl 改主页(冷加载必发 /enroll/activity/list,与 scrape:marketing-activity 同),
    //   captureApiUrlPattern 捕 activity/list 拿同 mallId 跨 path 通用 headers,
    //   真正的 scroll/match fetch 仍在 SW 用这组 headers 跑(body 带 thematicId,服务端无状态)。
    pageUrl: (_payload) => 'https://agentseller.temu.com/activity/marketing-activity',
    apiUrlPattern: '/api/kiana/gamblers/marketing/enroll/scroll/match',
    captureApiUrlPattern: '/api/kiana/gamblers/marketing/enroll/activity/list',
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
    // 2026-06-06 修正:#4 半托 == 全托,数据 API 走 agentseller(非 kjmh)。详见 docs §3.6.1。
    pageUrl: (_payload) => 'https://agentseller.temu.com/activity/marketing-activity/log',
    apiUrlPattern: (_payload) => '/api/kiana/gamblers/marketing/enroll/list',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    // sessionStatus:2 = 只取「进行中」场次。不加这个过滤,Temu 会返回退出/已售罄等
    // 状态的报名记录,它们的 activityPrice 不准 → 产品分析销售额(销量×最低活动价)偏差。
    // runFetchInTab 仍会注入 pageNo+pageSize。
    buildBody: (_payload) => ({ sessionStatus: 2 }),
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
    // ⚠️ 此 kind 走专用 dispatcher dispatchFluxAnalysis,它会用静态值覆盖下面的 apiUrlPattern/pageUrl
    //    (按 region + isSemiPayload 分支),故这两项实际不生效(仅作文档);真正生效的是
    //    pageSize/pageNoKey/listPath/buildBody(经 paginatedFetchInSW 按 payload 解析)。
    // 全托:body 带 siteId 区分区域,host 固定 global,endpoint /api/seller/full/...
    // 半托(2026-06-06 §3.6.1):endpoint /api/flow/analysis/list,区域靠 agentseller 子域 host,
    //   body {timeDimension,sortMode,sortType},翻页 pageNumber/pageSize=100,listPath result.pageItems。
    pageUrl: (payload) => REGION_TO_FLUX_PAGE_URL[payload?.region ?? 'global'],
    apiUrlPattern: (payload) => isSemiPayload(payload)
      ? '/api/flow/analysis/list'
      : '/api/seller/full/flow/analysis/goods/list',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize:  (payload) => isSemiPayload(payload) ? 100 : 50,
    pageNoKey: (payload) => isSemiPayload(payload) ? 'pageNumber' : 'pageNo',
    listPath:  (payload) => isSemiPayload(payload) ? 'result.pageItems' : 'result.list',
    totalPath: 'result.total',
    buildBody: (payload) => isSemiPayload(payload)
      ? { timeDimension: payload?.statisticType ?? 5, sortMode: 2, sortType: 5 }
      : {
          statisticType: payload?.statisticType ?? 5,
          siteId:        payload?.siteId ?? REGION_TO_SITE_ID[payload?.region ?? 'global'],
          ...(payload?.quickFilter ? { quickFilter: payload.quickFilter } : {}),
        },
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
  // scrape:order-amounts — 订单产品金额(recentOrderList 分页 + batchQueryByOrder 批量)
  // payload: { mallId, region }  走专用 dispatchOrderAmounts(两段链式);此 spec 仅供
  //   dispatchViaHiddenTab 跑第一段 recentOrderList。
  'scrape:order-amounts': {
    pageUrl: (p) => REGION_TO_ORDER_PAGE_URL[p?.region ?? 'global'],
    apiUrlPattern: (_p) => ORDER_LIST_PATH,
    // recentOrderList 只有点"全部订单"tab 才发,冷加载不发;地址快照又依赖订单先加载。
    //   → capture 等订单页 bootstrap 阶段必发的配置调用(不依赖订单列表,最早最稳),
    //   同 mallId session 跨 path 通用,fetch 仍走 recentOrderList。
    captureApiUrlPattern: '/garen/mms/mall/queryOrderRegion1ReturnConfig',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    pageNoKey: 'pageNumber',
    pageSizeKey: 'pageSize',
    buildBody: (_p) => ({ fulfillmentMode: null, queryType: 0, sortType: 1, timeZone: 'UTC+8', sellerNoteLabelList: [] }),
    listPath: 'result.pageItems',
    totalPath: 'result.totalItemNum',
    transform: (rawItems) => rawItems,
  },
  // scrape:lifecycle-management — 抓"上新生命周期 — 价格申报中"列表(对照 Sallfox Temu核价主表)
  // payload: { mallId, supplierTodoType?(默认1=价格申报中) }
  //   POST /api/kiana/mms/robin/searchForChainSupplier
  //   body: { pageSize, pageNum, removeStatus:0, supplierTodoTypeList:[type] }
  //   pagination: pageNum 字段(不是 pageNo)+ pageSize
  //   listPath: result.dataList  totalPath: result.total
  // 落库:price_review (展开 SPU → SKC → SKU → siteList)
  'scrape:lifecycle-management': {
    // 2026-06-06 §3.6.1 修正:半托数据走 agentseller(非 kjmh);#6 真实 endpoint 是
    // searchForSemiSupplier(searchForChainSupplier 在 CRX 源里不存在)。pageUrl 路由仍待实测。
    pageUrl: (_payload) => 'https://agentseller.temu.com/newon/product-select',
    apiUrlPattern: (payload) => isSemiPayload(payload)
      ? '/api/kiana/mms/robin/searchForSemiSupplier'
      : '/api/kiana/mms/robin/searchForChainSupplier',
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
  // scrape:declared-price — 抓"核价单/申报价待确认"列表(核价页同步按钮专用)
  // payload: { shopType:'full'|'semi', mallId, region }
  // 2026-06-12 薄插件改造(T-ThinPlugin):核价单数据在 search{Chain|Semi}Supplier(supplierTodoTypeList:[1]
  //   =价格申报中)的 result.dataList[].skcList[].supplierPriceReviewInfoList[]。
  //   - 全托(Chain):价在 info/sku 级,siteId 全局(后端落 -1)
  //   - 半托(Semi):价在 productSkuList[].siteSupplierPriceList[](站点级,真 siteId)
  //   插件只采集 raw(identity transform,不解析),字段解析全在后端 parsePriceReviewRows + 单测,
  //   以后字段改只动后端、不重载插件。旧 magnus/mms/price-adjust/product-adjust-query 已废弃。
  'scrape:declared-price': {
    pageUrl: (_payload) => 'https://agentseller.temu.com/newon/product-select',
    apiUrlPattern: (payload) => isSemiPayload(payload)
      ? '/api/kiana/mms/robin/searchForSemiSupplier'
      : '/api/kiana/mms/robin/searchForChainSupplier',
    method: 'POST',
    paginationMode: 'pageNo',
    pageSize: 50,
    pageNoKey: 'pageNum',        // ★ Temu 用 pageNum 不是 pageNo
    pageSizeKey: 'pageSize',
    buildBody: (_payload) => ({ removeStatus: 0, supplierTodoTypeList: [1] }),  // 1 = 价格申报中
    listPath: 'result.dataList',
    totalPath: 'result.total',
    transform: (rawItems) => rawItems,   // 薄插件:raw 原样回传,后端解析
  },
  // scrape:sales-30d — 近 30 天销量 + 库存(SKU 级 snapshot)
  // 全托 / 半托走两套不同 endpoint(数据模型不同,详见 docs/sellfox-plugin-rev-eng.md §3.2):
  //   - 全托管(供货模式):agentseller.temu.com 销售管理页 → listOverall(含在仓库存,翻页)
  //   - 半托管(自卖模式):agentseller[-us/-eu] 数据中心「商品数据」页 → /api/sale/analysis/detail
  //       半托无独立销量任务,该接口按 SKU×日返回销量(无库存字段),单次返完整不翻页(single)。
  // 半托 body(2026-06-07 用户在数据中心商品数据页实测):{ pageNum, pageSize, timeType }
  //   - 分页字段名是 pageNum(非 pageNo)+ pageSize;翻页靠短页检测(list.length < pageSize)结束。
  //   - timeType 是时间枚举(实测 4;用户在「近30天」视图抓的 → 4≈近30天),不传 startDate/endDate。
  //   - 翻页 pageNum/pageSize 由 paginatedFetchInSW 注入,buildBody 只放 timeType。
  // ⚠️ 仍待实测:capture 是否冷开自动发 /api/sale/analysis/detail(否则补 captureApiUrlPattern/active-trigger);
  //    timeType 其它枚举值;响应是否含 skuSaleDTOList 每日明细(transform 据此累加 7d/30d)。
  'scrape:sales-30d': {
    pageUrl: (payload) => isSemiPayload(payload)
      ? SEMI_SALES_PAGE_URL  // 销量 detail host 固定主域,不分 region(与流量 host 规则不同)
      : 'https://agentseller.temu.com/stock/fully-mgt/sale-manage/main',
    apiUrlPattern: (payload) => isSemiPayload(payload)
      ? SEMI_SALES_API_PATH
      : '/mms/venom/api/supplier/sales/management/listOverall',
    method: 'POST',
    paginationMode: 'pageNo',
    pageNoKey:   (payload) => isSemiPayload(payload) ? 'pageNum' : 'pageNo',
    pageSizeKey: (payload) => isSemiPayload(payload) ? 'pageSize' : 'pageSize',
    pageSize:    (payload) => isSemiPayload(payload) ? 30 : 50,
    buildBody: (payload) => isSemiPayload(payload)
      ? { timeType: payload.timeType ?? 4 }   // 4≈近30天(实测);pageNum/pageSize 由分页逻辑注入
      : { isLack: 0 },
    listPath: (payload) => isSemiPayload(payload)
      ? 'result.saleAnalysisDetailDTOList'
      : 'result.subOrderList',
    totalPath: 'result.total',   // 全/半托响应都有 result.total,翻页按总数判断结束
    transform: (rawItems, payload) => isSemiPayload(payload)
      ? transformSemiSalesResponse(rawItems)
      : transformSales30dResponse(rawItems),
  },
  // scrape:sku-sales-daily — per-SKU per-day 历史销量(全托)
  // 同 sale-manage 页,endpoint querySkuSalesNumber。一次返指定 SKU 在 [start,end] 的每日销量。
  // body 需 productSkuIds 列表 → 不走 pageNo 分页(single);SKU 列表分块由 dispatchSkuSalesDaily 控制。
  'scrape:sku-sales-daily': {
    pageUrl: () => 'https://agentseller.temu.com/stock/fully-mgt/sale-manage/main',
    apiUrlPattern: () => '/mms/venom/api/supplier/sales/management/querySkuSalesNumber',
    method: 'POST',
    paginationMode: 'single',
    buildBody: (payload) => ({
      productSkuIds: (payload.productSkuIds ?? []).map(Number),
      startDate: payload.startDate ?? payload.dateFrom,
      endDate: payload.endDate ?? payload.dateTo,
    }),
    listPath: 'result',
    transform: (rawItems) => transformSkuSalesDailyResponse(rawItems),
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
    case 'scrape:sku-sales-daily':      return dispatchSkuSalesDaily(task, signal);
    case 'scrape:activity-data':        return dispatchActivityData(task, signal);
    case 'scrape:declared-price':       return dispatchDeclaredPrice(task, signal);
    case 'scrape:lifecycle-management': return dispatchLifecycleManagement(task, signal);
    case 'scrape:flux-analysis':        return dispatchFluxAnalysis(task, signal);
    case 'scrape:flux-analysis-detail': return dispatchFluxAnalysisDetail(task, signal);
    case 'scrape:order-amounts':        return dispatchOrderAmounts(task, signal);
    case 'scrape:returns':              return dispatchReturns(task, signal);
    case 'scrape:logistics-bill':       return dispatchLogisticsBill(task, signal);
    case 'scrape:reverse-logistics-bill': return dispatchReverseLogisticsBill(task, signal);
    case 'scrape:epr-goods-fee':        return dispatchEprFee(task, signal, 'goods');
    case 'scrape:epr-package-fee':      return dispatchEprFee(task, signal, 'package');
    case 'scrape:epr-platform-fee':     return dispatchEprFee(task, signal, 'platform');
    case 'scrape:settle-flow':          return dispatchSettleFlow(task, signal);
    case 'scrape:violation-appeals':    return dispatchViolationAppeals(task, signal);
    case 'scrape:semi-ad':              return dispatchSemiAd(task, signal);
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
// ── gen-3 通用单阶段列表采集 helper ───────────────────────────────────────────
// 开账号页(window.rose 在)→ 注入 runListFetchInTab(现签 anti-content + mallid override + 分页)
//   → raw listPath 项原样回传。单阶段 list 类 kind(marketing-activity 等)都复用这个。
// cfg: { logTag, pageUrl, apiPath, listKey, baseBody, pageNoKey, pageSize, maxPages }
// 2026-06-13 gen-3:flux-analysis 两阶段注入(list 翻页 + 每 SPU detail 批量,同 window.rose 现签)。
// MAIN-world 纯函数(executeScript 序列化,不能引用外部变量)。raw 回传,后端 parseFluxAnalysisRows
// / parseFluxDetailGroups 解析(薄插件)。
async function runFluxInTab(args) {
  const { listApiPath, detailApiPath, mallId, listBody, listPageNoKey, listSize, listKey,
          region, detailSiteId, detailPageSize, maxPages, concurrency } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const genAntiContent = () => { try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; } };
  const post = async (apiPath, body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(apiPath, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) { await wait(2000 * (attempt + 1)); continue; }
      if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`HTTP ${resp.status}: ${t.slice(0, 120)}`); }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) { await wait(2000 * (attempt + 1)); continue; }
      return data;
    }
    throw new Error('退避重试 6 次仍失败(限流/系统异常)');
  };
  const diag = { listPages: 0, listCount: 0, total: null, detailCandidates: 0, detailOk: 0, detailFail: 0, detailSkip: 0, detailDays: 0 };
  let firstListResp = null;
  try {
    // Phase 1:list 翻页
    const listRows = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post(listApiPath, { ...listBody, [listPageNoKey]: p, pageSize: listSize });
      if (!firstListResp) firstListResp = data;
      diag.listPages++;
      const list = (data && data.result && data.result[listKey]) || [];
      diag.total = (data && data.result && data.result.total != null) ? data.result.total : diag.total;
      for (const it of list) listRows.push(it);
      diag.listCount = listRows.length;
      if (list.length < listSize) break;
      if (diag.total != null && listRows.length >= diag.total) break;
    }
    // Phase 2:每 SPU detail 批量(曝光>0 且有 goodsId),并发
    const exposureOf = (r) => Number((r && (r.exposeNum ?? r.exposureNum ?? r.impressionNum ?? r.impressionCount)) || 0);
    const candidates = listRows.filter((r) => r && r.goodsId != null && exposureOf(r) > 0);
    diag.detailCandidates = candidates.length;
    const detailRows = [];
    let idx = 0;
    const worker = async () => {
      while (idx < candidates.length) {
        const r = candidates[idx++];
        const goodsId = r.goodsId;
        if (goodsId == null) { diag.detailSkip++; continue; }
        try {
          const items = [];
          for (let dp = 1; dp <= 10; dp++) {
            const dd = await post(detailApiPath, { goodsId: Number(goodsId), siteId: detailSiteId, statTimeDimension: 1, pageNum: dp, pageSize: detailPageSize });
            const dlist = (dd && dd.result && dd.result.list) || [];
            for (const x of dlist) items.push(x);
            const dtotal = (dd && dd.result && dd.result.total) || 0;
            if (dlist.length < detailPageSize) break;
            if (dtotal && items.length >= dtotal) break;
          }
          detailRows.push({
            productSpuId: r.productSpuId ?? r.productId ?? null,
            productName: r.goodsName ?? r.productName ?? null,
            pictureUrl: r.goodsImageUrl ?? r.pictureUrl ?? null,
            goodsId, region, items,
          });
          diag.detailDays += items.length; diag.detailOk++;
        } catch (e) {
          diag.detailFail++;
          if (e && /HTTP 429/.test(String(e.message))) { idx = candidates.length; return; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency || 3) }, () => worker()));
    return { ok: true, listRows, detailRows, diag, firstListResp };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: e && e.code, diag, firstListResp };
  }
}

async function injectListFetch(payload, signal, cfg) {
  if (!payload.mallId) {
    throw Object.assign(new Error(`payload.mallId missing for ${cfg.logTag} (got ${JSON.stringify(payload)})`), { code: 'BAD_PAYLOAD' });
  }
  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };
  try {
    const tab = await chrome.tabs.create({ url: cfg.pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[${cfg.logTag}] tab ${tabId} → ${cfg.pageUrl} (mall=${payload.mallId})`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      throw Object.assign(new Error('agentseller 跳登录,需登录该平台账号'), { code: 'LOGIN_REQUIRED' });
    }
    await sleep(2000, signal);
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runListFetchInTab,
      args: [{
        apiPath: cfg.apiPath,
        mallId: String(payload.mallId),
        listKey: cfg.listKey,
        baseBody: cfg.baseBody ?? {},
        pageNoKey: cfg.pageNoKey ?? 'pageNo',
        pageSize: cfg.pageSize ?? 50,
        maxPages: Math.min(Number(payload.maxPages) || cfg.maxPages || 40, 200),
      }],
    });
    console.log(`[${cfg.logTag}] 注入页面抓取 ${cfg.apiPath} ...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[${cfg.logTag}] ✗ 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    console.log(`[${cfg.logTag}] ✓ mall=${payload.mallId} rows=${result.rows.length}(raw 回传,后端解析)`, { diag: result.diag, sample: result.rows[0] ?? null });
    return { rows: result.rows, rawCount: result.rows.length, completedAt: new Date().toISOString(), agent: agentDiag() };
  } finally {
    await cleanup();
  }
}

// MAIN-world 注入函数:通用列表分页(window.rose 现签 + mallid override)。纯函数,序列化注入。
async function runListFetchInTab(args) {
  const { apiPath, mallId, listKey, baseBody, pageNoKey, pageSize, maxPages } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(apiPath, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      return data;
    }
    throw new Error('退避重试 6 次仍失败(限流/系统异常)');
  };
  const diag = { pagesFetched: 0, total: null, collected: 0 };
  let firstListResp = null;
  try {
    const rows = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post({ ...baseBody, [pageNoKey]: p, pageSize });
      if (!firstListResp) firstListResp = data;
      diag.pagesFetched++;
      const list = (data && data.result && data.result[listKey]) || [];
      diag.total = (data && data.result && data.result.total != null) ? data.result.total : diag.total;
      for (const it of list) rows.push(it);
      diag.collected = rows.length;
      if (list.length < pageSize) break;
      if (diag.total != null && rows.length >= diag.total) break;
    }
    return { ok: true, rows, diag, firstListResp };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: e && e.code, diag, firstListResp };
  }
}

// 2026-06-13 gen-3:营销活动列表(单阶段),复用 injectListFetch。raw activityList 回传,
//   后端 parseMarketingActivityRows 解析(薄插件)。同 endpoint /api/kiana/gamblers/marketing/enroll/activity/list。
async function dispatchMarketingActivity(task, signal) {
  return injectListFetch(task.payload ?? {}, signal, {
    logTag: 'marketing-activity',
    pageUrl: 'https://agentseller.temu.com/activity/marketing-activity',
    apiPath: '/api/kiana/gamblers/marketing/enroll/activity/list',
    listKey: 'activityList',
    baseBody: { needSessionItem: true, needCanEnrollCnt: true },
    pageNoKey: 'pageNo',
    pageSize: 50,
  });
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
// 2026-06-13 gen-3 注入式重写(原 gen-1 dispatchViaHiddenTab 等页面被动触发 → 半托 detail 冷开
//   不一定自动发 → capture 不稳;非活跃 mall capture-timeout)。改注入 + window.rose 现签 + mallid override,
//   一个登录态可采同账号全/半托子店。同 endpoint(listOverall / sale-analysis-detail),无新接口。
//   raw listPath 项原样回传({rows}),后端 parseSalesRows/parseSemiDailyRows 解析(薄插件)。
async function dispatchSales30d(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:sales-30d (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const semi = isSemiPayload(payload);
  const pageUrl = semi ? SEMI_SALES_PAGE_URL : 'https://agentseller.temu.com/stock/fully-mgt/sale-manage/main';
  const apiPath = semi ? SEMI_SALES_API_PATH : '/mms/venom/api/supplier/sales/management/listOverall';
  const listKey = semi ? 'saleAnalysisDetailDTOList' : 'subOrderList';
  const baseBody = semi ? { timeType: payload.timeType ?? 4 } : { isLack: 0 };
  const pageNoKey = semi ? 'pageNum' : 'pageNo';
  const pageSize = semi ? 30 : 50;

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[sales-30d] tab ${tabId} → ${pageUrl} (mall=${payload.mallId} ${semi ? 'semi' : 'full'})`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      throw Object.assign(new Error('agentseller 跳登录,需登录该平台账号'), { code: 'LOGIN_REQUIRED' });
    }
    await sleep(2000, signal);

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runSalesInTab,
      args: [{ apiPath, mallId: String(payload.mallId), listKey, baseBody, pageNoKey, pageSize, maxPages: Math.min(Number(payload.maxPages) || 40, 200) }],
    });
    console.log(`[sales-30d] 注入页面抓取 ${apiPath} ...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);

    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error('[sales-30d] ✗ 页面内 fetch 失败', { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }

    console.log(
      `[sales-30d] ✓ mall=${payload.mallId} ${semi ? 'semi' : 'full'} rows=${result.rows.length}(raw 回传,后端解析)`,
      { diag: result.diag, sample: result.rows[0] ?? null },
    );
    return {
      rows: result.rows,
      rawCount: result.rows.length,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// ── MAIN-world 注入函数:销量/库存列表分页(window.rose 现签 + mallid override)──────────
// 纯函数(executeScript 序列化)。全托 listOverall(pageNo/50/{isLack:0})、半托 sale/analysis/detail
//(pageNum/30/{timeType});listKey 取 result 里的列表数组,raw 原样累加回传。
async function runSalesInTab(args) {
  const { apiPath, mallId, listKey, baseBody, pageNoKey, pageSize, maxPages } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(apiPath, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      return data;
    }
    throw new Error('退避重试 6 次仍失败(限流/系统异常)');
  };
  const diag = { pagesFetched: 0, total: null, collected: 0 };
  let firstListResp = null;
  try {
    const rows = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post({ ...baseBody, [pageNoKey]: p, pageSize });
      if (!firstListResp) firstListResp = data;
      diag.pagesFetched++;
      const list = (data && data.result && data.result[listKey]) || [];
      diag.total = (data && data.result && data.result.total != null) ? data.result.total : diag.total;
      for (const it of list) rows.push(it);
      diag.collected = rows.length;
      if (list.length < pageSize) break;
      if (diag.total != null && rows.length >= diag.total) break;
    }
    return { ok: true, rows, diag, firstListResp };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: e && e.code, diag, firstListResp };
  }
}

// ── scrape:sku-sales-daily 专用 wrapper ──────────────────────────
// 任务语义:全托管 per-SKU per-day 历史销量(querySkuSalesNumber),落到 ShopSkuDailySnapshot。
// payload: { mallId, dateFrom, dateTo }(productSkuIds 可选;不给则插件先用 listOverall 枚举)
// 步骤:① 复用 sales-30d(listOverall)枚举 SKU 列表 + 顺带 seed session;
//       ② 分块调 querySkuSalesNumber(同 mallId session 已缓存,直接复用 anti-content headers)。
async function dispatchSkuSalesDaily(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:sku-sales-daily (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const startDate = payload.startDate ?? payload.dateFrom;
  const endDate = payload.endDate ?? payload.dateTo;
  if (!startDate || !endDate) {
    throw Object.assign(
      new Error(`startDate/endDate missing for scrape:sku-sales-daily (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }

  // ① 枚举 SKU 列表 — 复用 sales-30d 的 listOverall(全托同页同 session),同时 seed session
  let skuIds = Array.isArray(payload.productSkuIds) ? payload.productSkuIds.map(Number).filter(Boolean) : [];
  if (skuIds.length === 0) {
    const salesSpec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
    const { transformed: skuRows } = await dispatchViaHiddenTab(salesSpec, payload, signal);
    skuIds = [...new Set(skuRows.map((r) => Number(r.platformSkuId)).filter(Boolean))];
  }
  if (skuIds.length === 0) {
    return { rows: [], rawCount: 0, completedAt: new Date().toISOString(), agent: agentDiag() };
  }

  // ② 分块调 querySkuSalesNumber(session 已缓存 → HIT,不再开 tab)
  const spec = KIND_TO_FETCH_SPEC['scrape:sku-sales-daily'];
  const CHUNK = 100;
  const rows = [];
  let rawCount = 0;
  for (let i = 0; i < skuIds.length; i += CHUNK) {
    const chunk = skuIds.slice(i, i + CHUNK);
    const { rawItems, transformed } = await dispatchViaHiddenTab(
      spec, { ...payload, productSkuIds: chunk, startDate, endDate }, signal,
    );
    rawCount += rawItems.length;
    rows.push(...transformed);
  }
  return { rows, rawCount, completedAt: new Date().toISOString(), agent: agentDiag() };
}

// ── scrape:activity-data 专用 wrapper ────────────────────────────
// 任务语义:抓本店"已报名活动 SKU 列表+活动价",落到 ActivityEnrollment。
// payload: { mallId } — API 按 mallid header 隔离店铺,其他不必要
// 2026-06-13 gen-3:活动报名数据(单阶段),复用 injectListFetch。raw /enroll/list result.list 回传,
//   后端 parseActivityEnrollmentRows 解析(薄插件)。sessionStatus:2 = 只取进行中场次。
async function dispatchActivityData(task, signal) {
  return injectListFetch(task.payload ?? {}, signal, {
    logTag: 'activity-data',
    pageUrl: 'https://agentseller.temu.com/activity/marketing-activity/log',
    apiPath: '/api/kiana/gamblers/marketing/enroll/list',
    listKey: 'list',
    baseBody: { sessionStatus: 2 },
    pageNoKey: 'pageNo',
    pageSize: 50,
  });
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
  // 半托(2026-06-06 §3.6.1):endpoint /api/flow/analysis/list,页面 /main/flux-analysis(无 -full 后缀,
  // 触发的正是 /api/flow/analysis/list);全托走 /main/flux-analysis-full + /api/seller/full/...。
  // 三区域 host 不变(REGION_TO_FLUX_PAGE_URL 已含 global/us/eu 的 agentseller 子域)。
  const semi = isSemiPayload(payload);
  const listApi   = semi ? '/api/flow/analysis/list'          : REGION_TO_FLUX_LIST_API[region];
  const detailApi = semi ? '/api/flow/analysis/goods/detail'  : REGION_TO_FLUX_DETAIL_API[region];
  const fullPageUrl = REGION_TO_FLUX_PAGE_URL[region];
  const pageUrl = semi ? (fullPageUrl ? fullPageUrl.replace('/main/flux-analysis-full', '/main/flux-analysis') : fullPageUrl)
                       : fullPageUrl;
  if (!listApi || !detailApi || !pageUrl) {
    throw Object.assign(
      new Error(`flux endpoints not configured for region=${region}`),
      { code: 'BAD_REGION' },
    );
  }
  // gen-3:开账号页注入 runFluxInTab,一次完成 list 翻页 + 每 SPU detail 批量(raw 回传,薄插件)
  const semiList = semi;
  const listBody = semiList
    ? { timeDimension: payload?.statisticType ?? 5, sortMode: 2, sortType: 5 }
    : { statisticType: payload?.statisticType ?? 5,
        siteId: payload?.siteId ?? REGION_TO_SITE_ID[region],
        ...(payload?.quickFilter ? { quickFilter: payload.quickFilter } : {}) };
  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 8 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };
  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[flux-analysis] tab ${tabId} → ${pageUrl} (mall=${payload.mallId}, region=${region}, semi=${semi})`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error('agentseller 跳登录,需登录该平台账号'), { code: 'LOGIN_REQUIRED' });
    await sleep(2000, signal);
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: runFluxInTab,
      args: [{
        listApiPath: listApi, detailApiPath: detailApi, mallId: String(payload.mallId),
        listBody, listPageNoKey: semiList ? 'pageNumber' : 'pageNo',
        listSize: semiList ? 100 : 50, listKey: semiList ? 'pageItems' : 'list',
        region, detailSiteId: payload.siteId ?? -1,
        detailPageSize: payload.detailPageSize ?? 30,
        maxPages: Math.min(Number(payload.maxPages) || 40, 200),
        concurrency: 3,
      }],
    });
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[flux-analysis] ✗ 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    console.log(`[flux-analysis] ✓ mall=${payload.mallId} list=${result.listRows.length} detailSPU=${result.detailRows.length}(raw 回传,后端解析)`, { diag: result.diag });
    return {
      rows: result.listRows,            // raw list items → 后端 parseFluxAnalysisRows
      detailRows: result.detailRows,    // 每 SPU 分组 { items } → 后端 parseFluxDetailGroups
      detailStats: { candidates: result.diag.detailCandidates, success: result.diag.detailOk, failed: result.diag.detailFail, skipped: result.diag.detailSkip },
      rawCount: result.listRows.length,
      statisticType: payload.statisticType ?? 5,
      siteId: payload.siteId ?? 0,
      region,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
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
  // gen-3:注入单 SPU detail 翻页(pageNum/pageSize),raw result.list 回传,后端 parseFluxDetailRows 解析
  const goodsId = Number(payload.goodsId ?? payload.productId);
  return injectListFetch(payload, signal, {
    logTag: 'flux-detail',
    pageUrl,
    apiPath: detailApi,
    listKey: 'list',
    baseBody: { goodsId, siteId: payload.siteId ?? -1, statTimeDimension: payload.statTimeDimension ?? 1 },
    pageNoKey: 'pageNum',
    pageSize: payload.pageSize ?? 30,
  });
}

// ── scrape:order-amounts 专用 wrapper ────────────────────────────
// 任务语义:抓订单产品金额(recentOrderList 分页 + batchQueryByOrder 批量 join)。
// 两段链式:第一段 dispatchViaHiddenTab 抓 recentOrderList(含 parentOrderSn),
//   第二段复用 cached session headers 批量直 POST batchQueryByOrder(50/批)。
// payload: { mallId, region? }
// ★ 方式改为 sellfox 同款(2026-06-08):不"开页面等 XHR 捕 session"(orders SPA 冷加载不发任何
//   可捕请求),而是开 orders 页 → 等加载 → executeScript 注入 MAIN-world 函数,在页面上下文里
//   直接 fetch recentOrderList + batchQueryByOrder。
//   anti-content:显式 window.rose 现签 + 退避重试(2026-06-10 修,见 runOrdersInTab 注释;
//   原"靠页面自动签"偶发 403)。返回 raw pageItems + batchQueryByOrder 响应,join 在 SW 里做。
async function dispatchOrderAmounts(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:order-amounts'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'global';
  const pageUrl = REGION_TO_ORDER_PAGE_URL[region];
  if (!pageUrl) throw Object.assign(new Error(`order page not configured for region=${region}`), { code: 'BAD_REGION' });

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[order-amounts] tab ${tabId} → ${pageUrl}`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);

    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      throw Object.assign(new Error(`${region} 订单页跳登录,需重新登录半托店`), { code: 'LOGIN_REQUIRED' });
    }
    await sleep(2000, signal);   // 让页面 WAF SDK 就绪

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runOrdersInTab,
      args: [{
        listPath: ORDER_LIST_PATH,
        supplierPricePath: ORDER_SUPPLIER_PRICE_PATH,
        listBody: { fulfillmentMode: null, queryType: 0, sortType: 1, timeZone: 'UTC+8', sellerNoteLabelList: [] },
        pageSize: 50,
        // 默认 20 页 ≈ 1000 单(近期);payload.maxPages 可调(一次性深采历史回填用,上限 200)
        maxPages: Math.min(Number(payload.maxPages) || 20, 200),
        batchSize: 50,
        mallId: String(payload.mallId),   // ★ 必带 mallid header,否则 400020037 No Permission
      }],
    });
    console.log(`[order-amounts] region=${region} 注入页面抓取(列表分页+供货价批量)...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);

    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    // ★ 注入函数跑页面 MAIN world,console 不进 SW → 它把 diag/样本 return 回来,这里结构化打日志
    if (!result.ok) {
      console.error(`[order-amounts] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }

    // ★ 薄插件(2026-06-11):不再本地 transform,raw 原样回传,解析统一在后端
    //   (AgentResultIngestor.parseOrderAmounts,含订单行 join + waybillInfoList 包裹提取)
    const pageItems = result.pageItems ?? [];
    const bqResponses = result.bqResponses ?? [];
    console.log(
      `[order-amounts] ✓ region=${region} orders=${pageItems.length} priceBatches=${bqResponses.length}(raw 回传,后端解析)`,
      { diag: result.diag, sampleOrder: pageItems[0] ?? null, samplePrice: bqResponses[0]?.result ?? null },
    );
    return {
      pageItems,
      bqResponses,
      rawCount: pageItems.length,
      orderCount: result.orderCount ?? 0,
      region,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// ── MAIN-world 注入函数:在 orders 页上下文里 fetch ───────────────────────────────────
// 必须是纯函数(executeScript 序列化),不能引用外部变量/import。同源相对路径 fetch。
// ★ 2026-06-10:从"靠页面 WAF SDK 自动签 anti-content"改为显式 window.rose 现签 + 退避重试
//   (与 runReturnsInTab 同款)。旧写法只带 mallid、不带 anti-content、且无重试 → 自动签偶发失败
//   时直接 HTTP 403 死(实测 recentOrderList 403)。显式签 + 重试后等价 returns 的稳健链路。
async function runOrdersInTab(args) {
  const { listPath, supplierPricePath, listBody, pageSize, maxPages, batchSize, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 显式生成 anti-content(页面 WAF SDK window.rose),每请求 fresh;失败回空串(让后端按缺签报错→重试)
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  // 429(HTTP)+ 20002(body 系统异常/请稍后重试)都退避重试(读 Retry-After,否则 2s/4s/6s...)。
  const post = async (path, body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(path, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${path.slice(0, 40)}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      return data;
    }
    throw new Error(`${path.slice(0, 40)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, totalItemNum: null, ordersCollected: 0, priceBatches: 0 };
  let firstListResp = null;
  try {
    // 1) recentOrderList 分页
    const pageItems = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post(listPath, { ...listBody, pageNumber: p, pageSize });
      if (!firstListResp) firstListResp = data;
      diag.pagesFetched++;
      diag.totalItemNum = data?.result?.totalItemNum ?? diag.totalItemNum;
      const items = data?.result?.pageItems ?? [];
      pageItems.push(...items);
      if (items.length < pageSize) break;
    }
    // 2) distinct parentOrderSn
    const seen = {};
    const sns = [];
    for (const it of pageItems) {
      const sn = it && it.parentOrderMap && it.parentOrderMap.parentOrderSn;
      if (sn && !seen[sn]) { seen[sn] = 1; sns.push(String(sn)); }
    }
    diag.ordersCollected = sns.length;
    // 3) batchQueryByOrder 批量
    const bqResponses = [];
    for (let i = 0; i < sns.length; i += batchSize) {
      bqResponses.push(await post(supplierPricePath, { parentOrderSnList: sns.slice(i, i + batchSize) }));
      diag.priceBatches++;
    }
    return { ok: true, pageItems, bqResponses, orderCount: sns.length, diag };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstListResp };
  }
}

// ── scrape:returns 专用 wrapper ──────────────────────────────────
// 任务语义:抓退货退款列表(afterSales 分页)+ 每条 afterSales 的详情。
// 两段:先 list 分页收全 parentAfterSalesSn,再逐条 detail,raw 回传(不解析)。
// payload: { mallId, region? }
async function dispatchReturns(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:returns'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'global';
  // ★ 用 orders.html 宿主页(实测它的 WAF SDK 能签 garen 请求 → 200/429);
  //   退货专属页 return-refund-list.html 反而 403 40001(WAF 上下文不同,anti-content 被拒)。
  const pageUrl = REGION_TO_ORDER_PAGE_URL[region];
  const detailPath = REGION_TO_RETURNS_DETAIL_PATH[region];
  if (!pageUrl || !detailPath) throw Object.assign(new Error(`returns 配置缺 region=${region}`), { code: 'BAD_REGION' });

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 8 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[returns] tab ${tabId} → ${pageUrl}`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error(`${region} 页跳登录,需重新登录半托店`), { code: 'LOGIN_REQUIRED' });
    await sleep(2000, signal);

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runReturnsInTab,
      args: [{
        listPath: RETURNS_LIST_PATH,
        detailPath,
        pageSize: 100,
        maxPages: 20,
        windowDays: 90,
        detailDelayMs: 500,
        mallId: String(payload.mallId),
      }],
    });
    console.log(`[returns] region=${region} 注入页面抓取(列表分页+详情逐单,可能 1-2min)...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    // ★ 注入函数跑在页面 MAIN world,console 不进 SW → 它把诊断/样本 return 回来,这里结构化打日志
    if (!result.ok) {
      console.error(`[returns] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const listPages = result.listPages ?? [];
    const details = result.details ?? [];
    console.log(
      `[returns] ✓ region=${region} listPages=${listPages.length} details=${details.length} cases=${result.afterSalesCount}`,
      {
        diag: result.diag,
        listTotalCount: listPages[0]?.result?.mmsPageVO?.totalCount ?? null,
        sampleListRow: listPages[0]?.result?.mmsPageVO?.data?.[0] ?? null,
        sampleDetailItem: details[0]?.result?.afterSalesItemVOList?.[0] ?? null,
      },
    );
    return {
      region, listPages, details,
      afterSalesCount: result.afterSalesCount ?? 0,
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// ── MAIN-world 注入:退货退款 list 分页 + detail 循环,raw 回传(不解析)──────
// 纯函数(序列化)。同源相对 fetch,WAF SDK 自动签 anti-content;必带 mallid header。
async function runReturnsInTab(args) {
  const { listPath, detailPath, pageSize, maxPages, windowDays, detailDelayMs, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // ★ sellfox 同款:显式生成 anti-content(页面 WAF SDK window.rose),不靠"页面自动签"(不稳→20002/403)。
  //   每请求 fresh。getAntiContent = new(window.rose(4))({serverTime:Date.now()}).messagePack()
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  // 429(HTTP)+ 20002(body 系统异常/请稍后重试)都退避重试(读 Retry-After,否则 2s/4s/6s...)。
  const post = async (path, body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(path, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${path.slice(0, 40)}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      return data;
    }
    throw new Error(`${path.slice(0, 40)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, listTotalCount: null, casesCollected: 0, detailsFetched: 0 };
  let firstListResp = null;
  try {
    const now = Date.now();
    const listBody = {
      groupSearchType: 0, pageSize, reverseSignedTimeSearchType: 7000,
      selectOnlyRefund: true, selectReturnRefund: true, timeSearchType: 5000,
      startCreatedTime: now - windowDays * 86400000, endCreatedTime: now,
    };
    const listPages = [];
    const seen = {};
    const pairs = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post(listPath, { ...listBody, pageNumber: p });
      if (!firstListResp) firstListResp = data;          // 失败时回传给 SW 看错误码
      listPages.push(data);
      diag.pagesFetched++;
      diag.listTotalCount = data?.result?.mmsPageVO?.totalCount ?? diag.listTotalCount;
      const rows = data?.result?.mmsPageVO?.data ?? [];
      for (const row of rows) {
        const pas = row?.parentAfterSalesSn;
        if (pas && !seen[pas]) { seen[pas] = 1; pairs.push({ parentAfterSalesSn: String(pas), parentOrderSn: row?.parentOrderSn != null ? String(row.parentOrderSn) : null }); }
      }
      if (rows.length < pageSize) break;
    }
    diag.casesCollected = pairs.length;
    const details = [];
    for (const pr of pairs) {
      details.push(await post(detailPath, { parentAfterSalesSn: pr.parentAfterSalesSn, parentOrderSn: pr.parentOrderSn }));
      diag.detailsFetched++;
      if (detailDelayMs) await wait(detailDelayMs);
    }
    return { ok: true, listPages, details, afterSalesCount: pairs.length, diag };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstListResp };
  }
}

// ── scrape:semi-ad 专用 wrapper(ads.temu.com 半托广告)────────────
async function dispatchSemiAd(task, signal) {
  const payload = task.payload ?? {};
  const region = payload.region ?? 'global';

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 6 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: SEMI_AD_PAGE_URL, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[semi-ad] tab ${tabId} → ${SEMI_AD_PAGE_URL}`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error(`ads.temu.com 跳登录,需登录半托广告后台`), { code: 'LOGIN_REQUIRED' });
    await sleep(2000, signal);

    console.log(`[semi-ad] region=${region} 注入页面抓取(近 7 天逐日 + 分页)...`);
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runSemiAdInTab,
      args: [{ reportPath: SEMI_AD_REPORT_PATH, windowDays: 7, pageSize: 50, maxPages: 20, dayDelayMs: 300 }],
    });
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[semi-ad] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const dayReports = result.dayReports ?? [];
    const totalRows = dayReports.reduce((s, d) => s + (d.pages ?? []).reduce((a, p) => a + (p?.result?.ads_detail?.length ?? 0), 0), 0);
    console.log(`[semi-ad] ✓ region=${region} days=${dayReports.length} 商品行=${totalRows}`, {
      diag: result.diag,
      sampleRow: dayReports[0]?.pages?.[0]?.result?.ads_detail?.[0] ?? null,
    });
    return { region, dayReports, diag: result.diag, completedAt: new Date().toISOString(), agent: agentDiag() };
  } finally {
    await cleanup();
  }
}

// ── MAIN-world 注入:ads.temu.com 逐日 + 分页 fetch ads_report,raw 回传(不解析)──────
// 实测:不需 x-phan-data / list_id / mallid(cookie 自带)。纯函数(序列化)。
async function runSemiAdInTab(args) {
  const { reportPath, windowDays, pageSize, maxPages, dayDelayMs } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const diag = { daysQueried: 0, pagesFetched: 0, rows: 0 };
  let firstResp = null;
  const post = async (body) => {
    const resp = await fetch(reportPath, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${reportPath}`);
    return resp.json();
  };
  const baseBody = {
    ad_status: [], specific_query_info: '', sort_by: 0, sort_type: 'desc', source: 0,
    need_del_status_ad: true, need_calculate_goods_summary: true, selected_roas_type: 1,
    filter_cooperative_ad_type: 0, data_filter: null, ad_group_list: null,
    selected_site_id_list: null, ad_phase: -1, columns_type: 21,
  };
  try {
    const now = new Date();
    const dayReports = [];
    for (let d = 0; d < windowDays; d++) {
      const day = new Date(now.getTime() - d * 86400000);
      const y = day.getFullYear(), m = String(day.getMonth() + 1).padStart(2, '0'), dd = String(day.getDate()).padStart(2, '0');
      const reportDate = `${y}-${m}-${dd}`;
      const startMs = new Date(`${reportDate}T00:00:00`).getTime();
      const endMs = startMs + 86400000 - 1;
      const pages = [];
      for (let p = 1; p <= maxPages; p++) {
        const data = await post({ ...baseBody, start_time: startMs, end_time: endMs, page_number: p, page_size: pageSize });
        if (!firstResp) firstResp = data;
        pages.push(data);
        diag.pagesFetched++;
        diag.rows += data?.result?.ads_detail?.length ?? 0;
        if (!data?.result?.has_more) break;
      }
      dayReports.push({ reportDate, pages });
      diag.daysQueried++;
      if (dayDelayMs) await wait(dayDelayMs);
    }
    return { ok: true, dayReports, diag };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
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
  // MALL_MISMATCH 防御(同账号多 mall 放行 — 见 dispatchViaHiddenTab 同款注释)
  const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
  if (capturedMall && String(capturedMall) !== String(mallId)) {
    if (accountOwnsMall(mallId)) {
      session.headers = overrideMallidHeader(session.headers, mallId);
      session.mallId = String(mallId);
    } else {
      await invalidateSession(mallId);
      throw Object.assign(
        new Error(`MALL_MISMATCH: submit expects mallId=${mallId} but chrome is ${capturedMall} (account malls=[${(_userIdCache.mallIdList || []).join(',')}])`),
        { code: 'MALL_MISMATCH' },
      );
    }
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
  // MALL_MISMATCH 防御(同账号多 mall 放行 — 见 dispatchViaHiddenTab 同款注释)
  const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
  if (capturedMall && String(capturedMall) !== String(mallId)) {
    if (accountOwnsMall(mallId)) {
      session.headers = overrideMallidHeader(session.headers, mallId);
      session.mallId = String(mallId);
    } else {
      throw Object.assign(
        new Error(`MALL_MISMATCH: enroll expects mallId=${mallId} but chrome is ${capturedMall} (account malls=[${(_userIdCache.mallIdList || []).join(',')}])`),
        { code: 'MALL_MISMATCH' },
      );
    }
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

// ── 区域共享 tab 池 ──────────────────────────────────────────────────
// 结算报表的注入式子项(发货/退货面单费、EPR)同区同源(agentseller[-region].temu.com),
// 本来每子项各开一个 tab。改成按 origin 共用一个 tab:首个子项开 tab(等加载/查登录/WAF 就绪),
// 同区其余子项复用同一 tab,在其中并发 executeScript 抓取。一轮跑完 closeRegionTabPool 统一关。
// → 整个结算报表只开 3 个 tab(global/eu/us 各一)。
const _regionTabPool = new Map();   // origin → { tabId, ready: Promise<number> }
async function acquireRegionTab(pageUrl, signal) {
  const origin = new URL(pageUrl).origin;
  const existing = _regionTabPool.get(origin);
  if (existing) return existing.ready;   // 复用(或等待首个 caller 把 tab 开好)
  const entry = { tabId: null, ready: null };
  entry.ready = (async () => {
    const tab = await chrome.tabs.create({ url: origin + '/', active: false, pinned: false });
    entry.tabId = tab.id;
    console.log(`[region-tab] 开 ${origin} → tab ${tab.id}`);
    await waitTabComplete(tab.id, signal, 30_000);
    const t = await chrome.tabs.get(tab.id);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error(`${origin} 跳登录,需重新登录半托店`), { code: 'LOGIN_REQUIRED' });
    await sleep(2000, signal);   // 等页面 WAF SDK 就绪
    return tab.id;
  })();
  _regionTabPool.set(origin, entry);
  try {
    return await entry.ready;
  } catch (e) {
    // 开 tab 失败(如跳登录):清出池 + 关掉半开的 tab,让本区其余子项各自如实失败
    _regionTabPool.delete(origin);
    if (entry.tabId != null) { try { await chrome.tabs.remove(entry.tabId); } catch {} }
    throw e;
  }
}
async function closeRegionTabPool() {
  for (const entry of _regionTabPool.values()) {
    if (entry.tabId != null) { try { await chrome.tabs.remove(entry.tabId); } catch {} }
  }
  _regionTabPool.clear();
}

// ── scrape:logistics-bill 专用 wrapper ───────────────────────────────
// 任务语义:抓半托物流对账账单(发货面单费等包裹级费用)。raw 回传,后端
// parseLogisticsBillRows 解析(薄插件)。endpoint/字段 2026-06-11 实抓确认:
//   POST /api/udp/yuanbenchu/seller_central/recon_bill/list
//   body { settleStatus, deductTimeBegin/End(epoch ms), rowCount, scrollContext }
//   响应 result.sellerBillList[]:reconciliationId/packageSn/waybillSn/statusDesc/
//   priceCurrencyFormat{amountYuan,currencyCode}/deductTime/serviceProviderName
// payload: { mallId, region?, dateFrom?, dateTo?, settleStatus? }
const REGION_TO_LOGISTICS_PAGE_URL = {
  global: 'https://agentseller.temu.com',
  us:     'https://agentseller-us.temu.com',
  eu:     'https://agentseller-eu.temu.com',
};
// 发货面单费列表(2026-06-22 用户实抓确认):selene recon/list,按区同 path 不同域名。
//   旧的 yuanbenchu/recon_bill 接口换掉 —— 全球那个是跨区聚合账本(把别区包裹也捞进来、
//   响应结构还不同导致 fee_type 误标),美区 udp 那个只返近期。selene 才是正解:
//   body 无时间窗,settleStatus:2(已结算)+ scrollContext 翻页 → 返回全部已结算记录。
//   响应 result.list[],费用类型在 remark(发货面单费（揽收/全段/尾程派送）),金额 priceCurrencyFormat.amountYuan。
const REGION_TO_LOGISTICS_BILL_LIST_PATH = {
  global: '/portal/selene/seller/portal/recon/list',
  eu:     '/portal/selene/seller/portal/recon/list',
  us:     '/portal/selene/seller/portal/recon/list',
};

async function dispatchLogisticsBill(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:logistics-bill'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'us';
  const pageUrl = REGION_TO_LOGISTICS_PAGE_URL[region];
  if (!pageUrl) throw Object.assign(new Error(`logistics page not configured for region=${region}`), { code: 'BAD_REGION' });
  const listPath = REGION_TO_LOGISTICS_BILL_LIST_PATH[region];
  if (!listPath) throw Object.assign(new Error(`logistics list path not configured for region=${region}`), { code: 'BAD_REGION' });

  // selene recon/list 无时间窗:settleStatus:2(已结算)+ scrollContext 翻页,返回全部已结算记录。
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;

  try {
    tabId = await acquireRegionTab(pageUrl, signal);   // 区域共享 tab(等加载/查登录/WAF 已在池内做)
    console.log(`[logistics-bill] region=${region} 用共享 tab ${tabId}`);

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runLogisticsBillInTab,
      args: [{
        listPath,
        settleStatus: payload.settleStatus ?? 2,   // selene:2=已结算(实抓确认)
        rowCount: 100,
        maxPages: 100,                             // 无时间窗全量翻页(总量可能大)
        mallId: String(payload.mallId),
      }],
    });
    console.log(`[logistics-bill] region=${region} 注入页面抓取(scrollContext 翻页)...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    // ★ 注入函数跑页面 MAIN world,console 不进 SW → diag/样本 return 回来这里结构化打日志
    if (!result.ok) {
      console.error(`[logistics-bill] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      const firstResp = result.firstResp ? ` firstResp=${JSON.stringify(result.firstResp).slice(0, 500)}` : '';
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}${firstResp}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const pages = result.pages ?? [];
    console.log(
      `[logistics-bill] ✓ region=${region} pages=${pages.length} bills=${result.billCount}`,
      { diag: result.diag, sampleBill: pages[0]?.result?.list?.[0] ?? null },
    );
    return {
      region, pages,
      billCount: result.billCount ?? 0,
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    // tab 由区域池统一关闭(closeRegionTabPool),此处不关
  }
}

// MAIN-world 注入:物流对账列表分页(scrollContext 游标)。纯函数,不引外部变量。
// anti-content 策略:先裸发(订单页实测 kirogi 不带签也通);403/40001 再尝试
// window.rose 显式签(若页面有);429/20002 退避重试。diag.signMode 记录最终生效模式。
async function runLogisticsBillInTab(args) {
  const { listPath, settleStatus, rowCount, maxPages, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let signMode = 'none';   // none | rose
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { 'content-type': 'application/json', 'mallid': String(mallId) };
      if (signMode === 'rose') {
        const ac = genAntiContent();
        if (ac) headers['anti-content'] = ac;
      }
      const resp = await fetch(listPath, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (resp.status === 403) {
        // 裸发被 WAF 拒 → 升级显式签再试
        if (signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP 403: ${txt.slice(0, 120)}`);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false) {
        const code = Number(data.errorCode);
        if (code === 40001 && signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        if (code === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || '')) {
          await wait(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`errorCode=${data.errorCode}: ${String(data.errorMsg ?? '').slice(0, 120)}`);
      }
      return data;
    }
    throw new Error(`${listPath.slice(0, 50)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, billsCollected: 0, signMode, lastScrollContext: null };
  let firstResp = null;
  try {
    const pages = [];
    let scrollContext = null;
    let billCount = 0;
    for (let p = 1; p <= maxPages; p++) {
      const data = await post({ settleStatus, rowCount, scrollContext });
      if (!firstResp) firstResp = data;
      diag.pagesFetched++;
      const list = data?.result?.list ?? [];
      billCount += list.length;
      pages.push(data);
      scrollContext = data?.result?.scrollContext ?? data?.result?.nextScrollContext ?? null;
      diag.lastScrollContext = scrollContext ? String(scrollContext).slice(0, 40) : null;
      if (list.length < rowCount || !scrollContext) break;
    }
    diag.billsCollected = billCount;
    diag.signMode = signMode;
    return { ok: true, pages, billCount, diag };
  } catch (e) {
    diag.signMode = signMode;
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
}

// ── scrape:violation-appeals 专用 wrapper ────────────────────────────
// 任务语义:抓半托违规申诉中心(违规 + 预估罚款)。raw 回传,后端
// parseViolationAppeals 解析。endpoint/字段 2026-06-11 实抓确认:
//   POST /reaper/violation/appeal/queryMallAppeals
//   body { targetType:1, pageNo, pageSize },响应 result.total + result.pageData[]
//   行:violationAppealSn/violationType/appealStatus/informTime/
//   mallAttribute{exceptedAmount(预估串),actualAmount(实扣,多 null),orderSnList,parentOrderSnList}
// ⚠️ reaper 域用 x-phan-data(非 anti-content)。注入式裸发先试(页面对 reaper 接口
//    很可能自动注入 x-phan-data);失败看 firstResp 再定。
// payload: { mallId, region? }
const REGION_TO_VIOLATION_PAGE_URL = {
  global: 'https://agentseller.temu.com/mmsos/mall-appeal.html?targetType=1',
  us:     'https://agentseller-us.temu.com/mmsos/mall-appeal.html?targetType=1',
  eu:     'https://agentseller-eu.temu.com/mmsos/mall-appeal.html?targetType=1',
};
const VIOLATION_LIST_PATH = '/reaper/violation/appeal/queryMallAppeals';

async function dispatchViolationAppeals(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:violation-appeals'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'us';
  const pageUrl = REGION_TO_VIOLATION_PAGE_URL[region];
  if (!pageUrl) throw Object.assign(new Error(`violation page not configured for region=${region}`), { code: 'BAD_REGION' });

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[violation-appeals] tab ${tabId} → ${pageUrl}`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error(`${region} 违规申诉页跳登录,需重新登录半托店`), { code: 'LOGIN_REQUIRED' });
    await sleep(3500, signal);   // reaper 页 WAF/x-phan SDK 就绪(注入函数内再轮询等 fetch 包装)

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runViolationAppealsInTab,
      args: [{
        listPath: VIOLATION_LIST_PATH,
        targetType: 1,
        pageSize: 50,
        maxPages: 50,
        mallId: String(payload.mallId),
      }],
    });
    console.log(`[violation-appeals] region=${region} 注入页面抓取(pageNo 翻页)...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[violation-appeals] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const pages = result.pages ?? [];
    console.log(
      `[violation-appeals] ✓ region=${region} pages=${pages.length} violations=${result.violationCount}`,
      { diag: result.diag, sampleRow: pages[0]?.result?.pageData?.[0] ?? null },
    );
    return {
      region, pages,
      violationCount: result.violationCount ?? 0,
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// MAIN-world 注入:违规申诉列表 pageNo 翻页。纯函数。
// reaper 域用 x-phan-data 自动签(页面 fetch 上下文),我们只手动带 mallid;
// 若被拒(403/40001)记 firstResp 观察(本接口签名机制不同于 anti-content)。
async function runViolationAppealsInTab(args) {
  const { listPath, targetType, pageSize, maxPages, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // ★ reaper 域 x-phan-data 由页面包装的 fetch 自动注入(实测 console 手调 success)。
  //   裸 native fetch → 40001 Invalid Login State。注入可能早于页面包装完成 →
  //   先轮询等 window.fetch 变成非 native(已被页面 SDK 包装)再发,最多等 ~25s。
  let fetchWrapped = false;
  for (let i = 0; i < 50; i++) {
    if (!/native code/.test('' + window.fetch)) { fetchWrapped = true; break; }
    await wait(500);
  }
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { 'content-type': 'application/json', 'mallid': String(mallId) };
      const resp = await fetch(listPath, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        // 403/40001 多为 x-phan-data 未就绪(fetch 包装延迟)→ 退避重试
        if ((resp.status === 403 || resp.status === 401) && attempt < 5) { await wait(1500 * (attempt + 1)); continue; }
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false) {
        const code = Number(data.errorCode);
        // 40001 Invalid Login State = x-phan-data 缺/未就绪;20002 系统异常 → 退避重试
        if (code === 40001 || code === 20002 || /系统异常|请稍后|刷新重试|login/i.test(data.errorMsg || '')) {
          await wait(1500 * (attempt + 1));
          continue;
        }
        throw new Error(`errorCode=${data.errorCode}: ${String(data.errorMsg ?? '').slice(0, 120)}`);
      }
      return data;
    }
    throw new Error(`${listPath.slice(0, 50)}: 退避重试 6 次仍失败(40001/限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, violationsCollected: 0, total: null, fetchWrapped };
  let firstResp = null;
  try {
    const pages = [];
    let violationCount = 0;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const data = await post({ targetType, pageNo, pageSize });
      if (!firstResp) firstResp = data;
      diag.pagesFetched++;
      if (diag.total == null) diag.total = data?.result?.total ?? null;
      const list = data?.result?.pageData ?? [];
      violationCount += list.length;
      pages.push(data);
      if (list.length < pageSize) break;
      await wait(300);
    }
    diag.violationsCollected = violationCount;
    return { ok: true, pages, violationCount, diag };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
}

// ── scrape:reverse-logistics-bill 专用 wrapper ───────────────────────
// 任务语义:抓半托退货面单费(逆向物流对账,商家承担)。raw 回传,后端
// parseReverseLogisticsBillRows 解析(薄插件)。endpoint/字段 2026-06-11 实抓确认:
//   POST /portal/udp/sunce/seller/center/bill/list
//   body { deductTimeBegin/End(epoch ms), pageSize, scrollContextString, sellerPortalBizType }
//   响应 result.list[]:reconciliationId/parentOrderSn(直给)/wayBillSn/deductType/
//   totalCharge(元串)/deductTime/sign/remark(退货面单费（全段）)
// payload: { mallId, region?, dateFrom?, dateTo? }
const REGION_TO_REVERSE_LOGISTICS_PAGE_URL = {
  global: 'https://agentseller.temu.com',
  us:     'https://agentseller-us.temu.com',
  eu:     'https://agentseller-eu.temu.com',
};
// 退货面单费列表 path 按区分(同发货面单费一样要分区,早期硬编码美区 udp 路径
// 导致欧区/全球 403 "No Permission to Access")。
//   - 美区:半托美国本土平台 sunce/center/bill(2026-06-11 实抓)
//   - 欧区/全球:selene 退货列表(2026-06-22 用户实抓确认)。同一 path,
//     商家仓 vs 第三方仓靠 body.sellerPortalBizType(2/3)区分。
const REGION_TO_REVERSE_LOGISTICS_BILL_LIST_PATH = {
  us:     '/portal/udp/sunce/seller/center/bill/list',
  eu:     '/portal/selene/seller/return/list',
  global: '/portal/selene/seller/return/list',
};

async function dispatchReverseLogisticsBill(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:reverse-logistics-bill'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'us';
  const pageUrl = REGION_TO_REVERSE_LOGISTICS_PAGE_URL[region];
  if (!pageUrl) throw Object.assign(new Error(`reverse logistics page not configured for region=${region}`), { code: 'BAD_REGION' });
  const listPath = REGION_TO_REVERSE_LOGISTICS_BILL_LIST_PATH[region];
  if (!listPath) throw Object.assign(new Error(`reverse logistics list path not configured for region=${region}`), { code: 'BAD_REGION' });
  const sellerPortalBizType = payload.sellerPortalBizType == null ? 2 : Number(payload.sellerPortalBizType);
  if (![2, 3].includes(sellerPortalBizType)) {
    throw Object.assign(new Error(`invalid sellerPortalBizType=${payload.sellerPortalBizType} for scrape:reverse-logistics-bill`), { code: 'BAD_PAYLOAD' });
  }

  // deductTime 窗口:dateFrom/dateTo(YYYY-MM-DD,北京日)→ epoch ms;缺省近 15 天
  const now = Date.now();
  const deductTimeBegin = payload.dateFrom ? new Date(`${payload.dateFrom}T00:00:00+08:00`).getTime() : now - 15 * 86_400_000;
  const deductTimeEnd   = payload.dateTo   ? new Date(`${payload.dateTo}T23:59:59.999+08:00`).getTime() : now;

  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;

  try {
    tabId = await acquireRegionTab(pageUrl, signal);   // 区域共享 tab(等加载/查登录/WAF 已在池内做)
    console.log(`[reverse-logistics-bill] region=${region} 用共享 tab ${tabId}`);

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runReverseLogisticsBillInTab,
      args: [{
        listPath,
        deductTimeBegin, deductTimeEnd,
        pageSize: 100,
        maxPages: 50,
        mallId: String(payload.mallId),
        sellerPortalBizType,
      }],
    });
    console.log(`[reverse-logistics-bill] region=${region} bizType=${sellerPortalBizType} 注入页面抓取(scrollContextString 翻页)...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[reverse-logistics-bill] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      const firstResp = result.firstResp ? ` firstResp=${JSON.stringify(result.firstResp).slice(0, 500)}` : '';
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}${firstResp}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const pages = result.pages ?? [];
    console.log(
      `[reverse-logistics-bill] ✓ region=${region} bizType=${sellerPortalBizType} pages=${pages.length} bills=${result.billCount}`,
      { diag: result.diag, sampleBill: pages[0]?.result?.list?.[0] ?? null },
    );
    return {
      region, sellerPortalBizType, pages,
      billCount: result.billCount ?? 0,
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    // tab 由区域池统一关闭(closeRegionTabPool),此处不关
  }
}

// MAIN-world 注入:逆向物流对账列表分页(scrollContextString 游标)。纯函数。
// anti-content 策略同正向 logistics-bill:先裸发,403/40001 升级 window.rose 显式签,
// 429/20002 退避重试。
async function runReverseLogisticsBillInTab(args) {
  const { listPath, deductTimeBegin, deductTimeEnd, pageSize, maxPages, mallId, sellerPortalBizType } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let signMode = 'none';
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { 'content-type': 'application/json', 'mallid': String(mallId) };
      if (signMode === 'rose') {
        const ac = genAntiContent();
        if (ac) headers['anti-content'] = ac;
      }
      const resp = await fetch(listPath, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (resp.status === 403) {
        if (signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP 403: ${txt.slice(0, 120)}`);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false) {
        const code = Number(data.errorCode);
        if (code === 40001 && signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        if (code === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || '')) {
          await wait(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`errorCode=${data.errorCode}: ${String(data.errorMsg ?? '').slice(0, 120)}`);
      }
      return data;
    }
    throw new Error(`${listPath.slice(0, 50)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, billsCollected: 0, signMode, lastScrollContext: null };
  let firstResp = null;
  try {
    const pages = [];
    let scrollContextString = null;
    let billCount = 0;
    for (let p = 1; p <= maxPages; p++) {
      const data = await post({ deductTimeBegin, deductTimeEnd, pageSize, scrollContextString, sellerPortalBizType });
      if (!firstResp) firstResp = data;
      diag.pagesFetched++;
      const list = data?.result?.list ?? [];
      billCount += list.length;
      pages.push(data);
      scrollContextString = data?.result?.scrollContextString ?? data?.result?.scrollContext ?? data?.result?.nextScrollContext ?? null;
      diag.lastScrollContext = scrollContextString ? String(scrollContextString).slice(0, 40) : null;
      if (list.length < pageSize || !scrollContextString) break;
    }
    diag.billsCollected = billCount;
    diag.signMode = signMode;
    return { ok: true, pages, billCount, diag };
  } catch (e) {
    diag.signMode = signMode;
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
}

// ── scrape:epr-* 专用 wrapper ───────────────────────────────────────
// 已确认接口来自 sellfox 反编译记录,当前只接欧区:
//   goods:    POST /api/merchant/eprfee/goods/page-query
//   package:  POST /api/merchant/eprfee/package/query
//   platform: POST /api/merchant/eprfee/platform/deducted/page-query
// 打开的 tab 始终是 agentseller-eu 的业务页,不是 endpoint 落地页。
const EPR_EU_PAGE_URL = 'https://agentseller-eu.temu.com';
const EPR_FEE_CONFIG = {
  goods: {
    label: '商品环保费',
    listPath: '/api/merchant/eprfee/goods/page-query',
    queryTypes: [2, 4],
    body: ({ financeStartTime, financeEndTime, pageNum, pageSize, queryType }) => ({
      financeStartTime, financeEndTime, pageNum, pageSize, queryType,
    }),
    list: (data, queryType) => queryType === 4
      ? (data?.result?.refundedEprFeeInfoList ?? data?.result?.dataList ?? [])
      : (data?.result?.deductedEprFeeInfoList ?? data?.result?.dataList ?? []),
  },
  package: {
    label: '物流包装环保费',
    listPath: '/api/merchant/eprfee/package/query',
    queryTypes: [2],
    body: ({ financeStartTime, financeEndTime, pageNum, pageSize, queryType }) => ({
      financeStartTime, financeEndTime, pageNum, pageSize, queryType,
    }),
    list: (data) => data?.result?.deductedEprFeeInfoList ?? data?.result?.dataList ?? [],
  },
  platform: {
    label: '代付服务费',
    listPath: '/api/merchant/eprfee/platform/deducted/page-query',
    queryTypes: [null],
    body: ({ financeDateStart, financeDateEnd, pageNum, pageSize }) => ({
      financeDateStart, financeDateEnd, pageNum, pageSize,
    }),
    list: (data) => data?.result?.dataList ?? [],
  },
};

async function dispatchEprFee(task, signal, feeType) {
  const payload = task.payload ?? {};
  const cfg = EPR_FEE_CONFIG[feeType];
  if (!cfg) throw Object.assign(new Error(`unsupported epr fee type=${feeType}`), { code: 'BAD_PAYLOAD' });
  if (!payload.mallId) throw Object.assign(new Error(`payload.mallId missing for ${task.kind}`), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'eu';
  if (region !== 'eu') {
    throw Object.assign(new Error(`EPR ${feeType} endpoint only confirmed for eu, got region=${region}`), { code: 'BAD_REGION' });
  }

  const now = Date.now();
  const dateFrom = payload.dateFrom ?? payload.startDate ?? (() => {
    const d = new Date(now - 30 * 86_400_000 + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  })();
  const dateTo = payload.dateTo ?? payload.endDate ?? (() => {
    const d = new Date(now + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  })();
  const financeStartTime = new Date(`${dateFrom}T00:00:00+08:00`).getTime();
  const financeEndTime = new Date(`${dateTo}T23:59:59.999+08:00`).getTime();
  if (!Number.isFinite(financeStartTime) || !Number.isFinite(financeEndTime)) {
    throw Object.assign(new Error('invalid dateFrom/dateTo for epr fee'), { code: 'BAD_PAYLOAD' });
  }

  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;

  try {
    tabId = await acquireRegionTab(EPR_EU_PAGE_URL, signal);   // 区域共享 tab(eu;等加载/查登录/WAF 已在池内做)
    console.log(`[epr-fee] ${cfg.label} 用共享 tab ${tabId}`);

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runEprFeeInTab,
      args: [{
        feeType,
        listPath: cfg.listPath,
        financeStartTime,
        financeEndTime,
        financeDateStart: dateFrom,
        financeDateEnd: dateTo,
        pageSize: 100,
        maxPages: 100,
        mallId: String(payload.mallId),
      }],
    });
    console.log(`[epr-fee] ${cfg.label} region=eu 注入页面抓取 window=${dateFrom}~${dateTo} ...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error(`[epr-fee] ✗ ${cfg.label} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    console.log(`[epr-fee] ✓ ${cfg.label} pages=${result.pages?.length ?? 0} rows=${result.rowCount ?? 0}`, { diag: result.diag });
    return {
      region: 'eu',
      feeType,
      pages: result.pages ?? [],
      rowCount: result.rowCount ?? 0,
      window: { dateFrom, dateTo },
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    // tab 由区域池统一关闭(closeRegionTabPool),此处不关
  }
}

async function runEprFeeInTab(args) {
  const { feeType, listPath, financeStartTime, financeEndTime, financeDateStart, financeDateEnd, pageSize, maxPages, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const configs = {
    goods: {
      queryTypes: [2, 4],
      body: ({ pageNum, queryType }) => ({ financeStartTime, financeEndTime, pageNum, pageSize, queryType }),
      list: (data, queryType) => queryType === 4
        ? (data?.result?.refundedEprFeeInfoList ?? data?.result?.dataList ?? [])
        : (data?.result?.deductedEprFeeInfoList ?? data?.result?.dataList ?? []),
    },
    package: {
      queryTypes: [2],
      body: ({ pageNum, queryType }) => ({ financeStartTime, financeEndTime, pageNum, pageSize, queryType }),
      list: (data) => data?.result?.deductedEprFeeInfoList ?? data?.result?.dataList ?? [],
    },
    platform: {
      queryTypes: [null],
      body: ({ pageNum }) => ({ financeDateStart, financeDateEnd, pageNum, pageSize }),
      list: (data) => data?.result?.dataList ?? [],
    },
  };
  const cfg = configs[feeType];
  if (!cfg) return { ok: false, code: 'BAD_FEE_TYPE', error: `unknown feeType=${feeType}` };

  let signMode = 'none';
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { 'content-type': 'application/json', 'mallid': String(mallId) };
      if (signMode === 'rose') {
        const ac = genAntiContent();
        if (ac) headers['anti-content'] = ac;
      }
      const resp = await fetch(listPath, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (resp.status === 403) {
        if (signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP 403: ${txt.slice(0, 120)}`);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false) {
        const code = Number(data.errorCode);
        if (code === 40001 && signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        if (code === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || '')) {
          await wait(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`errorCode=${data.errorCode}: ${String(data.errorMsg ?? '').slice(0, 120)}`);
      }
      return data;
    }
    throw new Error(`${listPath.slice(0, 50)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };

  const diag = { pagesFetched: 0, rowsCollected: 0, signMode, totals: [] };
  let firstResp = null;
  try {
    const pages = [];
    let rowCount = 0;
    for (const queryType of cfg.queryTypes) {
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const data = await post(cfg.body({ pageNum, queryType }));
        if (!firstResp) firstResp = data;
        diag.pagesFetched++;
        const list = cfg.list(data, queryType);
        const total = data?.result?.total ?? data?.result?.totalCount ?? data?.result?.totalItemNum ?? null;
        if (pageNum === 1) diag.totals.push({ queryType, total });
        rowCount += list.length;
        pages.push({ feeType, queryType, pageNum, response: data });
        if (list.length < pageSize) break;
        if (total != null && pageNum * pageSize >= Number(total)) break;
        await wait(300);
      }
    }
    diag.rowsCollected = rowCount;
    diag.signMode = signMode;
    return { ok: true, pages, rowCount, diag };
  } catch (e) {
    diag.signMode = signMode;
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
}

// ── scrape:settle-flow 专用 wrapper ──────────────────────────────────
// 任务语义:抓半托「已到账」结算流水明细(销售回款/运费回款逐笔)。raw 回传,
// 后端 parseSettleFlowRows 解析(薄插件)。endpoint/字段 2026-06-11 实抓确认:
//   POST /api/xiaowenhou/settle-flow/sm/settled/o/page-query
//   body { pageSize:20, pageNum, orderCreateTimeStart/End(YYYY-MM-DD,北京日) }
//   响应 result.dataList[]:settleId/batchSn/parentOrderSn/transSn/type/
//   settleAmount{value,sign}/skuItems[{id,number,extCode,supplyPrice}]/accountTime
// payload: { mallId, region?, dateFrom?, dateTo? }
const REGION_TO_SETTLE_PAGE_URL = {
  global: 'https://agentseller.temu.com/labor/settle',
  us:     'https://agentseller-us.temu.com/labor/settle',
  eu:     'https://agentseller-eu.temu.com/labor/settle',
};
const SETTLE_FLOW_LIST_PATH = '/api/xiaowenhou/settle-flow/sm/settled/o/page-query';

async function dispatchSettleFlow(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) throw Object.assign(new Error('payload.mallId missing for scrape:settle-flow'), { code: 'BAD_PAYLOAD' });
  const region = payload.region ?? 'us';
  const pageUrl = REGION_TO_SETTLE_PAGE_URL[region];
  if (!pageUrl) throw Object.assign(new Error(`settle page not configured for region=${region}`), { code: 'BAD_REGION' });

  // 窗口=订单创建北京日(YYYY-MM-DD 直传 body);缺省近 45 天(覆盖结算滞后)
  const fmtBjDate = (ms) => {
    const d = new Date(ms + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const now = Date.now();
  const orderCreateTimeStart = payload.dateFrom ?? fmtBjDate(now - 45 * 86_400_000);
  const orderCreateTimeEnd   = payload.dateTo   ?? fmtBjDate(now);

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[settle-flow] tab ${tabId} → ${pageUrl}`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);
    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) throw Object.assign(new Error(`${region} 结算页跳登录,需重新登录半托店`), { code: 'LOGIN_REQUIRED' });
    await sleep(2000, signal);   // 让页面 WAF SDK 就绪

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runSettleFlowInTab,
      args: [{
        listPath: SETTLE_FLOW_LIST_PATH,
        orderCreateTimeStart, orderCreateTimeEnd,
        pageSize: 20,            // 仅验证 20;改大需实测
        maxPages: 200,
        mallId: String(payload.mallId),
      }],
    });
    console.log(`[settle-flow] region=${region} 注入页面抓取(pageNum 翻页)window=${orderCreateTimeStart}~${orderCreateTimeEnd} ...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);
    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    // ★ 注入函数跑页面 MAIN world,console 不进 SW → diag/样本 return 回来这里结构化打日志
    if (!result.ok) {
      console.error(`[settle-flow] ✗ region=${region} 页面内 fetch 失败`, { error: result.error, code: result.code, diag: result.diag, firstResp: result.firstResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }
    const pages = result.pages ?? [];
    console.log(
      `[settle-flow] ✓ region=${region} pages=${pages.length} lines=${result.lineCount}`,
      { diag: result.diag, sampleLine: pages[0]?.result?.dataList?.[0] ?? null },
    );
    return {
      region, pages,
      lineCount: result.lineCount ?? 0,
      window: { orderCreateTimeStart, orderCreateTimeEnd },
      diag: result.diag,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// MAIN-world 注入:结算流水明细 pageNum 翻页。纯函数,不引外部变量。
// anti-content 策略同 logistics-bill:先裸发,403/40001 升级 window.rose 显式签,
// 429/20002 退避重试。diag.signMode 记录最终生效模式。
async function runSettleFlowInTab(args) {
  const { listPath, orderCreateTimeStart, orderCreateTimeEnd, pageSize, maxPages, mallId } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let signMode = 'none';   // none | rose
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { 'content-type': 'application/json', 'mallid': String(mallId) };
      if (signMode === 'rose') {
        const ac = genAntiContent();
        if (ac) headers['anti-content'] = ac;
      }
      const resp = await fetch(listPath, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (resp.status === 403) {
        // 裸发被 WAF 拒 → 升级显式签再试
        if (signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP 403: ${txt.slice(0, 120)}`);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false) {
        const code = Number(data.errorCode);
        if (code === 40001 && signMode === 'none' && typeof window.rose === 'function') { signMode = 'rose'; continue; }
        if (code === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || '')) {
          await wait(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`errorCode=${data.errorCode}: ${String(data.errorMsg ?? '').slice(0, 120)}`);
      }
      return data;
    }
    throw new Error(`${listPath.slice(0, 50)}: 退避重试 6 次仍失败(限流/系统异常)`);
  };
  const diag = { pagesFetched: 0, linesCollected: 0, total: null, signMode };
  let firstResp = null;
  try {
    const pages = [];
    let lineCount = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const data = await post({ pageSize, pageNum, orderCreateTimeStart, orderCreateTimeEnd });
      if (!firstResp) firstResp = data;
      diag.pagesFetched++;
      if (diag.total == null) diag.total = data?.result?.total ?? null;
      const list = data?.result?.dataList ?? [];
      lineCount += list.length;
      pages.push(data);
      if (list.length < pageSize) break;
      await wait(300);   // 节流,71 页 ≈ 25s
    }
    diag.linesCollected = lineCount;
    diag.signMode = signMode;
    return { ok: true, pages, lineCount, diag };
  } catch (e) {
    diag.signMode = signMode;
    return { ok: false, error: String((e && e.message) || e), code: 'IN_PAGE_FETCH_FAILED', diag, firstResp };
  }
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
  { drIndex: 0, name: '卖家中心', origin: 'https://seller.kuajingmaihuo.com', pageUrl: 'https://seller.kuajingmaihuo.com/main', taskType: 19, region: 'kjmh' },
  { drIndex: 1, name: '全球',     origin: 'https://agentseller.temu.com',    pageUrl: 'https://agentseller.temu.com',    taskType: 31, region: 'global' },
  { drIndex: 2, name: '欧洲',     origin: 'https://agentseller-eu.temu.com', pageUrl: 'https://agentseller-eu.temu.com', taskType: 31, region: 'eu' },
  { drIndex: 3, name: '美国',     origin: 'https://agentseller-us.temu.com', pageUrl: 'https://agentseller-us.temu.com', taskType: 31, region: 'us' },
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
  //   1. 在 kjmh 上 create + poll + 下载 drIndex=0(卖家中心),并拿跨域票据
  //   2. kjmh exportRow 含 agentSellerExportParams + agentSellerExportSign(跨域票据)
  //   3. 对 drIndex 1/2/3:打开 agentseller-{region}.temu.com 域名页
  //      在 MAIN world 直接调用 download API → 找到 fileUrl 并下载 xlsx
  // payload.drIndex 指定单个结算区域时,仍先跑 kjmh 拿票据,但 result 只返回目标区域。
  const requestedDrIndex = payload.drIndex == null ? null : Number(payload.drIndex);
  if (requestedDrIndex != null && !SETTLEMENT_VARIANTS.some((v) => v.drIndex === requestedDrIndex)) {
    throw Object.assign(new Error(`invalid settlement drIndex=${payload.drIndex}`), { code: 'BAD_PAYLOAD' });
  }
  const kjmhVariant = SETTLEMENT_VARIANTS[0];
  const agentVariants = requestedDrIndex == null
    ? SETTLEMENT_VARIANTS.slice(1)
    : (requestedDrIndex === 0 ? [] : SETTLEMENT_VARIANTS.filter((v) => v.drIndex === requestedDrIndex));
  const includeKjmhResult = requestedDrIndex == null || requestedDrIndex === 0;
  const totalExpected = (includeKjmhResult ? 1 : 0) + agentVariants.length;

  console.log(`[Temu后台] settlement: ${requestedDrIndex == null ? 'all variants' : `drIndex=${requestedDrIndex}`} via kjmh ticket, mall=${mallIdToSend}`);

  const variants = [];
  let kjmhRow = null;

  // push 当前 variants 快照到 server,前端轮询能看见进度。失败静默(不阻塞主流程)
  const push = (extra = {}) => {
    if (!onProgress) return;
    onProgress({
      variants,
      okCount: variants.filter(v => v.ok).length,
      totalCount: totalExpected,
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
    if (includeKjmhResult) variants.push(entry);
    if (r.ok) {
      console.log(`[Temu后台] settlement[卖家中心]: ✓ ok bytes=${r.fileBytes} polls=${r.polls}`);
      console.log(`[Temu后台] settlement[卖家中心]: kjmh row keys=${entry.exportRowKeys?.join(',')}`);
    } else {
      console.warn(`[Temu后台] settlement[卖家中心]: ✗ phase=${r.phase} code=${r.code} error=${String(r.error ?? '').slice(0, 250)}`);
    }
  } catch (e) {
    const entry = {
      drIndex: 0, name: '卖家中心', region: kjmhVariant.region, taskType: kjmhVariant.taskType,
      ok: false, code: e?.code ?? 'VARIANT_FAILED', error: String(e?.message ?? e),
    };
    if (includeKjmhResult) variants.push(entry);
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
    const tab = await chrome.tabs.create({ url: variant.pageUrl, active: false, pinned: false });
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
      const loginResult = await attemptAutoLogin(tabId, signal, String(mallId ?? ''));
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

// ── agentseller-{region} 跨域 download ──────────────────────────────
// 不再打开 /labor/bill-download-with-detail 落地页;只打开对应域名页,再在 MAIN
// world 直接调用 /api/merchant/file/export/download 下载 xlsx。
async function runAgentsellerVariantDiag(variant, { params, sign, mallId }, signal) {
  const TAB_LOAD_TIMEOUT_MS = 30_000;

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
    const tab = await chrome.tabs.create({ url: variant.pageUrl, active: false, pinned: false });
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
      console.log(`[Temu后台] diag[${variant.name}]: login redirect (${t.url.slice(0,120)}) → 尝试自动登陆`);
      const loginResult = await attemptAutoLogin(tabId, signal, String(mallId ?? ''));
      console.log(`[Temu后台] auto-login result: ok=${loginResult.ok} actions=${JSON.stringify(loginResult.actions)}`);
      if (!loginResult.ok) {
        await updateLoginHealth(variant.region, 'expired', `auto-login failed: ${loginResult.reason}`);
        return { ok: false, phase: 'login', code: 'LOGIN_REQUIRED', error: `${variant.region} auto-login ${loginResult.reason}` };
      }
      await chrome.tabs.update(tabId, { url: variant.pageUrl });
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
      func: downloadAgentsellerXlsxFromTicket,
      args: [{ params, sign, mallId: String(mallId ?? '') }],
    });
    const SCRIPT_TIMEOUT_MS_INNER = 6 * 60_000;
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

// MAIN world:用 kjmh row 的 agentSellerExportParams/Sign 在 agentseller 域直接换 fileUrl。
// 必须是纯函数(executeScript 序列化)
function downloadAgentsellerXlsxFromTicket(args) {
  return (async () => {
    const { params, sign, mallId } = args;
    const attempts = [];
    const decodeParams = () => {
      const vals = [params];
      try { vals.push(decodeURIComponent(params)); } catch {}
      for (const v of vals) {
        if (!v) continue;
        try {
          if (String(v).trim().startsWith('{')) return JSON.parse(v);
        } catch {}
        try {
          return JSON.parse(atob(v));
        } catch {}
      }
      return null;
    };
    const decoded = decodeParams();
    const genAntiContent = () => {
      try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
    };
    const trim = (v, n = 500) => String(v ?? '').slice(0, n);
    const tryDownload = async (body, label) => {
      const headers = {
        'content-type': 'application/json',
        'mallid': String(mallId),
      };
      const ac = genAntiContent();
      if (ac) headers['anti-content'] = ac;
      if (sign) {
        headers.sign = String(sign);
        headers['x-sign'] = String(sign);
      }
      const resp = await fetch('/api/merchant/file/export/download', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      attempts.push({ label, status: resp.status, bodyKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [], resp: trim(text) });
      if (!resp.ok) return null;
      return json?.result?.fileUrl || json?.fileUrl || null;
    };

    try {
      const bodies = [];
      if (decoded && typeof decoded === 'object') {
        bodies.push({ label: 'decoded+sign', body: { ...decoded, sign } });
        bodies.push({ label: 'decoded', body: decoded });
        if (decoded.id != null || decoded.taskType != null) {
          bodies.push({ label: 'id-taskType+sign', body: { id: decoded.id, taskType: decoded.taskType, sign } });
          bodies.push({ label: 'id-taskType', body: { id: decoded.id, taskType: decoded.taskType } });
        }
      }
      bodies.push({ label: 'params-sign', body: { params, sign } });
      bodies.push({ label: 'agentSeller-fields', body: { agentSellerExportParams: params, agentSellerExportSign: sign } });
      bodies.push({ label: 'export-fields', body: { exportParams: params, exportSign: sign } });

      let fileUrl = null;
      for (const candidate of bodies) {
        fileUrl = await tryDownload(candidate.body, candidate.label);
        if (fileUrl) break;
      }
      if (!fileUrl) {
        return { ok: false, phase: 'download', code: 'DOWNLOAD_NO_URL', error: 'agentseller download did not return fileUrl', attempts };
      }

      const blobResp = await fetch(fileUrl, { method: 'GET', credentials: 'include' });
      if (!blobResp.ok) {
        return { ok: false, phase: 'blob', code: 'BLOB_FAILED', error: `HTTP ${blobResp.status}`, attempts };
      }
      const contentType = blobResp.headers.get('content-type') || '';
      const buf = await blobResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isXlsx = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
      if (!isXlsx) {
        const preview = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(200, bytes.length)));
        return { ok: false, phase: 'blob', code: 'NOT_XLSX', error: `non-xlsx (ct=${contentType}, bytes=${bytes.length}): ${preview.slice(0, 150)}`, attempts };
      }
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const filenameMatch = fileUrl.match(/\/([^/?]+\.xlsx)/);
      const filename = filenameMatch ? filenameMatch[1] : `agentseller-${Date.now()}.xlsx`;
      return { ok: true, xlsxBase64: btoa(binary), filename, fileBytes: buf.byteLength, fileUrl, attempts };
    } catch (e) {
      return { ok: false, phase: 'unexpected', code: 'UNEXPECTED', error: String(e?.message ?? e), attempts };
    }
  })();
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
      // ★ 归属校验(2026-06-11,T-SettleMall 真因):export history 是 kjmh **账号级**
      //   (一份历史含账号下所有店的导出),row 顶层无 mallId,但 agentSellerExportParams
      //   解码后有 mallId。不校验归属 → 按日期复用别店旧导出 → 下成别店数据(半托撞全托)。
      //   解不出 mallId 一律不复用(保守:宁可重新 create 也不复用归属不明的 row)。
      const rowMallId = (row) => {
        try { return String(JSON.parse(atob(row.agentSellerExportParams)).mallId ?? ''); } catch { return ''; }
      };
      const mallMatches = (row) => { const m = rowMallId(row); return m !== '' && m === String(mallId); };
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
        // ★ 2026-06-11(T-SettleMall 真因):禁用历史复用 —— export history 是账号级,
        //   一条旧 row 的 agentSellerExportParams 可能指向别店/账号级旧导出,顶层无 mallId、
        //   params.mallId 标签也不可信(实测复用拿到全托数据)。用户实证:只有重新点导出
        //   (走 create)才生成当前店纯净报表。结算低频,强制 create,绝不复用历史。
        exportRow = null;
        const sameDate = existing.filter(r => r?.status === 2 && matchesRangeStrict(r, endTime));
        if (sameDate.length) console.log(`[runSettlementInTab] history 有 ${sameDate.length} 条同期 ready row(不复用,强制 create;mallId 标签=${sameDate.map(rowMallId).join(',')})`);
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

      // ★ 2026-06-11:4 次微调 endTime 都被服务端 dedup → 不再复用历史 row(账号级,会污染),
      //   直接 fail。结算同范围 30min 内已导过,过会儿重试 / 改日期 / 手动导出后重采。
      if (dupCreate) {
        return {
          ok: false, phase: 'create', code: 'EXPORT_DUP_GIVEUP',
          error: `同范围 30min 内已导出过(服务端 dedup),不复用历史(防账号级/别店污染)。30min 后重试 / 改日期范围 / 在 Temu UI 手动导出后再采`,
          step1Diag,
        };
      }
      if (!exportRow) {
        const polls = dupCreate ? Math.min(6, maxPolls) : maxPolls;
        for (let i = 0; i < polls; i++) {
          await sleepMs(pollIntervalMs);
          pollCount++;
          try {
            const all = await fetchAllHistoryPages();
            const candidates = dupCreate
              ? all.filter(r => matchesRange(r) && mallMatches(r))
              : all.filter(r => r?.createTime > beforeMaxCreate && matchesRange(r) && mallMatches(r));
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
// 2026-06-13 gen-3 注入式重写(原 gen-1 dispatchViaHiddenTab 等页面被动触发 →
//   非活跃 mall 的隐藏页不发 searchForXxxSupplier → capture-timeout)。
// gen-3:开 agentseller 账号页(window.rose 在)→ 注入 MAIN-world runPriceReviewInTab →
//   每请求 window.rose 现签 anti-content + 显式 mallid header(指任务目标 mall)。
//   anti-content 是账号/会话级(submit 已验证可跨 mall 复用),所以注入"当前活跃 mall 的页"
//   也能抓"同账号另一个子店"(全/半托)→ 一个登录态采全账号子店,不再依赖目标 mall 是活跃登录。
//   raw products 原样回传,后端 parsePriceReviewRows 解析(薄插件)。
async function dispatchDeclaredPrice(task, signal) {
  const payload = task.payload ?? {};
  if (!payload.mallId) {
    throw Object.assign(
      new Error(`payload.mallId missing for scrape:declared-price (got ${JSON.stringify(payload)})`),
      { code: 'BAD_PAYLOAD' },
    );
  }
  const semi = isSemiPayload(payload);
  const apiPath = semi
    ? '/api/kiana/mms/robin/searchForSemiSupplier'
    : '/api/kiana/mms/robin/searchForChainSupplier';
  const pageUrl = 'https://agentseller.temu.com/newon/product-select';

  const TAB_LOAD_TIMEOUT_MS = 30_000;
  const SCRIPT_TIMEOUT_MS = 5 * 60_000;
  let tabId = null;
  const cleanup = async () => { if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} tabId = null; } };

  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false, pinned: false });
    tabId = tab.id;
    console.log(`[declared-price] tab ${tabId} → ${pageUrl} (mall=${payload.mallId} ${semi ? 'semi' : 'full'})`);
    await waitTabComplete(tabId, signal, TAB_LOAD_TIMEOUT_MS);

    const t = await chrome.tabs.get(tabId);
    if (t?.url && isLoginFlowUrl(t.url)) {
      throw Object.assign(new Error('agentseller 跳登录,需登录该平台账号'), { code: 'LOGIN_REQUIRED' });
    }
    await sleep(2000, signal);   // 等页面 WAF SDK(window.rose)就绪

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runPriceReviewInTab,
      args: [{
        apiPath,
        mallId: String(payload.mallId),
        pageSize: 50,
        maxPages: Math.min(Number(payload.maxPages) || 20, 100),
      }],
    });
    console.log(`[declared-price] 注入页面抓取 ${apiPath} ...`);
    const result = await Promise.race([
      scriptPromise.then(([r]) => r?.result),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })), SCRIPT_TIMEOUT_MS)),
    ]);

    if (!result) throw Object.assign(new Error('executeScript 无返回'), { code: 'NO_RESULT' });
    if (!result.ok) {
      console.error('[declared-price] ✗ 页面内 fetch 失败', { error: result.error, code: result.code, diag: result.diag, firstListResp: result.firstListResp });
      throw Object.assign(new Error(`页面内 fetch 失败: ${result.error}`), { code: result.code ?? 'TEMU_FETCH_FAILED' });
    }

    console.log(
      `[declared-price] ✓ mall=${payload.mallId} products=${result.rows.length}(raw 回传,后端解析)`,
      { diag: result.diag, sampleProduct: result.rows[0] ?? null },
    );
    return {
      rows: result.rows,
      rawCount: result.rows.length,
      completedAt: new Date().toISOString(),
      agent: agentDiag(),
    };
  } finally {
    await cleanup();
  }
}

// ── MAIN-world 注入函数:核价单列表分页(window.rose 现签 + mallid override)──────────
// 纯函数(executeScript 序列化),不能引用外部变量/import。同源相对路径 fetch。
async function runPriceReviewInTab(args) {
  const { apiPath, mallId, pageSize, maxPages } = args;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const genAntiContent = () => {
    try { return new (window.rose(4))({ serverTime: Date.now() }).messagePack(); } catch (e) { return ''; }
  };
  const post = async (body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(apiPath, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'mallid': String(mallId), 'anti-content': genAntiContent() },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After')) || 0;
        await wait(ra ? ra * 1000 : 2000 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data && data.success === false && (data.errorCode === 20002 || /系统异常|请稍后|刷新重试/.test(data.errorMsg || ''))) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      return data;
    }
    throw new Error('退避重试 6 次仍失败(限流/系统异常)');
  };
  const diag = { pagesFetched: 0, total: null, productsCollected: 0 };
  let firstListResp = null;
  try {
    const rows = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await post({ removeStatus: 0, supplierTodoTypeList: [1], pageNum: p, pageSize });
      if (!firstListResp) firstListResp = data;
      diag.pagesFetched++;
      const list = (data && data.result && data.result.dataList) || [];
      diag.total = (data && data.result && data.result.total != null) ? data.result.total : diag.total;
      for (const it of list) rows.push(it);
      diag.productsCollected = rows.length;
      if (list.length < pageSize) break;
      if (diag.total != null && rows.length >= diag.total) break;
    }
    return { ok: true, rows, diag, firstListResp };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: e && e.code, diag, firstListResp };
  }
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

    // ★ 跨账号污染防御 + 同账号多 mall 放行(全托/半托属同一 Temu 账号,共享 session):
    //   - chrome 活跃 mall ≠ 任务 mall,但任务 mall 在账号授权列表里(accountOwnsMall)
    //     → 同账号另一个 mall,合法。captured session 是账号级,覆盖 mallid header 即可服务它。
    //   - 任务 mall 不在账号列表 → 真跨账号,fail-fast 避免把 A 账号数据写进 B 店。
    //   (账号 mall 列表来自 userInfo companyList[].malInfoList[],auto-login 时填 _userIdCache)
    const capturedMall = session.mallId ?? extractMallIdFromHeaders(session.headers);
    if (capturedMall && String(capturedMall) !== String(mallId)) {
      if (accountOwnsMall(mallId)) {
        console.log(`三、同账号多 mall:chrome 活跃=${capturedMall},任务=${mallId}(账号列表含之)→ 覆盖 mallid header`);
        session.headers = overrideMallidHeader(session.headers, mallId);
        session.mallId = String(mallId);
      } else {
        await invalidateSession(mallId);
        throw Object.assign(
          new Error(`MALL_MISMATCH: task expects mallId=${mallId} but chrome is logged in as ${capturedMall} (account malls=[${(_userIdCache.mallIdList || []).join(',')}])`),
          { code: 'MALL_MISMATCH', expectedMallId: mallId, capturedMallId: capturedMall },
        );
      }
    }

    // 校验通过才写缓存(只在 fresh capture 时;HIT 路径不重复写)。
    // 注:多 mall 覆盖后 session.headers/mallId 已是任务 mall → 缓存 key=任务 mall,干净。
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
    const tab = await chrome.tabs.create({ url: resolvedPageUrl, active: false, pinned: false });
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
        const loginResult = await attemptAutoLogin(tabId, signal, String(payload?.mallId ?? ''));
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
  // spec 字段支持「函数(payload)→值」或静态值,容纳全/半托差异
  const resolve = (v) => (typeof v === 'function' ? v(payload) : v);
  const mode = resolve(spec.paginationMode) ?? 'pageNo';
  const pageSize  = resolve(spec.pageSize) ?? 50;
  const listPath  = resolve(spec.listPath);
  const totalPath = resolve(spec.totalPath);
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
      const pNoKey = resolve(spec.pageNoKey) ?? 'pageNo';
      const pSizeKey = resolve(spec.pageSizeKey) ?? 'pageSize';
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
      // 404/410/405 大概率是 endpoint 写错(半托猜的 URL 不对 / method 不对)→ 标 mismatch
      const mismatch = (resp.status === 404 || resp.status === 410 || resp.status === 405);
      throw Object.assign(
        new Error(`TEMU_FETCH_FAILED: HTTP ${resp.status}: ${txt.slice(0, 300)}`),
        { code: 'TEMU_FETCH_FAILED', mismatch },
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

    // API 层 success:false + 已知 mismatch 错误码 → 早退
    if (data?.success === false) {
      const mismatch = MISMATCH_CODES.has(data?.errorCode);
      throw Object.assign(
        new Error(`API_FAILED: errorCode=${data?.errorCode} errorMsg=${data?.errorMsg}`),
        { code: 'API_FAILED', mismatch },
      );
    }

    const list = getPath(data, listPath);
    if (!Array.isArray(list)) {
      throw Object.assign(
        new Error(`SHAPE_BAD: listPath '${listPath}' not array; keys: ${Object.keys(data || {}).join(',')}`),
        { code: 'SHAPE_BAD' },
      );
    }
    collected.push(...list);

    // ★ 详显获取的 JSON — Sellfox 风格:第 N 页 listLen=X total=Y,对象引用直接展开
    const pageLabel = mode === 'scroll'
      ? `游标第 ${iter + 1} 页`
      : `第 ${pageNo} 页`;
    try {
      const totalSuffix = totalPath ? ` total=${getPath(data, totalPath) ?? '?'}` : '';
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
      if (totalPath) {
        const total = Number(getPath(data, totalPath) ?? list.length);
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
// ⚠️ 失败必须抛出(不能吞):否则成功路径上报失败(如 raw payload 撞 VPS nginx
// client_max_body_size 返 413)会被静默,任务被当 success → 面板误显成功但数据没进后端。
// 抛出后 executeTask 的 catch 会改报 failed(小 payload,不会 413),面板/后端如实显失败。
async function reportResult(taskId, pluginInstanceId, payload) {
  await api(`/api/agent/tasks/${taskId}/result`, {
    method: 'POST',
    body: JSON.stringify({ pluginInstanceId, ...payload }),
  });
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

// ── ESM export for jest tests (无害,SW 环境不影响)─────────
export { KIND_TO_FETCH_SPEC };
