// ISOLATED world content script — embeds a "一键加入发货台" inline card
// on https://seller.kuajingmaihuo.com/main/order-manager/shipping-desk,
// replacing the 佳同跨境 third-party plugin. Independent from the 🛒
// floating panel which still lives in content_script.js.
//
// Flow on click:
//   1. pageQuerySubPurchaseOrder(pageNo:1, pageSize:1) → total
//   2. Modal #1 shows count + 确认按钮
//   3. On confirm:
//      a. querySupplierAddressInfo → pick isDefault address
//      b. paginate pageQuerySubPurchaseOrder(pageSize:50) → accumulate orders
//      c. querySubPurchaseOrderGroupByReceiveAddress(all sns) → groups
//      d. for each group: createDeliveryOrderPreCheck → createDeliveryOrderGroupSimpleByAddress
//      e. live log + progress bar in modal #2

const API_BASE = 'https://seller.kuajingmaihuo.com/bgSongbird-api/supplier/deliverGoods/platform';
const API = {
  pageQuery:        `${API_BASE}/pageQuerySubPurchaseOrder`,
  supplierAddress:  `${API_BASE}/querySupplierAddressInfo`,
  groupByAddress:   `${API_BASE}/querySubPurchaseOrderGroupByReceiveAddress`,
  preCheck:         `${API_BASE}/createDeliveryOrderPreCheck`,
  create:           `${API_BASE}/createDeliveryOrderGroupSimpleByAddress`,
};

// Anchor inside the shipping-desk page DOM — the divider wrapper sits right
// above the table tools (创建发货单 / 移除备货单 / 批量打印拣货单 ...).
// 佳同跨境 also injects here. If Temu renames the class hash this selector
// will need refreshing.
const ANCHOR_SELECTOR = '#root div.outerWrapper-1-4-1 div.index-module__divider-wrapper___8r_kp';
const CARD_HOST_ID    = 'temu-shipping-desk-card-host';
const MODAL_HOST_ID   = 'temu-shipping-desk-modal-host';
const PAGE_SIZE       = 50;   // 官方接口限制每批 50 商品
const CREATE_DELAY_MS = 300;  // 多 group 间间隔, 防风控

// ── API helper ──────────────────────────────────────────────────────────────

// Captured headers from the MAIN world hook (shipping_desk_hook.js).
// Updated whenever the page itself fires a /bgSongbird-api/ request; reused
// in our active calls so server-side anti-content / mallid checks pass.
const _capturedHeaders = {};
window.addEventListener('temuShippingDesk:headers', (e) => {
  const h = e.detail?.headers ?? {};
  for (const [k, v] of Object.entries(h)) _capturedHeaders[k.toLowerCase()] = v;
});

