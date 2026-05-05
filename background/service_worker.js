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
    return `${base}/main/ads-management/ads-report?mallId=${mallId}`;
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
  salesPartials: {},
  salesPartialTimers: {},
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
  _state.salesPartials = {};
  _state.salesPartialTimers = {};
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
});

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
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);
  if (!supabaseUrl || !supabaseAnonKey) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PANEL_STATUS', module: null, status: 'error-no-supabase' });
    } catch {}
    return;
  }

  // Prefer userInfo cache for siteType (accurate, no extra request);
  // fall back to Supabase shops table if cache not yet populated
  const cached = shopFromCache(msg.mallId);
  let shopName = cached?.mallName;
  let siteType = cached?.siteType;

  if (!siteType) {
    const shop = await getShopByMallId(supabaseUrl, supabaseAnonKey, msg.mallId);
    shopName = shopName ?? shop?.shop_name;
    siteType = shop?.site_type ?? 'semi_us';
  }

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
    salesPartials: {},
    salesPartialTimers: {},
    supabaseUrl,
    supabaseAnonKey,
  };

  navigateToNextModule();
}

async function handleApiData(msg) {
  if (!_state.active) return;
  const expected = _state.modules[0];
  console.log(`[temu] API_DATA received: module=${msg.module}, expected=${expected}, listLen=${msg.data?.result?.list?.length ?? 'n/a'}`);
  if (msg.module !== expected) return;

  // full_managed SALES needs two API captures (listOverall + querySkuSalesNumber)
  if (msg.module === 'sales' && _state.siteType === 'full_managed' && msg.subType) {
    const key = `${_state.mallId}|${_state.date}|sales`;
    if (!_state.salesPartials[key]) _state.salesPartials[key] = { meta: null, qty: null };
    _state.salesPartials[key][msg.subType] = msg.data;

    if (_state.salesPartialTimers[key]) {
      clearTimeout(_state.salesPartialTimers[key]);
      _state.salesPartialTimers[key] = null;
    }

    const partial = _state.salesPartials[key];
    if (!partial.meta || !partial.qty) {
      _state.salesPartialTimers[key] = setTimeout(async () => {
        if (!_state.active || _state.modules[0] !== 'sales') return;
        const p = _state.salesPartials[key];
        if (!p || (!p.meta && !p.qty)) return;
        console.warn(`[temu] sales partial timeout, degrade write. key=${key}, meta=${!!p.meta}, qty=${!!p.qty}`);
        await finalizeSalesFromPartial(key, p);
      }, 10_000);
      return;
    }
    // Both captured — merge and fall through to processModule
    msg = { ...msg, subType: null, data: { meta: partial.meta, qty: partial.qty } };
    delete _state.salesPartials[key];
  }

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
  } else {
    // Current date done — advance to next date if any
    _state.dateIndex++;
    if (_state.dateIndex < _state.dates.length) {
      _state.date = _state.dates[_state.dateIndex];
      _state.modules = [..._state.originalModules];
      _state.captured = {};
      _state.salesPartials = {};
      _state.salesPartialTimers = {};
      await sendStatusToTab(null, 'next-date');
      navigateToNextModule();
    } else {
      const collectionTabId = _state.collectionTabId;
      _state.collectionTabId = null;
      resetState();
      if (collectionTabId) {
        try { chrome.tabs.remove(collectionTabId); } catch {}
      }
      await sendStatusToTab(null, 'complete');
      console.log('[temu] Collection complete');
    }
  }
}

async function finalizeSalesFromPartial(key, partial) {
  if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }
  delete _state.salesPartialTimers[key];
  delete _state.salesPartials[key];
  await sendStatusToTab('sales', 'processing');
  try {
    await processModule('sales', { meta: partial.meta ?? { result: [] }, qty: partial.qty ?? { result: [] } });
    await sendStatusToTab('sales', 'done');
  } catch (e) {
    console.error('[temu] process sales(partial) error:', e);
    await sendStatusToTab('sales', 'error');
  }
  _state.modules.shift();
  if (_state.modules.length > 0) {
    navigateToNextModule();
  } else {
    _state.dateIndex++;
    if (_state.dateIndex < _state.dates.length) {
      _state.date = _state.dates[_state.dateIndex];
      _state.modules = [..._state.originalModules];
      _state.captured = {};
      _state.salesPartials = {};
      _state.salesPartialTimers = {};
      await sendStatusToTab(null, 'next-date');
      navigateToNextModule();
    } else {
      const collectionTabId = _state.collectionTabId;
      _state.collectionTabId = null;
      resetState();
      if (collectionTabId) {
        try { chrome.tabs.remove(collectionTabId); } catch {}
      }
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
      if (collectionTabId) try { chrome.tabs.remove(collectionTabId); } catch {}
      await sendStatusToTab(null, 'complete');
      console.log('[temu] Collection complete');
    }
    return;
  }

  let url = moduleUrl(mod, _state.mallId, _state.siteType, _state.region);
  if (mod === 'activity') {
    url += `&startDate=${_state.dates[0]}&endDate=${_state.dates[_state.dates.length - 1]}`;
  }
  if (!url) {
    _state.modules.shift();
    navigateToNextModule();
    return;
  }

  // Encode capture config into URL hash so fetch_hook.js can read it synchronously
  // at document_start — before page APIs fire and before ACTIVATE_CAPTURE arrives.
  const hashCfg = {
    mod,
    date: _state.date,
    site: _state.siteType,
    startDate: _state.dates[0],
    endDate:   _state.dates[_state.dates.length - 1],
  };
  url += '#__tmu=' + encodeURIComponent(JSON.stringify(hashCfg));

  _retryCount = 0;
  if (_state.collectionTabId === null) {
    chrome.tabs.create({ url, active: false }, (tab) => {
      _state.collectionTabId = tab.id;
      attachCaptureListener(mod);
    });
  } else {
    chrome.tabs.update(_state.collectionTabId, { url }, () => attachCaptureListener(mod));
  }
}

function attachCaptureListener(mod) {
  if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }

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

    // 60s hard timeout — fallback if PAGE_ERROR detection also fails
    _captureTimer = setTimeout(async () => {
      console.warn(`[temu] timeout waiting for ${mod}`);
      await sendStatusToTab(mod, 'error');
      _state.modules.shift();
      _retryCount = 0;
      navigateToNextModule();
    }, 60_000);
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

  if (module === 'sales') {
    const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(rawData, ctx);
    // Cost lookup uses 货号 (extCode) directly — matches sku_cost.sku_id column
    const extCodes = [...new Set(Object.values(skuPrices).map(p => p.extCode).filter(Boolean))];
    const skuCostMap = await getSkuCost(supabaseUrl, supabaseAnonKey, extCodes, _state.date, _state.siteType);

    // Merge orders shipping if ORDERS was already captured in this session
    const ordersRaw = _state.captured['orders'];
    const ordersShipping = ordersRaw ? parseOrdersResponse(ordersRaw) : {};

    const rows = buildSkuRows(ctx, { skuSales, skuPrices, skuSpuMap }, ordersShipping, skuCostMap);
    const { error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'sku_daily_metrics', rows);
    if (error) throw new Error(error);
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
      const { error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'sku_activity_price', rows);
      if (error) throw new Error(error);
    }
    // Full range captured in one shot — remove from subsequent dates
    _state.originalModules = _state.originalModules.filter(m => m !== 'activity');
    console.log(`[temu] activity captured: ${rows.length} rows`);
  }

  if (module === 'promo') {
    const rows = transformPromoResponse(rawData, ctx);
    const { error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'ad_spend_daily', rows);
    if (error) throw new Error(error);
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
