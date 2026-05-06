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
    return JSON.stringify(parsed);
  } catch {
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

  const allList = [...firstList];
  let pageNo = 2;
  const MAX_PAGES = 200;

  while (pageNo <= MAX_PAGES) {
    const res  = await _originalFetch(originalUrl, { ...originalInit, body: JSON.stringify({ ...body, pageNo }) });
    const data = await res.json();
    const page = data?.result?.[listKey] ?? [];
    if (page.length === 0) break;
    allList.push(...page);
    if (page.length < pageSize) { pageNo++; break; }   // last page reached
    pageNo++;
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[temu-hook] paginated ${listKey}: fetched=${allList.length}, pages=${pageNo - 1}`);
  return { ...firstData, result: { ...firstData.result, [listKey]: allList } };
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
    const origBody = init.body;
    if (origBody && typeof origBody === 'string') {
      console.log('[temu-hook] capture', match.module, 'body=', origBody.slice(0, 600));
      init = { ...init, body: maybeInjectDate(origBody, match.module) };
    }
    const response = await _originalFetch(input, init);
    const clone = response.clone();
    clone.json().then(firstData => {
      if (match.module === 'activity') {
        fetchAllPages(url, init, firstData, 'list')
          .then(allData => emit('activity', null, url, allData))
          .catch(() => emit('activity', null, url, firstData));
      } else if (match.module === 'sales') {
        fetchAllPages(url, init, firstData, 'subOrderList')
          .then(allData => emit('sales', null, url, allData))
          .catch(() => emit('sales', null, url, firstData));
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
  let _match = null;
  let _isUserInfo = false;
  let _body = null;

  const _open = xhr.open.bind(xhr);
  xhr.open = function (method, url, ...rest) {
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

  const _send = xhr.send.bind(xhr);
  xhr.send = function (body) {
    if (_match && _match.module === _activeModule && body) {
      _body = maybeInjectDate(body, _match.module);
    } else {
      _body = body;
    }
    xhr.addEventListener('load', () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (_isUserInfo) {
          emitUserInfo(parsed);
        } else if (shouldCapture(_match)) {
          emit(_match.module, _match.subType, _url, parsed);
        }
      } catch {}
    });
    return _send(_body);
  };

  return xhr;
};
