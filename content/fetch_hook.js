// Runs in MAIN world — can access window.fetch and window.XMLHttpRequest
// Communicates with ISOLATED world via CustomEvent

// Read config from URL synchronously at document_start, before any page scripts run.
// Service worker encodes {mod, date, site, startDate, endDate} into __tmu query param
// (and keeps hash fallback for older navigations).
function _readBootConfig() {
  try {
    const sp = new URLSearchParams(location.search);
    const q = sp.get('__tmu');
    if (q) return JSON.parse(decodeURIComponent(q));
    const m = location.hash.match(/__tmu=([^&\s]*)/);
    if (m?.[1]) return JSON.parse(decodeURIComponent(m[1]));
  } catch {}
  return null;
}
const _hashCfg = _readBootConfig();

// semi_us: list + orders + promo (no sales, no activity)
const PATTERNS_SEMI_US = {
  list:   '/api/flow/analysis/list',
  orders: '/mmsos/order/recentOrderList',
  promo:  '/bgn/pc/report/ad-report-detail/query',
};

// full_managed: list + sales + activity + promo (no orders)
// sales = listOverall only (single-API mode; fires on page load automatically)
const PATTERNS_FULL_MANAGED = {
  list:     '/api/seller/full/flow/analysis/goods/list',
  sales:    ['listOverall', '/sale-manage/list-overall'],
  activity: '/api/kiana/gamblers/marketing/enroll/list',
  promo:    '/bgn/pc/report/ad-report-detail/query',
};

let _siteType = _hashCfg?.site || 'semi_us';
let _activeModule = _hashCfg?.mod || null;
let _targetDate = _hashCfg?.date || null;

window.addEventListener('temu:setConfig', (e) => {
  _activeModule = e.detail.activeModule || null;
  _targetDate = e.detail.targetDate || null;
  _siteType = e.detail.siteType || 'semi_us';
});

// Returns { module, subType } or null
function matchModule(url) {
  const patterns = _siteType === 'full_managed' ? PATTERNS_FULL_MANAGED : PATTERNS_SEMI_US;
  for (const [key, pattern] of Object.entries(patterns)) {
    const matched = Array.isArray(pattern) ? pattern.some(p => url.includes(p)) : url.includes(pattern);
    if (matched) {
      return { module: key, subType: null };
    }
  }
  return null;
}

function maybeInjectDate(body, mod) {
  if (!['list', 'sales'].includes(mod)) return body;
  try {
    const parsed = JSON.parse(body);
    if (_targetDate) {
      if ('statDate' in parsed) parsed.statDate = _targetDate;
      if ('date' in parsed) parsed.date = _targetDate;
      if ('startDate' in parsed) parsed.startDate = _targetDate;
      if ('endDate' in parsed) parsed.endDate = _targetDate;
    }
    // For full_managed sales (listOverall): inject the page filter that user can
    // set manually as 选品状态=已加入站点. selectStatusList=[12] = added-to-site.
    // Page default has no filter, so listOverall returns offline/halted SKUs too.
    if (mod === 'sales') {
      parsed.selectStatusList = [12];
      if (!('isLack' in parsed)) parsed.isLack = 0;
    }
    const out = JSON.stringify(parsed);
    if (mod === 'sales' && out !== body) {
      console.log('[temu-hook] body injected for sales:', out.slice(0, 600));
    }
    return out;
  } catch (e) {
    console.warn('[temu-hook] maybeInjectDate parse failed:', e, 'body type=', typeof body);
    return body;
  }
}

// Always intercept userInfo to build mall-type cache in background
const USERINFO_PATTERN = '/api/seller/auth/userInfo';

function emit(module, subType, url, data) {
  window.dispatchEvent(new CustomEvent('temu:apiCapture', {
    detail: { module, subType, url, data },
  }));
}

function shouldCapture(match) {
  if (!match) return false;
  if (match.module === _activeModule) return true;
  // Pragmatic fallback: sales page sometimes fires before boot config is visible.
  // To prioritize "capture first", allow sales capture even when activeModule is null.
  if (_activeModule == null && match.module === 'sales') return true;
  return false;
}

