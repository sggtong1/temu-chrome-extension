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
  promo:  '/api/v1/coconut/ad/ads_report',
};

// full_managed: list + sales + activity + promo (no orders)
// sales = listOverall only (single-API mode; fires on page load automatically)
const PATTERNS_FULL_MANAGED = {
  list:     '/api/seller/full/flow/analysis/goods/list',
  sales:    ['listOverall', '/sale-manage/list-overall'],
  activity: '/api/kiana/gamblers/marketing/enroll/list',
  promo:    '/api/v1/coconut/ad/ads_report',
};

let _siteType = _hashCfg?.site || 'semi_us';
let _activeModule = _hashCfg?.mod || null;
let _targetDate = _hashCfg?.date || null;

console.log('[temu-hook] init at', location.host,
  '| activeModule=', _activeModule,
  '| siteType=', _siteType,
  '| dateRange=', _hashCfg?.startDate, '..', _hashCfg?.endDate);

// Promo fallback: if auth headers haven't been observed within 12s, fire
// with whatever we collected. Cookies (credentials:'include') may suffice.
if (_hashCfg?.mod === 'promo') {
  setTimeout(() => {
    if (!_promoTriggered) {
      console.warn(`[temu-hook] promo: 12s fallback fire | captured ${Object.keys(_capturedHeaders).length} headers: [${Object.keys(_capturedHeaders).join(', ')}]`);
      triggerPromoCollection({ headers: { ..._capturedHeaders } });
    }
  }, 12000);
}

