// Runs in MAIN world — can access window.fetch and window.XMLHttpRequest
// Communicates with ISOLATED world via CustomEvent

const TARGET_PATTERNS = {
  list: '/api/flow/analysis/list',
  sales: '/api/goods/sku-sale',
  orders: '/mmsos/order/recentOrderList',
  promo: '/bgn/pc/report/ad-report-detail/query',
};

let _activeModule = null;
let _targetDate = null;

window.addEventListener('temu:setConfig', (e) => {
  _activeModule = e.detail.activeModule || null;
  _targetDate = e.detail.targetDate || null;
});

function matchModule(url) {
  for (const [mod, pattern] of Object.entries(TARGET_PATTERNS)) {
    if (url.includes(pattern)) return mod;
  }
  return null;
}

function maybeInjectDate(body, mod) {
  if (!_targetDate || !['list', 'sales'].includes(mod)) return body;
  try {
    const parsed = JSON.parse(body);
    if ('statDate' in parsed) parsed.statDate = _targetDate;
    if ('date' in parsed) parsed.date = _targetDate;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function emit(mod, url, data) {
  window.dispatchEvent(new CustomEvent('temu:apiCapture', {
    detail: { module: mod, url, data },
  }));
}

const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const mod = matchModule(url);

  if (mod && mod === _activeModule) {
    const origBody = init.body;
    if (origBody && typeof origBody === 'string') {
      init = { ...init, body: maybeInjectDate(origBody, mod) };
    }
    const response = await _originalFetch(input, init);
    const clone = response.clone();
    clone.json().then(data => emit(mod, url, data)).catch(() => {});
    return response;
  }

  return _originalFetch(input, init);
};

const _OrigXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function () {
  const xhr = new _OrigXHR();
  let _url = '';
  let _mod = null;
  let _body = null;

  const _open = xhr.open.bind(xhr);
  xhr.open = function (method, url, ...rest) {
    _url = url;
    _mod = matchModule(url);
    return _open(method, url, ...rest);
  };

  const _send = xhr.send.bind(xhr);
  xhr.send = function (body) {
    if (_mod && _mod === _activeModule && body) {
      _body = maybeInjectDate(body, _mod);
    } else {
      _body = body;
    }
    xhr.addEventListener('load', () => {
      if (_mod && _mod === _activeModule) {
        try {
          emit(_mod, _url, JSON.parse(xhr.responseText));
        } catch {}
      }
    });
    return _send(_body);
  };

  return xhr;
};
