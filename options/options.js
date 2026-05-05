const urlEl = document.getElementById('url');
const keyEl = document.getElementById('key');
const statusEl = document.getElementById('status');

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], ({ supabaseUrl, supabaseAnonKey }) => {
  if (supabaseUrl) urlEl.value = supabaseUrl;
  if (supabaseAnonKey) keyEl.value = supabaseAnonKey;
});

document.getElementById('save').addEventListener('click', () => {
  const supabaseUrl = urlEl.value.trim();
  const supabaseAnonKey = keyEl.value.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    setStatus('请填写 URL 和 Anon Key', false);
    return;
  }
  chrome.storage.local.set({ supabaseUrl, supabaseAnonKey }, () => {
    setStatus('已保存', true);
  });
});

document.getElementById('test').addEventListener('click', async () => {
  const supabaseUrl = urlEl.value.trim();
  const supabaseAnonKey = keyEl.value.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    setStatus('请先填写 URL 和 Anon Key', false);
    return;
  }
  setStatus('测试中...', true);
  try {
    // anon key can't access /rest/v1/ root (requires service_role).
    // Query a known table with limit=0 instead.
    // 200 = table exists; 404 = table not found but key+URL are valid; 401/403 = bad key.
    const resp = await fetch(`${supabaseUrl}/rest/v1/sku_daily_metrics?limit=0`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    });
    if (resp.ok || resp.status === 404) {
      setStatus('✅ 连接成功', true);
    } else {
      const text = await resp.text();
      setStatus(`❌ HTTP ${resp.status}: ${text.slice(0, 120)}`, false);
    }
  } catch (e) {
    setStatus(`❌ ${e.message}`, false);
  }
});
