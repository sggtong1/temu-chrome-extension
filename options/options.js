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
    const resp = await fetch(`${supabaseUrl}/rest/v1/shops?select=mall_id&limit=1`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    });
    if (resp.ok) {
      setStatus('✅ 连接成功', true);
    } else {
      const text = await resp.text();
      setStatus(`❌ HTTP ${resp.status}: ${text.slice(0, 80)}`, false);
    }
  } catch (e) {
    setStatus(`❌ ${e.message}`, false);
  }
});
