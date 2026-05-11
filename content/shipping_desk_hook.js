// MAIN world hook for shipping-desk page — captures auth headers from any
// /bgSongbird-api/ call the page fires, and broadcasts them to the ISOLATED
// world content script (shipping_desk_inject.js) via CustomEvent so it can
// reuse them when synthesizing our own API calls.
//
// Mirrors the promo "_capturedHeaders" pattern in content/fetch_hook.js but
// scoped narrowly to this single page; kept in its own file to avoid bloating
// the main MAIN-world hook (which only matches agentseller/ads.temu.com).

(function () {
  const captured = {};

  function absorb(headersInit) {
    if (!headersInit) return;
    if (typeof headersInit.forEach === 'function' && !Array.isArray(headersInit)) {
      headersInit.forEach((v, k) => { captured[k.toLowerCase()] = v; });
    } else if (typeof headersInit === 'object') {
      for (const [k, v] of Object.entries(headersInit)) {
        if (typeof v === 'string') captured[k.toLowerCase()] = v;
      }
    }
  }

  function broadcast() {
    window.dispatchEvent(new CustomEvent('temuShippingDesk:headers', {
      detail: { headers: { ...captured } },
    }));
  }

  function isBgsongbird(url) {
    return typeof url === 'string' && url.includes('/bgSongbird-api/');
  }

  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (isBgsongbird(url)) {
      let h = init.headers;
      if (!h && typeof input !== 'string' && input?.headers) h = input.headers;
      absorb(h);
      if (Object.keys(captured).length) broadcast();
    }
    return _origFetch(input, init);
  };

  const _OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _OrigXHR();
    let _url = '';
    let _bgs = false;
    const _open = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) { _url = url; _bgs = isBgsongbird(url); return _open(method, url, ...rest); };
    const _setHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (name, value) {
      if (_bgs) { captured[name.toLowerCase()] = value; broadcast(); }
      return _setHeader(name, value);
    };
    return xhr;
  };
})();
