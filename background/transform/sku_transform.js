/**
 * Transforms SALES API response into per-SKU records.
 * Expected shape: { result: { skuList: [{ skuId, salesNumber, activityPrice, dailyPrice, extCode, properties }] } }
 * activityPrice and dailyPrice are in CENTS (divide by 100).
 */
export function parseSalesResponse(rawSales) {
  const skuList = rawSales?.result?.skuList ?? rawSales?.result?.list ?? [];
  const skuSales = {};
  const skuPrices = {};
  const skuSpuMap = {};

  for (const item of skuList) {
    const id = String(item.skuId ?? '');
    if (!id) continue;
    skuSales[id] = Number(item.salesNumber ?? item.saleNum ?? 0);
    skuPrices[id] = {
      activityPrice: item.activityPrice != null ? item.activityPrice / 100 : null,
      dailyPrice: item.dailyPrice != null ? item.dailyPrice / 100 : null,
      extCode: item.extCode ?? item.goodsCode ?? '',
      properties: item.properties ?? {},
    };
    if (item.spuId) skuSpuMap[id] = String(item.spuId);
  }
  return { skuSales, skuPrices, skuSpuMap };
}

/**
 * Transforms ORDERS API response into per-SKU shipping aggregation.
 * Expected shape: { result: { orderList: [{ parentOrderMap: { waybillInfoList }, orderList }] } }
 */
export function parseOrdersResponse(rawOrders) {
  const shippingBySkuId = {};

  const outerList = rawOrders?.result?.orderList ?? [];
  for (const item of outerList) {
    const subOrders = item.orderList ?? [];
    const pm = item.parentOrderMap ?? {};
    const waybills = pm.waybillInfoList ?? [];

    let shippingUsd = 0;
    for (const wb of waybills) {
      for (const info of (wb.interlineInfoForAggregationInfo ?? [])) {
        const amt = info.shippingFeeAmount ?? info.shippingFee ?? 0;
        const currency = info.currency ?? 'USD';
        shippingUsd += currency === 'USD' ? amt / 100 : 0;
      }
    }

    const totalQty = subOrders.reduce((s, o) => s + (o.quantity ?? 1), 0);
    for (const order of subOrders) {
      const skuId = String(order.skuId ?? '');
      if (!skuId) continue;
      const qty = order.quantity ?? 1;
      const portion = totalQty > 0 ? (qty / totalQty) * shippingUsd : 0;
      if (!shippingBySkuId[skuId]) shippingBySkuId[skuId] = { shippingUsd: 0, qty: 0 };
      shippingBySkuId[skuId].shippingUsd += portion;
      shippingBySkuId[skuId].qty += qty;
    }
  }

  const ordersShipping = {};
  for (const [skuId, agg] of Object.entries(shippingBySkuId)) {
    ordersShipping[skuId] = {
      per_unit: agg.qty > 0 ? Math.round((agg.shippingUsd / agg.qty) * 10000) / 10000 : 0,
    };
  }
  return ordersShipping;
}

/**
 * Builds sku_daily_metrics rows.
 * @param {{ shopName, date, siteType }} ctx
 * @param {{ skuSales, skuPrices, skuSpuMap }} salesData
 * @param {object} ordersShipping  { skuId: { per_unit } }
 * @param {object} skuCostMap      { 货号: [cost_price, shipping_cost] }
 */
export function buildSkuRows(ctx, { skuSales, skuPrices, skuSpuMap }, ordersShipping, skuCostMap) {
  const { shopName, date } = ctx;
  const rows = [];

  for (const skuId of Object.keys(skuSales)) {
    const salesQty = skuSales[skuId] ?? 0;
    if (!salesQty) continue;

    const priceInfo = skuPrices[skuId] ?? {};
    const activityPrice = priceInfo.activityPrice;
    const dailyPrice = priceInfo.dailyPrice;
    const extCode = priceInfo.extCode ?? '';
    const properties = priceInfo.properties ?? {};
    const spuId = skuSpuMap[skuId] ?? '';

    const skuSpec = Object.entries(properties).map(([k, v]) => `${k}:${v}`).join('、');
    const salesAmount = activityPrice != null ? Math.round(salesQty * activityPrice * 100) / 100 : null;

    const costTuple = extCode ? skuCostMap[extCode] : null;
    const costPrice = costTuple?.[0] ?? null;
    let shippingCost = costTuple?.[1] ?? 0;
    const costSource = costPrice != null ? 'sku_cost' : null;

    const orderShip = ordersShipping[skuId];
    let actualShippingPerUnit = null;
    if (orderShip?.per_unit) {
      actualShippingPerUnit = orderShip.per_unit;
      shippingCost = actualShippingPerUnit;
    }

    const missingCost = costPrice == null;
    let salesCost = null, grossProfit = null, margin = null;
    if (!missingCost && salesQty) {
      const unitCost = costPrice + shippingCost;
      salesCost = Math.round(unitCost * salesQty * 100) / 100;
      if (salesAmount != null) {
        grossProfit = Math.round((salesAmount - salesCost) * 100) / 100;
      }
      if (activityPrice) {
        margin = Math.round(((activityPrice - unitCost) / activityPrice) * 10000) / 10000;
      }
    }

    const row = {
      '日期': date,
      '店铺名称': shopName,
      '商品SPUID': spuId,
      skuId,
      'sku规格': skuSpec,
      '货号': extCode,
      '活动售价': activityPrice != null ? Math.round(activityPrice * 100) / 100 : null,
      '日常售价': dailyPrice != null ? Math.round(dailyPrice * 100) / 100 : null,
      '销售件数': salesQty,
      '销售额': salesAmount,
      '成本价': costPrice != null ? Math.round(costPrice * 100) / 100 : null,
      '销售成本': salesCost,
      '毛利润': grossProfit,
      '毛利率': margin,
      '成本缺失': missingCost,
      '成本来源': costSource,
    };
    if (actualShippingPerUnit != null) row['実際運費'] = actualShippingPerUnit;
    rows.push(row);
  }
  return rows;
}
