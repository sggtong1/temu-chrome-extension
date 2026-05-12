const urlEl = document.getElementById('url');
const statusEl = document.getElementById('status');

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

chrome.storage.local.get(['apiUrl'], ({ apiUrl }) => {
  if (apiUrl) urlEl.value = apiUrl;
});

document.getElementById('save').addEventListener('click', () => {
  const apiUrl = urlEl.value.trim().replace(/\/$/, '');
  if (!apiUrl) {
    setStatus('请填写 API URL', false);
    return;
  }
  chrome.storage.local.set({ apiUrl }, () => {
    setStatus('已保存', true);
  });
});

document.getElementById('test').addEventListener('click', async () => {
  const apiUrl = urlEl.value.trim().replace(/\/$/, '');
  if (!apiUrl) {
    setStatus('请先填写 API URL', false);
    return;
  }
  setStatus('测试中...', true);
  try {
    // Quick health check: hit a known table with limit=0.
    // 200 OK (with []) = table exists; 404 = URL reachable but table missing.
    const resp = await fetch(`${apiUrl}/dashboard_metrics?limit=0`);
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