// Generic pagination helper: fetches remaining pages reusing original headers.
// Don't trust result.total — for listOverall it appears to be an unrelated metric,
// not the product count. Instead keep fetching until an empty or short page.
async function fetchAllPages(originalUrl, originalInit, firstData, listKey) {
  const firstList = firstData?.result?.[listKey] ?? [];
  console.log(`[temu-hook] pagination ${listKey}: page1 size=${firstList.length}, total field=`,
    firstData?.result?.total, 'totalSkcNum=', firstData?.result?.totalSkcNum);

  let body = {};
  try { body = JSON.parse(originalInit.body ?? '{}'); } catch {}
  const pageSize = body.pageSize ?? 10;

  // Page 1 returned fewer than a full page → no more pages
  if (firstList.length < pageSize) {
    console.log(`[temu-hook] ${listKey}: only 1 page (got ${firstList.length}, pageSize=${pageSize})`);
    return firstData;
  }

  // Force POST. originalInit may lack method when the caller used fetch(Request)
  // — method lives on the Request object, not in init. listOverall/enroll-list
  // are always POST anyway, so coercing GET/HEAD avoids "method cannot have body".
  const rawMethod = (originalInit.method || 'POST').toUpperCase();
  const method = (rawMethod === 'GET' || rawMethod === 'HEAD') ? 'POST' : rawMethod;

  const allList = [...firstList];
  let pageNo = 2;
  const MAX_PAGES = 200;

  while (pageNo <= MAX_PAGES) {
    let page = [];
    try {
      const t0 = Date.now();
      const res  = await _originalFetch(originalUrl, { ...originalInit, method, body: JSON.stringify({ ...body, pageNo }) });
      const data = await res.json();
      page = data?.result?.[listKey] ?? [];
      console.log(`[temu-hook] page ${pageNo}: ${page.length} items, status=${res.status}, ${Date.now() - t0}ms, total=${allList.length + page.length}`);
      // Temu's errorCode=1000000 + success=true is the normal success response.
      // Only stop if the API explicitly says success=false, otherwise trust items.
      if (data?.success === false) {
        console.warn(`[temu-hook] page ${pageNo} success=false:`, data?.errorMsg, data?.errorCode);
        break;
      }
    } catch (e) {
      console.error(`[temu-hook] page ${pageNo} fetch failed:`, e);
      break;
    }
    if (page.length === 0) break;
    allList.push(...page);
    if (page.length < pageSize) { pageNo++; break; }   // last page reached
    pageNo++;
    // Notify content_script that pagination is still progressing so it can
    // ping the service_worker (avoids the 120s timeout firing mid-pagination).
    window.dispatchEvent(new CustomEvent('temu:paginationProgress', { detail: { module: 'sales', pageNo, gotSoFar: allList.length } }));
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[temu-hook] paginated ${listKey}: fetched=${allList.length}, pages=${pageNo - 1}`);
  return { ...firstData, result: { ...firstData.result, [listKey]: allList } };
}

// After listOverall pagination completes, actively query daily sales numbers
// for all collected SKUs by calling querySkuSalesNumber. This API is normally
// only invoked when user clicks 销售趋势 on a product row; we synthesize the
// call here using the same auth headers/cookies as the listOverall request.
async function enrichSalesWithDailyNumbers(originalUrl, originalInit, mergedData) {
  const subOrderList = mergedData?.result?.subOrderList ?? [];
  const skuIds = [];
  for (const product of subOrderList) {
    for (const sku of (product.skuQuantityDetailList ?? [])) {
      const id = sku.productSkuId;
      if (id != null) skuIds.push(id);
    }
  }
  if (skuIds.length === 0) {
    console.log('[temu-hook] no SKUs found, skipping querySkuSalesNumber');
    return mergedData;
  }

  const startDate = _hashCfg?.startDate || _hashCfg?.date;
  const endDate   = _hashCfg?.endDate   || _hashCfg?.date;
  if (!startDate || !endDate) {
    console.warn('[temu-hook] no date range in boot config, skipping querySkuSalesNumber');
    return mergedData;
  }

  const queryUrl = originalUrl.replace(/\/listOverall(\?.*)?$/, '/querySkuSalesNumber$1');
  console.log(`[temu-hook] calling querySkuSalesNumber for ${skuIds.length} SKUs, ${startDate}..${endDate}`);

  // Some installs may rate-limit a giant SKU array. Chunk in groups of 100.
  const CHUNK = 100;
  const allSalesItems = [];
  for (let i = 0; i < skuIds.length; i += CHUNK) {
    const chunk = skuIds.slice(i, i + CHUNK);
    const body = JSON.stringify({ productSkuIds: chunk, startDate, endDate });
    try {
      const t0 = Date.now();
      const res = await _originalFetch(queryUrl, {
        method: 'POST',
        headers: originalInit.headers || {},
        body,
        credentials: 'include',
      });
      const data = await res.json();
      console.log(`[temu-hook] querySkuSalesNumber chunk ${i/CHUNK + 1}: status=${res.status}, ${Date.now() - t0}ms, success=${data?.success}, result type=${Array.isArray(data?.result) ? 'array(' + data.result.length + ')' : typeof data?.result}`);
      if (i === 0) {
        // Log first chunk's raw result so we can confirm shape
        console.log('[temu-hook] querySkuSalesNumber sample:', JSON.stringify(data?.result).slice(0, 800));
      }
      const items = Array.isArray(data?.result) ? data.result
        : data?.result?.list ?? data?.result?.items ?? data?.result?.dataList ?? [];
      allSalesItems.push(...items);
    } catch (e) {
      console.warn(`[temu-hook] querySkuSalesNumber chunk ${i/CHUNK + 1} failed:`, e);
    }
    if (i + CHUNK < skuIds.length) await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[temu-hook] querySkuSalesNumber: collected ${allSalesItems.length} sales records`);
  return { ...mergedData, salesNumbers: allSalesItems };
}

