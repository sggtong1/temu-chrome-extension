// Runs in MAIN world — can access window.fetch and window.XMLHttpRequest
// Communicates with ISOLATED world via CustomEvent

// semi_us: one API per module
const PATTERNS_SEMI_US = {
  list:   '/api/flow/analysis/list',
  sales:  '/api/sale/analysis/detail',
  orders: '/mmsos/order/recentOrderList',
  promo:  '/bgn/pc/report/ad-report-detail/query',
};

// full_managed: list uses a different endpoint; sales requires two APIs
// sales_meta = listOverall (SKU metadata: extCode, supplierPrice)
// sales_qty  = querySkuSalesNumber (sales numbers per SKU per date)
const PATTERNS_FULL_MANAGED = {
  list:       '/api/seller/full/flow/analysis/goods/list',
  sales_meta: 'listOverall',
  sales_qty:  'querySkuSalesNumber',
  orders:     '/mmsos/order/recentOrderList',
  promo:      '/bgn/pc/report/ad-report-detail/query',
};

let _siteType = 'semi_us';
let _activeModule = null;
let _targetDate = null;

window.addEventListener('temu:setConfig', (e) => {
  _activeModule = e.detail.activeModule || null;
  _targetDate = e.detail.targetDate || null;
  _siteType = e.detail.siteType || 'semi_us';
});

// Returns { module, subType } or null
function matchModule(url) {
  const patterns = _siteType === 'full_managed' ? PATTERNS_FULL_MANAGED : PATTERNS_SEMI_US;
  for (const [key, pattern] of Object.entries(patterns)) {
    if (url.includes(pattern)) {
      if (key === 'sales_meta') return { module: 'sales', subType: 'meta' };
      if (key === 'sales_qty')  return { module: 'sales', subType: 'qty' };
      return { module: key, subType: null };
    }
  }
  return null;
}

function maybeInjectDate(body, mod) {
  if (!_targetDate || !['list', 'sales'].includes(mod)) return body;
  try {
    const parsed = JSON.parse(body);
    if ('statDate' in parsed) parsed.statDate = _targetDate;
    if ('date' in parsed) parsed.date = _targetDate;
    if ('startDate' in parsed) parsed.startDate = _targetDate;
    if ('endDate' in parsed) parsed.endDate = _targetDate;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function emit(module, subType, url, data) {
  window.dispatchEvent(new CustomEvent('temu:apiCapture', {
    detail: { module, subType, url, data },
  }));
}

const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const match = matchModule(url);

  if (match && match.module === _activeModule) {
    const origBody = init.body;
    if (origBody && typeof origBody === 'string') {
      init = { ...init, body: maybeInjectDate(origBody, match.module) };
    }
    const response = await _originalFetch(input, init);
    const clone = response.clone();
    clone.json().then(data => emit(match.module, match.subType, url, data)).catch(() => {});
    return response;
  }

  return _originalFetch(input, init);
};

const _OrigXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function () {
  const xhr = new _OrigXHR();
  let _url = '';
  let _match = null;
  let _body = null;

  const _open = xhr.open.bind(xhr);
  xhr.open = function (method, url, ...rest) {
    _url = url;
    _match = matchModule(url);
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
      if (_match && _match.module === _activeModule) {
        try {
          emit(_match.module, _match.subType, _url, JSON.parse(xhr.responseText));
        } catch {}
      }
    });
    return _send(_body);
  };

  return xhr;
};
