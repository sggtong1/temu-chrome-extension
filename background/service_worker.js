import { getShopByMallId, getSkuCost, supabaseUpsert } from './supabase.js';
import { transformListResponse } from './transform/list_transform.js';
import { parseSalesResponse, parseOrdersResponse, buildSkuRows } from './transform/sku_transform.js';
import { transformPromoResponse } from './transform/promo_transform.js';
import { transformActivityResponse } from './transform/activity_transform.js';

// ── Dev-mode auto-reload ────────────────────────────────────────────────────
// Polls dev-reload.json (written by dev-watch.mjs) and reloads the extension
// when the file changes. Only active when the file exists.
(function devWatch() {
  let _lastTs = 0;
  async function check() {
    try {
      const res = await fetch(chrome.runtime.getURL('dev-reload.json') + '?t=' + Date.now());
      if (!res.ok) return;
      const { ts } = await res.json();
      if (_lastTs && ts > _lastTs) { chrome.runtime.reload(); return; }
      _lastTs = ts;
    } catch {}
  }
  setInterval(check, 1500);
})();

// ── Page URLs per module ────────────────────────────────────────────────────

function moduleUrl(module, mallId, siteType, region) {
  const US_BASE = 'https://agentseller-us.temu.com';
  const EU_BASE = 'https://agentseller-eu.temu.com';
  const DEF_BASE = 'https://agentseller.temu.com';

  const base = region === 'us' ? US_BASE : region === 'eu' ? EU_BASE : DEF_BASE;

  if (module === 'list') {
    const path = siteType === 'semi_us' ? 'flux-analysis' : 'flux-analysis-full';
    return `${base}/main/${path}?init=true&mallId=${mallId}`;
  }
  if (module === 'sales') {
    if (siteType === 'semi_us') {
      return `${US_BASE}/main/data-center/goods-data?mallId=${mallId}&init=true`;
    }
    return `${DEF_BASE}/stock/fully-mgt/sale-manage/main?mallId=${mallId}&init=true`;
  }
  if (module === 'orders') {
    return `${US_BASE}/mmsos/orders.html?mallId=${mallId}`;
  }
  if (module === 'activity') {
    // activity is full_managed only; content script fetches the API directly after load
    const uid = shopFromCache(mallId)?.uniqueId ?? '';
    return `https://agentseller.temu.com/activity/marketing-activity/log?mallId=${mallId}&uId=${uid}`;
  }
  if (module === 'promo') {
    // Ad report page lives on a separate subdomain (ads.temu.com), not the
    // seller-center base. mallId can still be appended for context.
    return `https://ads.temu.com/data-report.html?mallId=${mallId}`;
  }
  return null;
}

// ── Mall info cache (populated from userInfo API intercept) ─────────────────
// mallId (string) → { mallName, siteType, uniqueId }
// managedType: 0 = full_managed, 1 = semi_us
const _mallCache = {};

function handleUserInfo(data) {
  const malls = data?.result?.mallList ?? [];
  for (const mall of malls) {
    _mallCache[String(mall.mallId)] = {
      mallName: mall.mallName ?? '',
      siteType: mall.managedType === 0 ? 'full_managed' : 'semi_us',
      uniqueId: mall.uniqueId ?? '',
    };
  }
}

function shopFromCache(mallId) {
  return _mallCache[String(mallId)] ?? null;
}

// ── Collection state ────────────────────────────────────────────────────────

let _state = {
  active: false,
  originTabId: null,      // panel tab — receives status updates
  collectionTabId: null,  // background tab we navigate for collection
  originalModules: [],   // modules chosen by user, reset each date
  modules: [],           // remaining modules for current date
  dates: [],             // all dates in the requested range
  dateIndex: 0,          // which date we're currently processing
  date: null,            // current date string (dates[dateIndex])
  region: 'us',
  mallId: null,
  shopName: '',
  siteType: 'semi_us',
  captured: {},
  supabaseUrl: null,
  supabaseAnonKey: null,
};

let _captureTimer = null;
let _retryCount   = 0;
let _retryTimer   = null;