function emitUserInfo(data) {
  window.dispatchEvent(new CustomEvent('temu:userInfo', { detail: data }));
}

// ── Diagnostic mode ─────────────────────────────────────────────────────────
// Set to true temporarily to log ALL /api/ calls (helps find correct patterns)
const _DIAG = true;

const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;

  // Diagnostic: log all /api/ POST calls so we can find the right patterns
  if (_DIAG && url.includes('/api/') && (init.method === 'POST' || init.method === 'post')) {
    console.log('[temu-diag] POST', url, '| activeModule=', _activeModule);
  }

  // Always-on: capture userInfo for mall-type detection
  if (url.includes(USERINFO_PATTERN)) {
    const response = await _originalFetch(input, init);
    response.clone().json().then(emitUserInfo).catch(() => {});
    return response;
  }

  const match = matchModule(url);
  // Diagnostic: log any activity or sales pattern hit regardless of activeModule
  if (match?.module === 'activity' || url.includes('enroll/list')) {
    console.log('[temu-hook] activity URL hit via fetch, activeModule=', _activeModule, 'match=', match?.module, url);
  }
  if (match?.module === 'sales' || url.includes('listOverall') || url.includes('querySkuSalesNumber')) {
    console.log('[temu-hook] sales URL hit via fetch, activeModule=', _activeModule, 'match=', match?.module, url);
  }
  if (shouldCapture(match)) {
    // Resolve body/method/headers, accounting for fetch(Request) calls where
    // these live on the Request object instead of init.
    const isRequestObj = typeof input !== 'string' && !(input instanceof URL);
    const reqMethod = (init.method || (isRequestObj ? input.method : 'POST') || 'POST').toUpperCase();

    let origBody = init.body;
    if (origBody === undefined && isRequestObj && reqMethod !== 'GET' && reqMethod !== 'HEAD') {
      try { origBody = await input.clone().text(); }
      catch (e) { console.warn('[temu-hook] reading Request body failed:', e); }
    }

    let reqHeaders = init.headers;
    if (!reqHeaders && isRequestObj && input.headers) {
      reqHeaders = {};
      input.headers.forEach((v, k) => { reqHeaders[k] = v; });
    }

    let injected = false;
    let bodyToSend = origBody;
    if (origBody && typeof origBody === 'string') {
      console.log('[temu-hook] capture', match.module, 'body=', origBody.slice(0, 600));
      bodyToSend = maybeInjectDate(origBody, match.module);
      injected = bodyToSend !== origBody;
    }

    // If we modified the body, must build a fresh init (mutating Request-derived
    // body in-place isn't possible). Otherwise use the original input/init verbatim.
    let response;
    if (injected) {
      response = await _originalFetch(url, {
        method: reqMethod, headers: reqHeaders || {}, body: bodyToSend, credentials: init.credentials || 'include',
      });
    } else {
      response = await _originalFetch(input, init);
    }

    // Pagination uses the resolved init (with the body we'd want for subsequent pages)
    const paginationInit = {
      method: reqMethod, headers: reqHeaders || {}, body: bodyToSend, credentials: 'include',
    };

    const clone = response.clone();
    clone.json().then(firstData => {
      if (match.module === 'activity') {
        console.log('[temu-hook] starting pagination for activity (fetch)');
        fetchAllPages(url, paginationInit, firstData, 'list')
          .then(allData => emit('activity', null, url, allData))
          .catch(err => { console.warn('[temu-hook] pagination failed', err); emit('activity', null, url, firstData); });
      } else if (match.module === 'sales') {
        console.log('[temu-hook] starting pagination for sales (fetch)');
        fetchAllPages(url, paginationInit, firstData, 'subOrderList')
          .then(allData => enrichSalesWithDailyNumbers(url, paginationInit, allData))
          .then(enrichedData => emit('sales', null, url, enrichedData))
          .catch(err => { console.warn('[temu-hook] sales pipeline failed', err); emit('sales', null, url, firstData); });
      } else {
        emit(match.module, match.subType, url, firstData);
      }
    }).catch(() => {});
    return response;
  }

  return _originalFetch(input, init);
};

