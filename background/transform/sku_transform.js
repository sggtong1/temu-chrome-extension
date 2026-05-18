/**
 * Transforms SALES API response into per-SKU records.
 *
 * semi_us shape:
 *   { result: { saleAnalysisDetailDTOList: [{ productSkuId, productId, skuExtCode, skuSaleDTOList: [{date, saleNum}] }] } }
 *
 * full_managed shape (listOverall single-API):
 *   { result: [ { goodsId, skuQuantityDetailList: [{ productSkuId, skuExtCode, className, ... }] } ] }
 *
 * @param {object} rawSales
 * @param {{ siteType: string, date: string }} ctx
 */
export function parseSalesResponse(rawSales, ctx) {
  const siteType = ctx?.siteType ?? 'semi_us';
  const targetDate = ctx?.date ?? '';

  if (siteType === 'full_managed') {
    return _parseFullManaged(rawSales, targetDate);
  }
  return _parseSemiUs(rawSales, targetDate);
}

function _parseSemiUs(rawSales, targetDate) {
  const items = rawSales?.result?.saleAnalysisDetailDTOList ?? [];
  const skuSales = {};
  const skuPrices = {};
  const skuSpuMap = {};

  for (const item of items) {
    const id = String(item.productSkuId ?? '');
    if (!id) continue;

    // Find sales qty for target date from the daily breakdown list
    const dayEntry = (item.skuSaleDTOList ?? []).find(d => d.date === targetDate);
    skuSales[id] = dayEntry?.saleNum ?? 0;

    skuPrices[id] = {
      activityPrice: null,  // not available from sale/analysis/detail; comes from kiana/gamblers
      dailyPrice: null,
      extCode: item.skuExtCode ?? '',
      properties: {},
    };

    const spuId = item.productId ?? item.productSkcId ?? '';
    if (spuId) skuSpuMap[id] = String(spuId);
  }

  return { skuSales, skuPrices, skuSpuMap };
}

function _parseFullManaged(rawSales, targetDate) {
  // listOverall returns a dashboard summary; the product list lives in subOrderList.
  const result = rawSales?.result;

  const products = Array.isArray(result) ? result
    : result?.subOrderList ?? result?.list ?? result?.dataList
      ?? result?.items ?? result?.records ?? result?.goodsList ?? [];

  if (!Array.isArray(products) || !products.length) {
    console.warn('[temu] _parseFullManaged: no products extracted, full result keys =',
      result && typeof result === 'object' ? Object.keys(result) : 'N/A');
  }

  // Belt-and-suspenders filter: drop products that aren't actively listed.
  // selectStatusList=[12] in the request already filters server-side, but
  // onSalesDurationOffline > 0 is a reliable client-side check for "在线".
  const onlineProducts = products.filter(p => (p.onSalesDurationOffline ?? 0) > 0);
  console.log(`[temu] _parseFullManaged: ${products.length} products, ${onlineProducts.length} online (onSalesDurationOffline>0)`);

  // Build skuId → salesNumber map for the target date from querySkuSalesNumber data
  const dailySalesItems = rawSales?.salesNumbers ?? [];
  const dailySalesMap = {};
  let matchedDate = 0;
  for (const item of dailySalesItems) {
    const itemDate = item.date ?? item.statDate ?? item.saleDate ?? '';
    const skuId = String(item.prodSkuId ?? item.productSkuId ?? '');
    const num = item.salesNumber ?? item.saleNum ?? item.salesNum ?? 0;
    if (itemDate === targetDate && skuId) {
      dailySalesMap[skuId] = num;
      matchedDate++;
    }
  }
  console.log(`[temu] _parseFullManaged: ${dailySalesItems.length} sales records, ${matchedDate} match target date ${targetDate}`);

  const skuSales = {};
  const skuPrices = {};
  const skuSpuMap = {};

  for (const product of onlineProducts) {
    // SPU ID prefers productId; fall back to goodsId / productSkcId for safety.
    const spuId = String(product.productId ?? product.goodsId ?? product.productSkcId ?? '');
    for (const sku of (product.skuQuantityDetailList ?? [])) {
      const id = String(sku.productSkuId ?? '');
      if (!id) continue;

      // Real daily sales qty comes from querySkuSalesNumber (dailySalesMap).
      // Fallback to 0 if that API didn't return data for this SKU/date.
      skuSales[id] = dailySalesMap[id] ?? 0;
      skuPrices[id] = {
        activityPrice: sku.activityPrice != null ? sku.activityPrice / 100 : null,
        dailyPrice:    sku.supplierPrice  != null ? sku.supplierPrice  / 100 : null,
        extCode:       sku.skuExtCode ?? sku.extCode ?? '',
        // className is the SKU spec text (color/size/variant). Store raw value;
        // buildSkuRows uses specText if present, otherwise falls back to properties.
        properties:    {},
        specText:      sku.className ?? '',
      };
      if (spuId) skuSpuMap[id] = spuId;
    }
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

    const priceInfo = skuPrices[skuId] ?? {};
    const dailyPrice = priceInfo.dailyPrice;
    const extCode = priceInfo.extCode ?? '';
    const properties = priceInfo.properties ?? {};
    const spuId = skuSpuMap[skuId] ?? '';

    const skuSpec = priceInfo.specText
      || Object.entries(properties).map(([k, v]) => `${k}:${v}`).join('、');

    const costTuple = extCode ? skuCostMap[extCode] : null;
    const costPrice = costTuple?.[0] ?? null;
    const costSource = costPrice != null ? 'sku_cost' : null;
    const missingCost = costPrice == null;

    // Actual shipping fee (per unit) from orders API — semi_us only
    const orderShip = ordersShipping[skuId];
    const actualShippingPerUnit = orderShip?.per_unit ?? null;

    // Derived metrics (销售额 / 销售成本 / 毛利润 / 毛利率) are now computed
    // by the sku_daily_with_activity view from these fact columns plus
    // sku_activity_price.活动价格. Migration 006 dropped the columns from
    // sku_daily_metrics — don't write them here.
    const row = {
      '日期': date,
      '店铺名称': shopName,
      '商品SPUID': spuId,
      skuId,
      'sku规格': skuSpec,
      '货号': extCode,
      '日常售价': dailyPrice != null ? Math.round(dailyPrice * 100) / 100 : null,
      '销售件数': salesQty,
      '成本价': costPrice != null ? Math.round(costPrice * 100) / 100 : null,
      '成本缺失': missingCost,
      '成本来源': costSource,
      '实际运费': actualShippingPerUnit,
    };
    rows.push(row);
  }
  return rows;
}

