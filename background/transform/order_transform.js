/**
 * recentOrderList pageItems + batchQueryByOrder 供货价 → Plan A 订单行契约。
 * - priceMap key = `${orderSn}::${productSkuId}`
 * - 平台配送费(尾程+揽收)= parentOrderMap.waybillInfoList[].interlineInfoForAggregationInfo[].estimatedAmount
 *   之和(字符串如 "$3.27",买家侧币种 USD),按订单内各行 quantity 占比分摊 → deliveryFeeCents。
 *   注:一个订单可能有 2 段(COLLECTION_CHANNEL 揽收 + TAIL_CHANNEL 尾程)需相加。
 * - 单价取 activitySupplierPrice ?? supplierPrice(分,CNY)。
 * 字段须匹配 shop_sku_snapshot 标识(spec §3.1):productSkuId=platform_sku_id、
 * productSpuId=product_id(SPU 数字 id)、skuExtCode=货号。
 */

// "$3.27" / "$1,234.56" → 327 / 123456(分)
export function parseMoneyToCents(s) {
  if (s == null) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function detectCurrency(s) {
  const t = String(s ?? '');
  if (t.includes('€')) return 'EUR';
  if (t.includes('£')) return 'GBP';
  return 'USD';
}

export function buildPriceMap(resp) {
  const map = {};
  const list = resp?.result?.querySupplierPriceByOrderRespList ?? [];
  for (const po of list) {
    for (const sub of (po.supplierPriceWithSubOrderRespList ?? [])) {
      const orderSn = String(sub.orderSn ?? '');
      for (const sku of (sub.productSkuSupplierPriceRespList ?? [])) {
        const skuId = String(sku.productSkuId ?? '');
        if (!orderSn || !skuId) continue;
        const act = sku.activitySupplierPrice;
        const day = sku.supplierPrice;
        const unit = act != null ? act : (day != null ? day : 0);
        map[`${orderSn}::${skuId}`] = {
          unitPriceCents: Number(unit) || 0,
          priceType: act != null ? 'activity' : 'daily',
          currency: sku.currencyType ?? 'CNY',
        };
      }
    }
  }
  return map;
}

export function transformOrderAmounts(pageItems, priceMap, region) {
  const rows = [];
  for (const item of (pageItems ?? [])) {
    const pm = item.parentOrderMap ?? {};
    const parentOrderSn = pm.parentOrderSn != null ? String(pm.parentOrderSn) : null;
    if (!parentOrderSn) continue;
    const orderTime = pm.parentOrderTimeStr ?? null;
    const orderStatus = pm.parentOrderStatus != null ? Number(pm.parentOrderStatus) : null;

    // 平台配送费(尾程+揽收预估)— estimatedAmount 字符串求和;一单可能 2 段需相加
    let deliveryTotal = 0;
    let deliveryCurrency = null;
    for (const wb of (pm.waybillInfoList ?? [])) {
      for (const info of (wb.interlineInfoForAggregationInfo ?? [])) {
        if (info.estimatedAmount == null) continue;
        deliveryTotal += parseMoneyToCents(info.estimatedAmount);
        if (!deliveryCurrency) deliveryCurrency = detectCurrency(info.estimatedAmount);
      }
    }
    const lines = item.orderList ?? [];
    const totalQty = lines.reduce((s, o) => s + (Number(o.quantity) || 0), 0);

    for (const line of lines) {
      const info = (line.productInfoList ?? [])[0] ?? {};
      const productSkuId = info.productSkuId != null ? String(info.productSkuId)
        : (line.productSkuIdList ?? [])[0] != null ? String(line.productSkuIdList[0]) : null;
      if (!productSkuId) continue;
      const orderSn = String(line.orderSn ?? '');
      const quantity = Number(line.quantity) || 0;
      const price = priceMap[`${orderSn}::${productSkuId}`] ?? null;
      const deliveryFeeCents = totalQty > 0 ? Math.round(deliveryTotal * (quantity / totalQty)) : 0;
      rows.push({
        region,
        parentOrderSn,
        orderSn,
        productSkuId,
        productSpuId: info.productSpuId != null ? String(info.productSpuId) : null,
        productSkcId: info.productSkcId != null ? String(info.productSkcId) : null,
        skuExtCode: (line.extCodeList ?? [])[0] ?? null,
        quantity,
        unitPriceCents: price ? price.unitPriceCents : 0,
        priceType: price ? price.priceType : 'daily',
        currency: price ? price.currency : 'CNY',
        shippingFeeCents: 0,                       // 运费(自发货)暂无源,保留 0
        deliveryFeeCents,                          // 平台配送费(尾程+揽收预估,买家侧币种)
        deliveryCurrency: deliveryCurrency ?? null,
        orderTime,
        orderStatus,
      });
    }
  }
  return rows;
}