function resetState() {
  if (_captureTimer) clearTimeout(_captureTimer);
  if (_retryTimer)   clearTimeout(_retryTimer);
  _captureTimer = null;
  _retryTimer   = null;
  _retryCount   = 0;
  _state.active = false;
  _state.modules = [];
  _state.dates = [];
  _state.captured = {};
}

function generateDateRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate);
  const last = new Date(endDate ?? startDate);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PAGE_ERROR') {
    if (_state.active && _state.modules[0] === msg.module) handlePageError();
    return false;
  }
  if (msg.type === 'USER_INFO') {
    handleUserInfo(msg.data);
    return false;
  }
  if (msg.type === 'GET_SHOP_INFO') {
    handleGetShopInfo(msg.mallId).then(sendResponse);
    return true;
  }
  if (msg.type === 'START_COLLECTION') {
    handleStartCollection(msg, sender.tab?.id).then(sendResponse);
    return true;
  }
  if (msg.type === 'API_DATA') {
    handleApiData(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'PAGINATION_PROGRESS') {
    handlePaginationProgress(msg);
    return false;
  }
  if (msg.type === 'EXPORT_REPORT') {
    handleExportReport(msg).then(sendResponse);
    return true;
  }
});

async function handleExportReport({ startDate, endDate, shopName }) {
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);
  if (!supabaseUrl || !supabaseAnonKey) return { error: 'no-supabase' };
  if (!startDate || !endDate || !shopName) return { error: 'invalid-params' };

  // Build query manually (Chinese column names need URL-encoding both as keys and values)
  const enc = encodeURIComponent;
  const qs = [
    `${enc('日期')}=gte.${startDate}`,
    `${enc('日期')}=lte.${endDate}`,
    `${enc('店铺名称')}=eq.${enc(shopName)}`,
    `order=${enc('日期')}.desc,${enc('销售件数')}.desc.nullslast`,
  ].join('&');

  console.log(`[temu] EXPORT_REPORT: ${shopName} ${startDate}..${endDate}`);
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/sku_daily_with_activity?${qs}`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        // PostgREST default limit is 1000; raise it via Range header
        Range: '0-49999',
        'Range-Unit': 'items',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const rows = await resp.json();
    console.log(`[temu] EXPORT_REPORT: fetched ${rows.length} rows`);
    return { rows };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// Show/hide panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
});

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleGetShopInfo(mallId) {
  // Fast path: userInfo cache (populated on page load, no network request)
  const cached = shopFromCache(mallId);
  if (cached) return { shop_name: cached.mallName, site_type: cached.siteType };

  // Fallback: Supabase shops table
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);
  if (!supabaseUrl || !supabaseAnonKey) return null;
  try {
    return await getShopByMallId(supabaseUrl, supabaseAnonKey, mallId);
  } catch {
    return null;
  }
}

async function handleStartCollection(msg, tabId) {
  console.log('[temu] START_COLLECTION received', { mallId: msg.mallId, modules: msg.modules, siteType: msg.siteType, region: msg.region });
  if (_state.active) {
    console.warn('[temu] START_COLLECTION ignored — collection already active (possible duplicate message)');
    return;
  }
  try {
    const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);
    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('[temu] missing Supabase config — aborting');
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PANEL_STATUS', module: null, status: 'error-no-supabase' });
      } catch {}
      return;
    }

    // Resolve siteType: msg from panel > userInfo cache > Supabase shops table > 'semi_us'
    const cached = shopFromCache(msg.mallId);
    let shopName = cached?.mallName;
    let siteType = msg.siteType || cached?.siteType;

    if (!siteType) {
      console.log('[temu] siteType not in msg/cache, querying Supabase shops table');
      try {
        const shop = await getShopByMallId(supabaseUrl, supabaseAnonKey, msg.mallId);
        shopName = shopName ?? shop?.shop_name;
        siteType = shop?.site_type ?? 'semi_us';
      } catch (e) {
        console.warn('[temu] getShopByMallId failed, defaulting to semi_us:', e);
        siteType = 'semi_us';
      }
    }
    console.log('[temu] resolved siteType=', siteType, 'shopName=', shopName);

    const dates = generateDateRange(msg.startDate ?? msg.date, msg.endDate ?? msg.startDate ?? msg.date);

    _state = {
      active: true,
      originTabId: tabId,
      collectionTabId: null,
      originalModules: [...msg.modules],
      modules: [...msg.modules],
      dates,
      dateIndex: 0,
      date: dates[0],
      region: msg.region,
      mallId: msg.mallId,
      shopName: shopName ?? `mall${msg.mallId}`,
      siteType,
      captured: {},
      supabaseUrl,
      supabaseAnonKey,
    };

    console.log('[temu] state initialized, calling navigateToNextModule');
    navigateToNextModule();
  } catch (e) {
    console.error('[temu] handleStartCollection failed:', e);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PANEL_STATUS', module: null, status: 'error' });
    } catch {}
  }
}

async function handleApiData(msg) {
  if (!_state.active) return;
  const expected = _state.modules[0];
  console.log(`[temu] API_DATA received: module=${msg.module}, expected=${expected}, listLen=${msg.data?.result?.list?.length ?? 'n/a'}`);
  if (msg.module !== expected) return;

  _state.captured[msg.module] = msg.data;
  if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }

  await sendStatusToTab(msg.module, 'processing');

  try {
    await processModule(msg.module, msg.data);
    await sendStatusToTab(msg.module, 'done');
  } catch (e) {
    console.error(`[temu] process ${msg.module} error:`, e);
    await sendStatusToTab(msg.module, 'error');
  }

  _state.modules.shift();
  if (_state.modules.length > 0) {
    navigateToNextModule();
  } else if (_state.originalModules.length === 0) {
    // All selected modules were range-only (e.g. sales/activity captured
    // the whole range in one shot). Skip per-date iteration → complete now.
    const collectionTabId = _state.collectionTabId;
    _state.collectionTabId = null;
    resetState();
    void collectionTabId;
    await sendStatusToTab(null, 'complete');
    console.log('[temu] Collection complete (range modules only)');
  } else {
    // There are per-date modules left — advance to next date if any
    _state.dateIndex++;
    if (_state.dateIndex < _state.dates.length) {
      _state.date = _state.dates[_state.dateIndex];
      _state.modules = [..._state.originalModules];
      _state.captured = {};
      await sendStatusToTab(null, 'next-date');
      navigateToNextModule();
    } else {
      const collectionTabId = _state.collectionTabId;
      _state.collectionTabId = null;
      resetState();
      void collectionTabId;
      await sendStatusToTab(null, 'complete');
      console.log('[temu] Collection complete');
    }
  }
}


async function navigateToNextModule() {
  const mod = _state.modules[0];
  if (!mod) {
    // No modules left for this date.
    // If originalModules is also empty (all range-modules done), complete immediately.
    if (!_state.originalModules.length) {
      const collectionTabId = _state.collectionTabId;
      _state.collectionTabId = null;
      resetState();
      void collectionTabId; // keep tab open for debugging
      await sendStatusToTab(null, 'complete');
      console.log('[temu] Collection complete');
    }
    return;
  }

  let url = moduleUrl(mod, _state.mallId, _state.siteType, _state.region);
  console.log(`[temu] navigateToNextModule mod=${mod}, siteType=${_state.siteType}, region=${_state.region}, url=${url}`);
  if (!url) {
    console.warn(`[temu] no URL for module=${mod} siteType=${_state.siteType} — skipping`);
    _state.modules.shift();
    navigateToNextModule();
    return;
  }
  if (mod === 'activity') {
    url += `&startDate=${_state.dates[0]}&endDate=${_state.dates[_state.dates.length - 1]}`;
  }

  // Encode capture config into URL query so fetch_hook.js can read it synchronously
  // at document_start — before page APIs fire and before ACTIVATE_CAPTURE arrives.
  // Keep hash fallback for compatibility.
  const hashCfg = {
    mod,
    date: _state.date,
    site: _state.siteType,
    startDate: _state.dates[0],
    endDate:   _state.dates[_state.dates.length - 1],
  };
  const boot = encodeURIComponent(JSON.stringify(hashCfg));
  url += (url.includes('?') ? '&' : '?') + '__tmu=' + boot;
  url += '#__tmu=' + boot;

  _retryCount = 0;
  // Use active=true to avoid Chrome's background tab throttling (which can stall
  // POST responses for >60s). User can switch back manually after collection.
  if (_state.collectionTabId === null) {
    console.log('[temu] creating collection tab:', url);
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error('[temu] tabs.create failed:', chrome.runtime.lastError.message);
        return;
      }
      console.log('[temu] collection tab created, id=', tab.id);
      _state.collectionTabId = tab.id;
      attachCaptureListener(mod);
    });
  } else {
    console.log('[temu] updating collection tab', _state.collectionTabId, 'to:', url);
    chrome.tabs.update(_state.collectionTabId, { url, active: true }, () => attachCaptureListener(mod));
  }
}

let _activeMod = null;

function rearmCaptureTimer(mod) {
  if (_captureTimer) clearTimeout(_captureTimer);
  // Sales/activity may paginate hundreds of pages; we rearm on each
  // PAGINATION_PROGRESS so the timer only fires when truly idle.
  const timeoutMs = (mod === 'sales' || mod === 'activity' || mod === 'promo') ? 300_000 : 60_000;
  _captureTimer = setTimeout(async () => {
    console.warn(`[temu] timeout waiting for ${mod} (${timeoutMs/1000}s)`);
    await sendStatusToTab(mod, 'error');
    _state.modules.shift();
    _retryCount = 0;
    if (_state.modules.length === 0) {
      _state.dateIndex++;
      if (_state.dateIndex < _state.dates.length) {
        _state.date = _state.dates[_state.dateIndex];
        _state.modules = [..._state.originalModules];
        _state.captured = {};
        await sendStatusToTab(null, 'next-date');
        navigateToNextModule();
      } else {
        const collectionTabId = _state.collectionTabId;
        _state.collectionTabId = null;
        resetState();
        void collectionTabId; // keep tab open for debugging
        await sendStatusToTab(null, 'complete');
      }
    } else {
      navigateToNextModule();
    }
  }, timeoutMs);
}

function handlePaginationProgress(msg) {
  if (!_state.active || _state.modules[0] !== msg.module) return;
  console.log(`[temu] pagination progress: ${msg.module} page=${msg.pageNo}, items=${msg.gotSoFar} — rearming timer`);
  rearmCaptureTimer(msg.module);
}

function attachCaptureListener(mod) {
  if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }
  _activeMod = mod;

  const listener = (tabId, changeInfo) => {
    if (tabId !== _state.collectionTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.tabs.sendMessage(_state.collectionTabId, {
      type: 'ACTIVATE_CAPTURE',
      module: mod,
      targetDate: _state.date,
      startDate: mod === 'activity' ? _state.dates[0] : _state.date,
      endDate:   mod === 'activity' ? _state.dates[_state.dates.length - 1] : _state.date,
      siteType: _state.siteType,
    });

    // Use rearmCaptureTimer — PAGINATION_PROGRESS messages will rearm the timer
    // so paginating hundreds of pages doesn't trip a stale-data timeout.
    rearmCaptureTimer(mod);
  };
  chrome.tabs.onUpdated.addListener(listener);
}

async function handlePageError() {
  if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }
  const mod = _state.modules[0];
  _retryCount++;

  if (_retryCount > 3) {
    console.warn(`[temu] max retries (3) reached for ${mod}, skipping`);
    _retryCount = 0;
    await sendStatusToTab(mod, 'error');
    _state.modules.shift();
    navigateToNextModule();
    return;
  }

  console.log(`[temu] page error for ${mod}, retry ${_retryCount}/3 in 5s`);
  await sendStatusToTab(mod, 'retrying');

  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    chrome.tabs.reload(_state.collectionTabId, () => attachCaptureListener(mod));
  }, 5000);
}

async function processModule(module, rawData) {
  const ctx = { shopName: _state.shopName, region: _state.region, date: _state.date, siteType: _state.siteType };
  const { supabaseUrl, supabaseAnonKey } = _state;

  if (module === 'list') {
    const rows = transformListResponse(rawData, ctx);
    const { error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'dashboard_metrics', rows);
    if (error) throw new Error(error);
  }

  if (module === 'sales' && _state.siteType === 'full_managed') {
    // querySkuSalesNumber returns up to ~30 days regardless of requested range,
    // so we capture ONCE and slice rows for every date in the user's range.
    const allRows = [];
    let totalSkus = 0;
    for (const date of _state.dates) {
      const dateCtx = { ...ctx, date };
      const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(rawData, dateCtx);
      const extCodes = [...new Set(Object.values(skuPrices).map(p => p.extCode).filter(Boolean))];
      const skuCostMap = await getSkuCost(supabaseUrl, supabaseAnonKey, extCodes, date, _state.siteType);
      const rows = buildSkuRows(dateCtx, { skuSales, skuPrices, skuSpuMap }, {}, skuCostMap);
      allRows.push(...rows);
      totalSkus = Math.max(totalSkus, Object.keys(skuSales).length);
    }
    console.log(`[temu] sales (full_managed): built ${allRows.length} rows for ${_state.dates.length} dates × ${totalSkus} SKUs`);
    if (allRows.length > 0) {
      console.log('[temu] sales: first row sample:', JSON.stringify(allRows[0]).slice(0, 500));
      const { count, error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'sku_daily_metrics', allRows);
      if (error) { console.error('[temu] sales upsert error:', error); throw new Error(error); }
      console.log(`[temu] sales: upsert OK, count=${count}`);
    }
    // Captured the full range in one shot — skip subsequent date iterations
    _state.originalModules = _state.originalModules.filter(m => m !== 'sales');
  } else if (module === 'sales') {
    // semi_us: per-date capture (existing behavior)
    const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(rawData, ctx);
    const extCodes = [...new Set(Object.values(skuPrices).map(p => p.extCode).filter(Boolean))];
    const skuCostMap = await getSkuCost(supabaseUrl, supabaseAnonKey, extCodes, _state.date, _state.siteType);
    const ordersRaw = _state.captured['orders'];
    const ordersShipping = ordersRaw ? parseOrdersResponse(ordersRaw) : {};
    const rows = buildSkuRows(ctx, { skuSales, skuPrices, skuSpuMap }, ordersShipping, skuCostMap);
    console.log(`[temu] sales (semi_us): built ${rows.length} rows for ${Object.keys(skuSales).length} SKUs`);
    if (rows.length > 0) {
      const { count, error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'sku_daily_metrics', rows);
      if (error) { console.error('[temu] sales upsert error:', error); throw new Error(error); }
      console.log(`[temu] sales: upsert OK, count=${count}`);
    }
  }

  if (module === 'orders') {
    // Raw data stored in _state.captured for SALES to use; no separate DB write
    console.log('[temu] orders captured, will merge into SALES processing');
  }

  if (module === 'activity') {
    const rows = transformActivityResponse(rawData, {
      shopName: _state.shopName,
      startDate: _state.dates[0],
      endDate: _state.dates[_state.dates.length - 1],
    });
    if (rows.length > 0) {
      const { count, error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'sku_activity_history', rows);
      if (error) { console.error('[temu] activity upsert error:', error); throw new Error(error); }
      console.log(`[temu] activity: upsert OK, count=${count}`);
    } else {
      console.log('[temu] activity: 0 rows generated (no activities overlap user range)');
    }
    // Full range captured in one shot — remove from subsequent dates
    _state.originalModules = _state.originalModules.filter(m => m !== 'activity');
  }

  if (module === 'promo') {
    const rows = transformPromoResponse(rawData, ctx);
    if (rows.length > 0) {
      const { count, error } = await supabaseUpsert(
        supabaseUrl, supabaseAnonKey, 'ad_spend_daily', rows,
        '日期,店铺名称,商品id,平台'  // unique constraint, not the bigint id PK
      );
      if (error) { console.error('[temu] promo upsert error:', error); throw new Error(error); }
      console.log(`[temu] promo: upsert OK, count=${count}`);
    } else {
      console.log('[temu] promo: 0 rows (no ads in range)');
    }
  }
}

async function sendStatusToTab(module, status) {
  try {
    await chrome.tabs.sendMessage(_state.originTabId, {
      type: 'UPDATE_PANEL_STATUS',
      module,
      status,
      date: _state.date,
      dateIndex: _state.dateIndex,
      totalDates: _state.dates.length,
    });
  } catch {}
}