/**
 * Maps /mms/venom/api/supplier/sales/management/listOverall response →
 * rows aligned with duoshou-erp ShopSkuSnapshot table.
 *
 * Input rawItems = result.subOrderList[] — each item is a SPU with parent
 * fields (productId/productName/productSkcId) and skuQuantityDetailList[].
 * Output: one row per SKU (productSkuId).
 */
export function transformSales30dResponse(rawItems) {
  const rows = [];
  for (const item of rawItems) {
    const productName = item?.productName ?? null;
    const productSkcId = item?.productSkcId != null ? String(item.productSkcId) : null;
    const productId    = item?.productId    != null ? String(item.productId)    : null;
    const skus = Array.isArray(item?.skuQuantityDetailList) ? item.skuQuantityDetailList : [];

    for (const sku of skus) {
      if (sku?.productSkuId == null) continue;
      const inv = sku.inventoryNumInfo ?? {};
      rows.push({
        platformSkuId: String(sku.productSkuId),
        productName,
        className: sku.className ?? null,
        skuExtCode: sku.skuExtCode ?? null,

        todaySaleVolume: sku.todaySaleVolume ?? 0,
        sales7dVolume:   sku.lastSevenDaysSaleVolume ?? 0,
        sales30dVolume:  sku.lastThirtyDaysSaleVolume ?? 0,
        totalSaleVolume: sku.totalSaleVolume ?? 0,

        warehouseQty:    inv.warehouseInventoryNum ?? 0,
        waitReceiveQty:  inv.waitReceiveNum ?? 0,
        waitOnShelfQty:  inv.waitOnShelfNum ?? 0,
        waitDeliveryQty: inv.waitDeliveryInventoryNum ?? 0,

        // 平均日销 = 30d 销量 / 30(快算)
        avgDailySales: (sku.lastThirtyDaysSaleVolume ?? 0) / 30,
        // 可售天数(Temu 已算好)
        daysRemaining: sku.availableSaleDays ?? null,

        // supplierPrice 是分(CNY × 100)
        supplierPriceCents: typeof sku.supplierPrice === 'number' ? sku.supplierPrice : null,

        // 留 平台原对象用于后续扩展(如 purchase label / safe-inventory days)
        platformPayload: {
          sku,
          parent: { productId, productSkcId, productName },
        },
      });
    }
  }
  console.log(`[temu] transformSales30dResponse: ${rawItems.length} SPUs → ${rows.length} SKU rows`);
  return rows;
}