async function apiPost(url, payload) {
  const tail = url.split('/').pop();
  const headers = { 'content-type': 'application/json', ..._capturedHeaders };
  // Don't let captured 'content-type' override JSON (it usually is the same).
  headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new Error(`${tail}: HTTP ${res.status} non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!data?.success) {
    const code = data?.errorCode ?? 'undefined';
    const msg  = data?.errorMsg  || 'failed';
    throw new Error(`${tail}: HTTP ${res.status} ${msg} (code=${code}) body=${text.slice(0, 200)}`);
  }
  return data.result;
}

// ── Card injection ─────────────────────────────────────────────────────────

function tryInjectCard() {
  // SPA nav may have removed prior host; re-inject when anchor returns.
  if (document.getElementById(CARD_HOST_ID)) return;
  const anchor = document.querySelector(ANCHOR_SELECTOR);
  if (!anchor) return;
  injectCard(anchor);
}

function injectCard(anchor) {
  const host = document.createElement('div');
  host.id = CARD_HOST_ID;
  anchor.parentNode.insertBefore(host, anchor);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { display: block; font-family: system-ui; font-size: 13px; }
      .card {
        background: linear-gradient(90deg, #dbeafe 0, #eff6ff 100%);
        border-left: 4px solid #1e40af;
        padding: 10px 14px; margin: 8px 0; border-radius: 6px;
        display: flex; align-items: center; gap: 14px;
      }
      .title { font-weight: 600; color: #1e40af; white-space: nowrap; }
      .desc  { color: #475569; font-size: 12px; flex: 1; line-height: 1.5; }
      .btn   {
        background: #1e40af; color: white;
        padding: 7px 14px; border-radius: 4px; border: none;
        font-weight: 600; font-size: 12px;
        cursor: pointer; white-space: nowrap;
      }
      .btn:hover    { background: #1e3a8a; }
      .btn:disabled { background: #94a3b8; cursor: default; }
    </style>
    <div class="card">
      <span class="title">🚚 Temu 发货助手</span>
      <span class="desc">提示：默认获取当前列表全部备货单数据，如需筛选请在官方筛选位置进行条件过滤后查询，再使用本按钮</span>
      <button class="btn" id="trigger">一键加入发货台</button>
    </div>
  `;
  shadow.getElementById('trigger').addEventListener('click', onTriggerClick);
}

const observer = new MutationObserver(tryInjectCard);
observer.observe(document.body, { childList: true, subtree: true });
tryInjectCard();

// ── Modal helpers ──────────────────────────────────────────────────────────

function closeModal() {
  const m = document.getElementById(MODAL_HOST_ID);
  if (m) m.remove();
}

function openModal(innerHTML) {
  closeModal();
  const host = document.createElement('div');
  host.id = MODAL_HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; font-family: system-ui; font-size: 13px; }
      .overlay { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; }
      .modal   { background: white; border-radius: 8px; max-width: 560px; width: 90vw; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
      .header  { padding: 12px 18px; font-weight: 600; font-size: 14px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
      .close   { cursor: pointer; color: #94a3b8; font-size: 22px; line-height: 1; user-select: none; }
      .body    { padding: 16px 18px; overflow-y: auto; font-size: 13px; line-height: 1.6; }
      .footer  { padding: 10px 18px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px; justify-content: flex-end; }
      .btn     { padding: 7px 16px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; font-size: 13px; }
      .btn:disabled { opacity: .5; cursor: default; }
      .btn-primary   { background: #1e40af; color: white; }
      .btn-primary:hover:not(:disabled) { background: #1e3a8a; }
      .btn-secondary { background: #f1f5f9; color: #475569; }
      .info       { background: #fff7ed; color: #c2410c; padding: 8px 10px; border-radius: 4px; margin-bottom: 12px; font-size: 12px; line-height: 1.5; }
      .info-blue  { background: #eff6ff; color: #1e40af; padding: 8px 10px; border-radius: 4px; margin: 12px 0 8px; font-size: 12px; line-height: 1.5; }
      .picker-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .picker-label { font-size: 13px; color: #374151; white-space: nowrap; }
      .picker-row select { flex: 1; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; font-size: 12px; }
      .btn.full { width: 100%; padding: 10px; font-size: 14px; }
      .progbar { height: 6px; background: #e2e8f0; border-radius: 3px; margin: 8px 0; overflow: hidden; }
      .progbar-fill { height: 100%; background: #1e40af; width: 0%; transition: width .3s; }
      .console { background: #1e293b; color: #e2e8f0; padding: 10px; border-radius: 4px; height: 240px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
      .console .ok    { color: #4ade80; }
      .console .err   { color: #f87171; }
      .console .warn  { color: #fde047; }
      .console .muted { color: #94a3b8; }
    </style>
    ${innerHTML}
  `;
  return shadow;
}

// ── Single combined modal: warehouse picker + 一键执行 + 进度区 ────────────

async function onTriggerClick() {
  const shadow = openModal(`
    <div class="overlay">
      <div class="modal">
        <div class="header">一键创建发货单 <span class="close" id="close">×</span></div>
        <div class="body">
          <div class="info">提示：点击执行后，程序会逐批获取并执行！此过程不要关闭弹窗或刷新页面！如需中断请刷新网页！</div>
          <div class="picker-row">
            <span class="picker-label">选择发货仓库：</span>
            <select id="addr-select" disabled>
              <option>加载中...</option>
            </select>
          </div>
          <button class="btn btn-primary full" id="exec" disabled>一键执行</button>
          <div class="info-blue">官方接口限制，每批次最多执行 50 个商品。执行过程中请勿关闭弹窗或刷新网页。</div>
          <div class="progbar"><div class="progbar-fill" id="bar"></div></div>
          <div class="console" id="console"><div class="muted">等待执行...</div></div>
        </div>
        <div class="footer">
          <button class="btn btn-secondary" id="cancel">关闭</button>
        </div>
      </div>
    </div>
  `);
  shadow.getElementById('close').addEventListener('click', closeModal);
  shadow.getElementById('cancel').addEventListener('click', closeModal);

  const select  = shadow.getElementById('addr-select');
  const execBtn = shadow.getElementById('exec');
  const consoleEl = shadow.getElementById('console');

  // 并行拉取: 数量 + 发货人地址列表
  const [totalRes, addrRes] = await Promise.allSettled([
    apiPost(API.pageQuery,       { pageNo: 1, pageSize: 1 }),
    apiPost(API.supplierAddress, {}),
  ]);

  let total = 0;
  if (totalRes.status === 'fulfilled') {
    total = totalRes.value?.total ?? 0;
  } else {
    consoleEl.innerHTML = `<div class="err">查询备货单数量失败: ${totalRes.reason?.message ?? totalRes.reason}</div>`;
  }

  let addresses = [];
  if (addrRes.status === 'fulfilled') {
    addresses = addrRes.value?.supplierAddressList ?? [];
  } else {
    consoleEl.innerHTML += `<div class="err">取发货人地址失败: ${addrRes.reason?.message ?? addrRes.reason}</div>`;
  }

  // 填充下拉
  select.innerHTML = '';
  if (addresses.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '（无可用发货仓库）';
    opt.value = '';
    select.appendChild(opt);
  } else {
    for (const a of addresses) {
      const opt = document.createElement('option');
      opt.value = String(a.id);
      opt.textContent = a.addressLabel;
      if (a.isDefault) opt.selected = true;
      select.appendChild(opt);
    }
    select.disabled = false;
  }

  // 状态提示行 (首条 console)
  consoleEl.innerHTML = `<div class="muted">当前要操作的备货单数量: ${total} 个 | 共 ${addresses.length} 个可选仓库</div>`;

  if (total > 0 && addresses.length > 0) {
    execBtn.disabled = false;
  }

  execBtn.addEventListener('click', () => {
    const addrId = parseInt(select.value, 10);
    if (!addrId) return;
    // 锁定选择 + 执行按钮, 开始流程
    select.disabled = true;
    execBtn.disabled = true;
    runCreateFlow(total, addrId, shadow);
  });
}

// ── Multi-step API flow (runs inside the same modal) ───────────────────────

async function runCreateFlow(total, deliveryAddressId, shadow) {
  const cancelBtn = shadow.getElementById('cancel');
  const consoleEl = shadow.getElementById('console');
  const barEl     = shadow.getElementById('bar');

  // 清掉 "等待执行..." / 状态提示
  consoleEl.innerHTML = '';

  function log(msg, level = '') {
    const ts = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.className = level;
    el.textContent = `[${ts}] ${msg}`;
    consoleEl.appendChild(el);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  function setProgress(pct) { barEl.style.width = `${pct}%`; }

  log(`开始执行... 发货人地址 id=${deliveryAddressId}`);
  setProgress(5);

  // Step 2: 分页拉取全部备货单
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOrders = []; // { sn, supplierId, skus: [{productSkuId, qty}] }
  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    try {
      log(`第 ${pageNo}/${totalPages} 页: 拉取列表中...`);
      const qRes = await apiPost(API.pageQuery, { pageNo, pageSize: PAGE_SIZE });
      const items = qRes?.list ?? [];
      log(`✅ 第 ${pageNo} 页列表获取成功，共 ${items.length} 条`, 'ok');
      for (const item of items) {
        const basic = item.subPurchaseOrderBasicVO ?? {};
        const skus = (item.orderDetailVOList ?? []).map(d => ({
          productSkuId: d.productSkuId,
          qty: d.productSkuPurchaseQuantity,
        }));
        if (basic.subPurchaseOrderSn && skus.length > 0) {
          allOrders.push({ sn: basic.subPurchaseOrderSn, supplierId: basic.supplierId, skus });
        }
      }
    } catch (e) {
      log(`❌ 第 ${pageNo} 页查询失败: ${e.message}`, 'err');
    }
    setProgress(5 + 20 * pageNo / totalPages);
  }
  if (allOrders.length === 0) {
    log('没有可创建的备货单', 'warn');
    setProgress(100);
    cancelBtn.disabled = false;
    return;
  }

  // Step 3: 按收货子仓分组
  let groups = [];
  try {
    log(`分组中... (共 ${allOrders.length} 个备货单)`);
    const gRes = await apiPost(API.groupByAddress, {
      subPurchaseOrderSnList: allOrders.map(o => o.sn),
    });
    groups = gRes?.subPurchaseReceiveAddressGroups ?? [];
    log(`✅ 分组完成，共 ${groups.length} 组`, 'ok');
  } catch (e) {
    log(`❌ 分组失败: ${e.message}`, 'err');
    cancelBtn.disabled = false;
    return;
  }
  setProgress(30);

  // Step 4: 每组预检 + 创建
  const orderMap = Object.fromEntries(allOrders.map(o => [o.sn, o]));
  let successGroups = 0;
  let createdOrderNumbers = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const groupSns = group.subPurchaseOrderSnList ?? [];
    const warehouseLabel = group.receiveAddressInfo?.receiverName || `第 ${gi + 1} 组`;

    const preCreateInfoList = groupSns.map(sn => {
      const o = orderMap[sn] ?? { skus: [] };
      return {
        subPurchaseOrderSn: sn,
        deliverOrderDetailInfos: o.skus.map(s => ({
          deliverSkuNum: s.qty, productSkuId: s.productSkuId,
        })),
      };
    });

    // 4a. PreCheck (校验, 软警告不阻塞)
    log(`第 ${gi + 1}/${groups.length} 组 (${warehouseLabel}, ${groupSns.length} 单): 预检...`);
    try {
      const preRes = await apiPost(API.preCheck, {
        subPurchaseOrderSnList: groupSns,
        preCreateInfoList,
      });
      if (preRes?.needMergeSubPurchaseOrderSnList?.length) {
        log(`⚠ 预检提示需要合并: ${preRes.needMergeSubPurchaseOrderSnList.join(',')}`, 'warn');
      }
      if (preRes?.skuWeightLimitTipSubPurchaseList?.length) {
        log(`⚠ 有 SKU 超重提示 (限重 ${preRes.skuWeightLimitConfigVal})`, 'warn');
      }
      if (preRes?.createExpressErrorRequestList?.length) {
        log(`⚠ 物流错误提示`, 'warn');
      }
    } catch (e) {
      log(`❌ 第 ${gi + 1} 组预检失败，跳过: ${e.message}`, 'err');
      setProgress(30 + 70 * (gi + 1) / groups.length);
      continue;
    }

    // 4b. Create
    const deliveryOrderCreateGroupItem = {
      deliveryOrderCreateInfos: groupSns.map(sn => {
        const o = orderMap[sn] ?? { skus: [], supplierId: null };
        return {
          subPurchaseOrderSn: sn,
          deliverOrderDetailInfos: o.skus.map(s => ({
            deliverSkuNum: s.qty, productSkuId: s.productSkuId,
          })),
          packageInfos: [{
            packageDetailSaveInfos: o.skus.map(s => ({
              skuNum: s.qty, productSkuId: s.productSkuId,
            })),
          }],
          crossEntityDeliveryMallId: o.supplierId,
          deliveryAddressId,
        };
      }),
      receiveAddressInfo: group.receiveAddressInfo,
      subWarehouseId: group.subWarehouseId,
    };

    try {
      log(`第 ${gi + 1}/${groups.length} 组: 创建发货单...`);
      const cRes = await apiPost(API.create, {
        deliveryOrderCreateGroupList: [deliveryOrderCreateGroupItem],
      });
      const nos = cRes?.deliveryOrders ?? [];
      log(`✅ 第 ${gi + 1} 组创建成功: ${nos.join(', ') || '(无单号返回)'}`, 'ok');
      successGroups++;
      createdOrderNumbers.push(...nos);
    } catch (e) {
      log(`❌ 第 ${gi + 1} 组创建失败: ${e.message}`, 'err');
    }
    setProgress(30 + 70 * (gi + 1) / groups.length);
    if (gi < groups.length - 1) await new Promise(r => setTimeout(r, CREATE_DELAY_MS));
  }

  setProgress(100);
  log('');
  log(`=== 执行完成: 成功 ${successGroups}/${groups.length} 组 ===`);
  if (createdOrderNumbers.length) {
    log(`生成的发货单号: ${createdOrderNumbers.join(', ')}`, 'ok');
  }
  cancelBtn.disabled = false;
}