const _OrigXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function () {
  const xhr = new _OrigXHR();
  let _url = '';
  let _method = 'POST';
  let _match = null;
  let _isUserInfo = false;
  let _body = null;
  const _headers = {};

  const _open = xhr.open.bind(xhr);
  xhr.open = function (method, url, ...rest) {
    _method = method;
    _url = url;
    _isUserInfo = url.includes(USERINFO_PATTERN);
    _match = _isUserInfo ? null : matchModule(url);
    if (_match?.module === 'activity' || url.includes('enroll/list')) {
      console.log('[temu-hook] activity URL hit via XHR, activeModule=', _activeModule, 'match=', _match?.module, url);
    }
    if (_match?.module === 'sales' || url.includes('listOverall') || url.includes('querySkuSalesNumber')) {
      console.log('[temu-hook] sales URL hit via XHR, activeModule=', _activeModule, 'match=', _match?.module, url);
    }
    return _open(method, url, ...rest);
  };

  const _setHeader = xhr.setRequestHeader.bind(xhr);
  xhr.setRequestHeader = function (name, value) {
    _headers[name] = value;
    return _setHeader(name, value);
  };

  const _send = xhr.send.bind(xhr);
  xhr.send = function (body) {
    if (shouldCapture(_match) && body && typeof body === 'string') {
      console.log('[temu-hook] capture(XHR)', _match.module, 'body=', body.slice(0, 600));
      _body = maybeInjectDate(body, _match.module);
    } else {
      _body = body;
    }
    xhr.addEventListener('load', () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (_isUserInfo) { emitUserInfo(parsed); return; }
        if (!shouldCapture(_match)) return;

        // Reconstruct an init for fetchAllPages — uses headers we tracked
        // via setRequestHeader. credentials:'include' so cookies go with it.
        const init = {
          method: _method, headers: _headers, body: _body, credentials: 'include',
        };

        if (_match.module === 'activity') {
          console.log('[temu-hook] starting pagination for activity (XHR)');
          fetchAllPages(_url, init, parsed, 'list')
            .then(all => emit('activity', null, _url, all))
            .catch(err => { console.warn('[temu-hook] pagination failed', err); emit('activity', null, _url, parsed); });
        } else if (_match.module === 'sales') {
          console.log('[temu-hook] starting pagination for sales (XHR)');
          fetchAllPages(_url, init, parsed, 'subOrderList')
            .then(all => enrichSalesWithDailyNumbers(_url, init, all))
            .then(enriched => emit('sales', null, _url, enriched))
            .catch(err => { console.warn('[temu-hook] sales pipeline failed', err); emit('sales', null, _url, parsed); });
        } else {
          emit(_match.module, _match.subType, _url, parsed);
        }
      } catch {}
    });
    return _send(_body);
  };

  return xhr;
};