window.addEventListener('temu:setConfig', (e) => {
  _activeModule = e.detail.activeModule || null;
  _targetDate = e.detail.targetDate || null;
  _siteType = e.detail.siteType || 'semi_us';
  // Don't reset _promoTriggered here — setConfig fires on every page load
  // (after navigateToNextModule sends ACTIVATE_CAPTURE) so we'd retrigger
  // mid-flight. Fresh navigations get a fresh fetch_hook (file scope reset).
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

// Compute the millisecond timestamp at 00:00 (or 23:59:59.999) Beijing Time
// (UTC+8, no DST) for a YYYY-MM-DD date string. Used by promo's ads_report API.
function cstDateBoundaryMs(dateStr, isEnd) {
  const time = isEnd ? '23:59:59.999' : '00:00:00';
  return new Date(`${dateStr}T${time}+08:00`).getTime();
}

// Compute the millisecond timestamp at 00:00 (or 23:59:59.999) Pacific Time
// for a YYYY-MM-DD date string. Handles PST/PDT automatically via Intl.
function ptDateBoundaryMs(dateStr, isEnd) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const m = tzPart.match(/GMT([+-]?\d+)/);
  const offH = m ? parseInt(m[1], 10) : -8;
  const sign = offH >= 0 ? '+' : '-';
  const offStr = `${sign}${String(Math.abs(offH)).padStart(2, '0')}:00`;
  const time = isEnd ? '23:59:59.999' : '00:00:00';
  return new Date(`${dateStr}T${time}${offStr}`).getTime();
}

function maybeInjectDate(body, mod) {
  if (!['list', 'sales', 'activity', 'promo'].includes(mod)) return body;
  try {
    const parsed = JSON.parse(body);
    if (_targetDate) {
      if ('statDate' in parsed) parsed.statDate = _targetDate;
      if ('date' in parsed) parsed.date = _targetDate;
      if ('startDate' in parsed) parsed.startDate = _targetDate;
      if ('endDate' in parsed) parsed.endDate = _targetDate;
    }
    // full_managed sales: 选品状态=已加入站点 server-side filter
    if (mod === 'sales') {
      parsed.selectStatusList = [12];
      if (!('isLack' in parsed)) parsed.isLack = 0;
    }
    // activity (enroll/list): widen the time window so activities that cross
    // the user's range boundary are also returned (their start may be before
    // user range OR end may be after). The transform layer trims to exact overlap.
    // API expects PT epoch ms.
    if (mod === 'activity') {
      const start = _hashCfg?.startDate || _hashCfg?.date;
      const end   = _hashCfg?.endDate   || _hashCfg?.date;
      const MARGIN_MS = 90 * 86_400_000; // 90-day padding catches typical 30/60/90-day campaigns
      if (start) parsed.sessionStartTimeFrom = ptDateBoundaryMs(start, false) - MARGIN_MS;
      if (end)   parsed.sessionEndTimeTo     = ptDateBoundaryMs(end, true)   + MARGIN_MS;
      if (!('sessionStatus' in parsed)) parsed.sessionStatus = 2;
    }
    // promo (coconut/ad/ads_report): force columns_type=4 (商品数据报表) and
    // set start_time/end_time as Beijing-time epoch ms. The page may default
    // to 店铺数据报表 (columns_type=1); we override so the first fetch already
    // returns the goods-level data we want.
    if (mod === 'promo') {
      const start = _hashCfg?.startDate || _hashCfg?.date;
      const end   = _hashCfg?.endDate   || _hashCfg?.date;
      if (start) parsed.start_time = cstDateBoundaryMs(start, false);
      if (end)   parsed.end_time   = cstDateBoundaryMs(end, true);
      parsed.columns_type = 4;
      // Restore some sensible defaults if missing
      if (parsed.page_size == null) parsed.page_size = 50;  // bigger pages for fewer round-trips
      if (parsed.page_number == null) parsed.page_number = 1;
    }
    const out = JSON.stringify(parsed);
    if ((mod === 'sales' || mod === 'activity' || mod === 'promo') && out !== body) {
      console.log(`[temu-hook] body injected for ${mod}:`, out.slice(0, 800));
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
// opts: { listKey, pageNoKey?, pageSizeKey?, module?, baseDelayMs? }
// listKey: where the array of items lives in result; pageNoKey/pageSizeKey:
// body field names for pagination (defaults pageNo / pageSize).
async function fetchAllPages(originalUrl, originalInit, firstData, opts) {
  const listKey      = typeof opts === 'string' ? opts : opts.listKey;
  const pageNoKey    = (typeof opts === 'object' && opts.pageNoKey)   || 'pageNo';
  const pageSizeKey  = (typeof opts === 'object' && opts.pageSizeKey) || 'pageSize';
  const moduleName   = (typeof opts === 'object' && opts.module)      || (listKey === 'list' ? 'activity' : 'sales');
  const baseDelayMs  = (typeof opts === 'object' && opts.baseDelayMs) || (moduleName === 'activity' ? 600 : 150);

  const firstList = firstData?.result?.[listKey] ?? [];
  console.log(`[temu-hook] pagination ${listKey}: page1 size=${firstList.length}, total field=`,
    firstData?.result?.total, 'totalSkcNum=', firstData?.result?.totalSkcNum);

  let body = {};
  try { body = JSON.parse(originalInit.body ?? '{}'); } catch {}
  const pageSize = body[pageSizeKey] ?? 10;

  // Page 1 returned fewer than a full page → no more pages
  if (firstList.length < pageSize) {
    console.log(`[temu-hook] ${listKey}: only 1 page (got ${firstList.length}, pageSize=${pageSize})`);
    return firstData;
  }

  // Force POST. originalInit may lack method when the caller used fetch(Request)
  // — method lives on the Request object, not in init.
  const rawMethod = (originalInit.method || 'POST').toUpperCase();
  const method = (rawMethod === 'GET' || rawMethod === 'HEAD') ? 'POST' : rawMethod;

  const allList = [...firstList];
  let pageNo = 2;
  const MAX_PAGES = 200;

  while (pageNo <= MAX_PAGES) {
    let page = [];
    let aborted = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t0 = Date.now();
        const res  = await _originalFetch(originalUrl, {
          ...originalInit, method,
          body: JSON.stringify({ ...body, [pageNoKey]: pageNo }),
        });
        const data = await res.json();
        page = data?.result?.[listKey] ?? [];
        console.log(`[temu-hook] page ${pageNo}: ${page.length} items, status=${res.status}, ${Date.now() - t0}ms, total=${allList.length + page.length}`);

        if (data?.success === false) {
          const msg = String(data?.errorMsg ?? '');
          if (/frequent|too many|限制|限频/i.test(msg) && attempt < 2) {
            const backoff = 5000 * (attempt + 1); // 5s, 10s
            console.warn(`[temu-hook] page ${pageNo} rate-limited, sleep ${backoff}ms (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, backoff));
            page = [];
            continue;
          }
          console.warn(`[temu-hook] page ${pageNo} success=false:`, msg, data?.errorCode);
          aborted = true;
        }
        break; // either success or non-rate-limit failure
      } catch (e) {
        console.error(`[temu-hook] page ${pageNo} fetch failed:`, e);
        aborted = true;
        break;
      }
    }

    if (aborted) break;
    if (page.length === 0) break;
    allList.push(...page);
    if (page.length < pageSize) { pageNo++; break; }   // last page reached
    pageNo++;
    // Notify content_script that pagination is still progressing so it can
    // ping the service_worker (avoids the 120s timeout firing mid-pagination).
    window.dispatchEvent(new CustomEvent('temu:paginationProgress', { detail: { module: moduleName, pageNo, gotSoFar: allList.length } }));
    await new Promise(r => setTimeout(r, baseDelayMs));
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
      console.log(`[temu-hook] querySkuSalesNumber chunk ${i/CHUNK + 1}: status=${res.status}, ${Date.now() - t0}ms, items=${Array.isArray(data?.result) ? data.result.length : 0}`);
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

// ── Promo: actively trigger ads_report ───────────────────────────────────
// The page's default tab (店铺数据报表) doesn't fire ads_report; that API
// only loads when user clicks 商品数据报表. So we replicate the
// querySkuSalesNumber pattern: listen for ANY ads.temu.com /api/ call to
// borrow its init (auth headers, cookies), then synthesize the ads_report
// POST ourselves with columns_type=4 and the user's date range.
let _promoTriggered = false;

// Cumulative header bag: every fetch/XHR on this page contributes its
// request headers. We use this to assemble a complete auth header set
// before firing our own ads_report (a single call may only carry
// Content-Type while another call carries anti-content/mallid/etc).
const _capturedHeaders = {};
function _absorbHeaders(h) {
  if (!h) return;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    // Headers instance
    h.forEach((v, k) => { _capturedHeaders[k.toLowerCase()] = v; });
  } else if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'string') _capturedHeaders[k.toLowerCase()] = v;
    }
  }
}
function _hasAuthHeaders() {
  return Object.keys(_capturedHeaders).some(k =>
    /anti-content|mallid|csrf|verifyauth|x-token|user-agent-platform/i.test(k));
}

// Match /api/ regardless of host (URL may be relative when called from same
// origin: e.g. fetch('/api/v1/...')).
function _isAdsTemuApi(url) {
  return /\/api\//.test(url);
}

async function triggerPromoCollection(borrowedInit) {
  if (_promoTriggered) return;
  _promoTriggered = true;

  const url = 'https://ads.temu.com/api/v1/coconut/ad/ads_report';
  const startDate = _hashCfg?.startDate || _hashCfg?.date;
  const endDate   = _hashCfg?.endDate   || _hashCfg?.date;
  if (!startDate || !endDate) {
    console.warn('[temu-hook] promo: no date range in boot config');
    return;
  }

  // list_id is a client-issued UUID required by the server (without it, 500).
  // Use crypto.randomUUID where available, fallback to a manual generator.
  const listId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });

  // Body crafted to match the goods report panel's payload shape.
  const buildBody = (pageNo) => ({
    ad_status: [],
    page_number: pageNo,
    page_size: 10,                     // match page default to avoid limit issues
    specific_query_info: '',
    sort_by: 0,
    sort_type: 'desc',
    start_time: cstDateBoundaryMs(startDate, false),
    end_time:   cstDateBoundaryMs(endDate,   true),
    source: 1,
    need_del_status_ad: true,
    need_calculate_goods_summary: true,
    columns_type: 4,
    list_id: listId,
    filter_cooperative_ad_type: 0,
    data_filter: null,
    ad_group_list: null,
    selected_site_id_list: null,
    ad_phase: -1,
  });

  const headerKeys = Object.keys(borrowedInit.headers || {});
  console.log(`[temu-hook] promo: actively calling ads_report for ${startDate}..${endDate} | list_id=${listId} | borrowed ${headerKeys.length} headers: [${headerKeys.join(', ')}]`);

  try {
    const res = await _originalFetch(url, {
      method: 'POST',
      headers: borrowedInit.headers || {},
      body: JSON.stringify(buildBody(1)),
      credentials: 'include',
    });
    let firstData;
    try { firstData = await res.json(); }
    catch (e) {
      const errText = await res.clone().text().catch(() => '');
      console.error(`[temu-hook] promo HTTP ${res.status}: response not JSON. body=${errText.slice(0, 500)}`);
      emit('promo', null, url, { result: {} });
      return;
    }
    if (!res.ok) {
      console.error(`[temu-hook] promo HTTP ${res.status}: body=${JSON.stringify(firstData).slice(0, 800)}`);
    } else {
      console.log(`[temu-hook] promo page1: status=${res.status}, success=${firstData?.success}`);
    }

    // Detect list key on the response
    const listKey = _detectPromoListKey(firstData);

    // Paginate using the same machinery
    const init = {
      method: 'POST',
      headers: borrowedInit.headers || {},
      body: JSON.stringify(buildBody(1)),  // page 1 body for total/etc
      credentials: 'include',
    };
    const allData = await fetchAllPages(url, init, firstData, {
      listKey, pageNoKey: 'page_number', pageSizeKey: 'page_size', module: 'promo',
    });

    emit('promo', null, url, allData);
  } catch (e) {
    console.error('[temu-hook] promo trigger failed:', e);
    emit('promo', null, url, { result: {} });
  }
}

// Inspect the first ads_report response to find which result.* field holds
// the row array (different deployments may use different field names).
function _detectPromoListKey(firstData) {
  const r = firstData?.result;
  if (!r || typeof r !== 'object') return 'list';
  const candidates = ['ads_detail',                // coconut/ads_report (current)
                      'adDetailList', 'list', 'dataList', 'items', 'records',
                      'goods_data_list', 'goods_report_list', 'report_list',
                      'data_list', 'goods_list', 'ad_report_list'];
  for (const k of candidates) {
    if (Array.isArray(r[k])) {
      console.log(`[temu-hook] promo list key detected: ${k} (len=${r[k].length})`);
      return k;
    }
  }
  // Fallback: pick any array-typed key on result
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) {
      console.log(`[temu-hook] promo list key fallback: ${k} (len=${v.length})`);
      return k;
    }
  }
  console.warn('[temu-hook] promo: no array list key found on result. result keys:', Object.keys(r));
  return 'list';
}

const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;

  // Always-on: capture userInfo for mall-type detection
  if (url.includes(USERINFO_PATTERN)) {
    const response = await _originalFetch(input, init);
    response.clone().json().then(emitUserInfo).catch(() => {});
    return response;
  }

  // Promo: accumulate headers from every /api/ call; trigger ads_report
  // once we've seen at least one auth-bearing header. Different page calls
  // may carry different subsets — cumulating gives us the full set.
  if (_activeModule === 'promo' && _isAdsTemuApi(url)) {
    let headers = init.headers;
    if (!headers && typeof input !== 'string' && input.headers) headers = input.headers;
    _absorbHeaders(headers);
    if (!_promoTriggered && _hasAuthHeaders()) {
      triggerPromoCollection({ headers: { ..._capturedHeaders } });
    }
  }

  const match = matchModule(url);
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
        fetchAllPages(url, paginationInit, firstData, { listKey: 'list', module: 'activity' })
          .then(allData => emit('activity', null, url, allData))
          .catch(err => { console.warn('[temu-hook] pagination failed', err); emit('activity', null, url, firstData); });
      } else if (match.module === 'sales') {
        fetchAllPages(url, paginationInit, firstData, { listKey: 'subOrderList', module: 'sales' })
          .then(allData => enrichSalesWithDailyNumbers(url, paginationInit, allData))
          .then(enrichedData => emit('sales', null, url, enrichedData))
          .catch(err => { console.warn('[temu-hook] sales pipeline failed', err); emit('sales', null, url, firstData); });
      } else if (match.module === 'promo') {
        // ads_report uses page_number / page_size (snake_case). The list field
        // name is unknown until we see the first response; promo_transform
        // handles multiple shapes via fallbacks.
        fetchAllPages(url, paginationInit, firstData, {
          listKey: _detectPromoListKey(firstData),
          pageNoKey: 'page_number', pageSizeKey: 'page_size',
          module: 'promo',
        })
          .then(allData => emit('promo', null, url, allData))
          .catch(err => { console.warn('[temu-hook] promo pipeline failed', err); emit('promo', null, url, firstData); });
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
    return _open(method, url, ...rest);
  };

  const _setHeader = xhr.setRequestHeader.bind(xhr);
  xhr.setRequestHeader = function (name, value) {
    _headers[name] = value;
    _capturedHeaders[name.toLowerCase()] = value;  // contribute to global bag
    return _setHeader(name, value);
  };

  const _send = xhr.send.bind(xhr);
  xhr.send = function (body) {
    // Promo: this XHR's headers were already absorbed via setRequestHeader
    // hook. Try triggering whenever we see an /api/ call and now have auth.
    if (_activeModule === 'promo' && !_promoTriggered && _isAdsTemuApi(_url) && _hasAuthHeaders()) {
      triggerPromoCollection({ headers: { ..._capturedHeaders } });
    }

    if (shouldCapture(_match) && body && typeof body === 'string') {
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
          fetchAllPages(_url, init, parsed, { listKey: 'list', module: 'activity' })
            .then(all => emit('activity', null, _url, all))
            .catch(err => { console.warn('[temu-hook] pagination failed', err); emit('activity', null, _url, parsed); });
        } else if (_match.module === 'sales') {
          fetchAllPages(_url, init, parsed, { listKey: 'subOrderList', module: 'sales' })
            .then(all => enrichSalesWithDailyNumbers(_url, init, all))
            .then(enriched => emit('sales', null, _url, enriched))
            .catch(err => { console.warn('[temu-hook] sales pipeline failed', err); emit('sales', null, _url, parsed); });
        } else if (_match.module === 'promo') {
          fetchAllPages(_url, init, parsed, {
            listKey: _detectPromoListKey(parsed),
            pageNoKey: 'page_number', pageSizeKey: 'page_size',
            module: 'promo',
          })
            .then(all => emit('promo', null, _url, all))
            .catch(err => { console.warn('[temu-hook] promo pipeline failed', err); emit('promo', null, _url, parsed); });
        } else {
          emit(_match.module, _match.subType, _url, parsed);
        }
      } catch {}
    });
    return _send(_body);
  };

  return xhr;
};
