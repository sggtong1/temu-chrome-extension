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

import { transformActivityResponse } from './transform/activity_transform.js';

const POLL_PERIOD_MIN  = 1 / 6;   // 10s
const HEARTBEAT_PERIOD = 60_000;  // 60s
const CLAIM_LIMIT      = 3;       // 每次最多领 3 个
const LEASE_SECONDS    = 300;     // 5min 租约
const ALARM_NAME       = 'agent-poll';

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
      errorMessage: String(e.message || e).slice(0, 1500),
    });
    console.error(`[agent] ✗ ${task.id.slice(0, 8)}:`, e.message);
  } finally {
    clearInterval(heartbeatTimer);
    _running.delete(task.id);
  }
}

// ── 每个 scrape:* kind 对应的 fetch + transform 配置 ─────────────
// 由 dispatchViaHiddenTab 在 hidden Temu tab 里 same-origin 发请求,
// 拿到 raw Temu rows → 用 transform 转成 SKU × 日期 的 task.result.rows[].
const KIND_TO_FETCH_SPEC = {
  'scrape:marketing-activity': {
    url: 'https://agentseller.temu.com/api/kiana/gamblers/marketing/enroll/list',
    method: 'POST',
    // buildBody 接收 task.payload,返回要 JSON.stringify 的 request body。
    // dispatch 在分页时会 override pageNo + pageSize。
    buildBody: (payload) => ({
      pageNo: 1,
      pageSize: 50,
      sessionStartTimeFrom: dateToEpochMs(payload.startDate, /* endOfDay */ false),
      sessionEndTimeTo:     dateToEpochMs(payload.endDate,   /* endOfDay */ true),
      sessionStatus: 2,
    }),
    // 响应里取 list 数组的 path; total 无显式字段,runFetchInTab 用 items.length < pageSize 判断
    listPath: 'list',
    totalPath: null,
    // raw rows → task.result.rows[] 的 transform
    // transformActivityResponse 期待 rawData.result.list (inspected from activity_transform.js:65)
    transform: (rawItems, payload) =>
      transformActivityResponse(
        { result: { list: rawItems } },
        {
          shopName: payload.shopName ?? `mall${payload.mallId}`,
          startDate: payload.startDate,
          endDate: payload.endDate,
        },
      ),
  },
  // 其他 6 个 scrape:* kind 由后续 plan 添加
};

// helper: 'YYYY-MM-DD' → epoch ms (local timezone 起算; Temu API 使用 PT 但全球 cookie 共享, 容差 ok)
function dateToEpochMs(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

// ── kind → 实际执行的派发表 ───────────────────────────────────────
// 现在每个 kind 都是 stub（模拟 2-5s 工作然后成功）。
// 下一步把每个 kind 接到 service_worker 现有的 transform / collection 流程上。
async function dispatch(task, signal) {
  switch (task.kind) {
    case 'scrape:activity-data':
    case 'scrape:settlement':
    case 'scrape:flux-analysis':
    case 'scrape:sales-30d':
    case 'scrape:declared-price':
    case 'scrape:marketing-activity':
    case 'scrape:promo': {
      // TODO[wire]: 接到现有 background/service_worker.js 里的 handleStartCollection
      // 暂时返回 stub 结果，让端到端环路先通
      await sleep(2000 + Math.random() * 3000, signal);
      return {
        stub: true,
        kind: task.kind,
        shopId: task.shop_id,
        payload: task.payload,
        completedAt: new Date().toISOString(),
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
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      pollOnce().catch((e) => console.error('[agent] poll err:', e));
    }
  });
  // Service worker 唤醒后立刻拉一次（不必等下个 alarm 周期）
  pollOnce().catch(() => {});
  console.log(`[agent] 已启动，每 ${POLL_PERIOD_MIN * 60}s 拉一次任务`);
}

// 让 popup 通过 message 强制立刻拉一次
export function attachMessageHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'AGENT_PULL_NOW') {
      pollOnce().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
}