/**
 * Maps /api/kiana/magnus/mms/price-adjust/product-adjust-query response →
 * 一行 = 一个 (SPU × SKU) 调价/申报价记录。
 *
 * Sallfox 把这个 endpoint 命名为"申报价格"任务来源(见 Sallfox 接口盘点表
 * "Temu 调价单 magnus/mms/price-adjust/*",官方对应 bg.full.adjust.price.page.query)。
 *
 * 输入(推断,实测时按 result.list 兜底):每一条是一个 SPU 调价单,内含 skuList[]。
 * 输出字段尽量平铺关键价位 + 审核状态;原始 payload 保 platformPayload 留作 forensic。
 * 入库逻辑(后续 PR):
 *   - 设计 PriceReview / DeclaredPrice 表(候选 schema 见 README#TODO)
 *   - 落表前,raw rows 已经存进 agent_task.result(ingester 暂时 no-handler-yet)
 */
export function transformPriceAdjustResponse(rawItems) {
  const rows = [];
  for (const item of rawItems) {
    const productId    = item?.productId    != null ? String(item.productId)    : null;
    const productSkcId = item?.productSkcId != null ? String(item.productSkcId) : null;
    const productName  = item?.productName ?? null;
    const skus = Array.isArray(item?.skuList ?? item?.adjustSkuList ?? item?.skuAdjustList)
      ? (item.skuList ?? item.adjustSkuList ?? item.skuAdjustList)
      : [];

    // 没 SKU 子项时,把 SPU 自己作为一行(部分 endpoint 形态是 SPU-level 单价)
    if (skus.length === 0) {
      rows.push({
        platformSkuId:    null,
        platformProductId: productId,
        productSkcId,
        productName,
        skuExtCode:       item?.skuExtCode ?? item?.extCode ?? null,
        currency:         item?.currency ?? null,
        currentPriceCents:  item?.currentPrice  ?? item?.declaredPrice ?? item?.adjustPrice ?? null,
        previousPriceCents: item?.previousPrice ?? item?.beforePrice   ?? null,
        suggestPriceCents:  item?.suggestPrice  ?? null,
        adjustStatus:     item?.adjustStatus ?? item?.reviewStatus ?? item?.status ?? null,
        adjustReason:     item?.adjustReason ?? item?.reviewReason ?? null,
        submittedAt:      item?.submitTime ? new Date(item.submitTime).toISOString() : null,
        resolvedAt:       item?.resolveTime ?? item?.reviewTime ? new Date(item.resolveTime ?? item.reviewTime).toISOString() : null,
        platformPayload:  item,
      });
      continue;
    }

    for (const sku of skus) {
      rows.push({
        platformSkuId:     sku?.productSkuId != null ? String(sku.productSkuId) : null,
        platformProductId: productId,
        productSkcId,
        productName,
        skuExtCode:        sku?.skuExtCode ?? sku?.extCode ?? null,
        className:         sku?.className ?? null,
        currency:          sku?.currency ?? item?.currency ?? null,
        // Temu 金额都是 cents/分 — 不做单位换算,保原始 int
        currentPriceCents:  sku?.currentPrice  ?? sku?.declaredPrice ?? sku?.adjustPrice ?? null,
        previousPriceCents: sku?.previousPrice ?? sku?.beforePrice   ?? null,
        suggestPriceCents:  sku?.suggestPrice  ?? null,
        supplierPriceCents: sku?.supplierPrice ?? null,
        adjustStatus:      sku?.adjustStatus ?? sku?.reviewStatus ?? sku?.status ?? item?.status ?? null,
        adjustReason:      sku?.adjustReason ?? sku?.reviewReason ?? null,
        submittedAt:       sku?.submitTime ? new Date(sku.submitTime).toISOString() : null,
        resolvedAt:        (sku?.resolveTime ?? sku?.reviewTime) ? new Date(sku.resolveTime ?? sku.reviewTime).toISOString() : null,
        platformPayload:   { sku, parent: { productId, productSkcId, productName } },
      });
    }
  }
  console.log(`[temu] transformPriceAdjustResponse: ${rawItems.length} items → ${rows.length} rows`);
  return rows;
}

