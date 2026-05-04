import { getShopByMallId, getSkuCost, supabaseUpsert } from './supabase.js';
import { transformListResponse } from './transform/list_transform.js';
import { parseSalesResponse, parseOrdersResponse, buildSkuRows } from './transform/sku_transform.js';
import { transformPromoResponse } from './transform/promo_transform.js';

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
    return `${base}/main/data-center/goods-data?mallId=${mallId}`;
  }
  if (module === 'orders') {
    return `${US_BASE}/mmsos/orders.html?mallId=${mallId}`;
  }
  if (module === 'promo') {
    return `${base}/main/ads-management/ads-report?mallId=${mallId}`;
  }
  return null;
}

// ── Collection state ────────────────────────────────────────────────────────

let _state = {
  active: false,
  tabId: null,
  modules: [],
  region: 'us',
  date: null,
  mallId: null,
  shopName: '',
  siteType: 'semi_us',
  captured: {},
  supabaseUrl: null,
  supabaseAnonKey: null,
};

let _captureTimer = null;

function resetState() {
  if (_captureTimer) clearTimeout(_captureTimer);
  _captureTimer = null;
  _state.active = false;
  _state.modules = [];
  _state.captured = {};
}

// ── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    console.error('[temu] Supabase not configured');
    return;
  }
  const shop = await getShopByMallId(supabaseUrl, supabaseAnonKey, msg.mallId);

  _state = {
    active: true,
    tabId,
    modules: [...msg.modules],
    region: msg.region,
    date: msg.date,
    mallId: msg.mallId,
    shopName: shop?.shop_name ?? `mall${msg.mallId}`,
    siteType: shop?.site_type ?? 'semi_us',
    captured: {},
    supabaseUrl,
    supabaseAnonKey,
  };

  navigateToNextModule();
}

async function handleApiData(msg) {
  if (!_state.active) return;
  const expected = _state.modules[0];
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
  } else {
    resetState();
    console.log('[temu] Collection complete');
  }
}

function navigateToNextModule() {
  const mod = _state.modules[0];
  if (!mod) return;

  const url = moduleUrl(mod, _state.mallId, _state.siteType, _state.region);
  if (!url) {
    _state.modules.shift();
    navigateToNextModule();
    return;
  }

  chrome.tabs.update(_state.tabId, { url }, () => {
    const listener = (tabId, changeInfo) => {
      if (tabId !== _state.tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);

      chrome.tabs.sendMessage(_state.tabId, {
        type: 'ACTIVATE_CAPTURE',
        module: mod,
        targetDate: _state.date,
      });

      _captureTimer = setTimeout(async () => {
        console.warn(`[temu] timeout waiting for ${mod}`);
        await sendStatusToTab(mod, 'error');
        _state.modules.shift();
        navigateToNextModule();
      }, 60_000);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
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
    const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(rawData);
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

  if (module === 'promo') {
    const rows = transformPromoResponse(rawData, ctx);
    const { error } = await supabaseUpsert(supabaseUrl, supabaseAnonKey, 'ad_spend_daily', rows);
    if (error) throw new Error(error);
  }
}

async function sendStatusToTab(module, status) {
  try {
    await chrome.tabs.sendMessage(_state.tabId, { type: 'UPDATE_PANEL_STATUS', module, status });
  } catch {}
}
