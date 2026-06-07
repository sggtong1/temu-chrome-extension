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

/**
 * Maps /api/seller/full/flow/analysis/goods/list response → 商品流量行。
 *
 * 接口路径:实测 /api/seller/full/flow/analysis/goods/list(非 Sallfox 文档简版)。
 *
 * 真字段名(2026-05-18 cesi 店实测,见 agent_task ac4e1bce 的 platformPayload):
 *   goodsId / productSpuId      商品 ID
 *   goodsName / goodsImageUrl   商品名 + 图
 *   exposeNum                   曝光量          ✱ 不带 ure
 *   clickNum                    点击量
 *   goodsDetailVisitorNum       访客数(进详情页 UV)
 *   goodsDetailVisitNum         浏览量(进详情页 PV)
 *   addToCartUserNum            加购人数        ✱ addToCart 中间有 To
 *   collectUserNum              收藏人数
 *   payGoodsNum                 支付件数        ✱ Temu 叫"goods"不叫 "item"
 *   payOrderNum                 支付订单数
 *   buyerNum                    买家数
 *   exposeClickConversionRate   曝光→点击 转化率(即"点击率")  ✱ 单位是小数 0-1
 *   clickPayConversionRate      点击→支付 转化率("点击后支付率")
 *   exposePayConversionRate     曝光→支付 转化率(综合"转化率")
 *   searchExposeNum/...         搜索的曝光/点击/订单/件数(同 payGoodsNum 模式)
 *   recommendExposeNum/...      推荐的曝光/点击/订单/件数
 *   bsrGoods/canContinueToGrow  增长潜力相关 boolean
 *   growDataText                "9%" 之类的增长文本
 *
 *   ★★ 关键发现:每个指标字段都有对应的 ${name}LinkRelative 字段表示**环比**
 *      (近 7 日 vs 上 7 日的小数变化,如 -0.154 = 下降 15.4%)。
 *      → Sallfox 显示的"环比 0.00% ↑↓"完全可以直接用这个,不用自己存历史快照表。
 */
export function transformFluxAnalysisResponse(rawItems, payload = {}) {
  const rows = [];
  const dateLabel = payload?.statisticType ?? 5;   // 默认 5=近7日(数字,保证 ingest Number.isFinite 通过)
  const region    = payload?.region ?? 'global';   // global / us / eu
  const snapshotDate = new Date().toISOString().slice(0, 10);

  // 宽容 picker:多 alias 取第一个非 null
  const makePick = (item) => (...keys) => {
    for (const k of keys) {
      const v = item?.[k];
      if (v != null) return v;
    }
    return null;
  };

  // Temu 的 conversionRate / clickRate 单位是小数(0.0667),前端展示要 %,所以 *100。
  const rate = (v) => (v == null ? null : Number(v) * 100);

  for (const item of rawItems) {
    // ★ 重要:Temu 有两个 ID
    //   - goodsId       平台 SPU 上架 ID(eg 601099540371116)— 详情页 / 公开外显
    //   - productSpuId  内部产品 SPU ID(eg 134255251)— sales-30d listOverall 用的 productId
    // 我们用 productSpuId 作 platformProductId,这样能和 shop_sku_snapshot.platform_payload.parent.productId
    // JOIN 上(后者也是 productSpuId 值);goodsId 保 platformPayload.goodsId 备用
    const platformProductId = String(
      item?.productSpuId ?? item?.productId ?? item?.goodsId ?? ''
    );
    if (!platformProductId) continue;

    const pick = makePick(item);

    // 提取所有指标的环比(LinkRelative),组装成 compareData object;
    // 都是 0-1 小数(Temu 已经算好了的 (now - prev) / prev),前端按需展示 ↑/↓%。
    const compareData = {
      exposureNum:        item?.exposeNumLinkRelative ?? null,
      clickNum:           item?.clickNumLinkRelative ?? null,
      visitorNum:         item?.goodsDetailVisitorNumLinkRelative ?? null,
      browseNum:          item?.goodsDetailVisitNumLinkRelative ?? null,
      addCartUserNum:     item?.addToCartUserNumLinkRelative ?? null,
      favoriteUserNum:    item?.collectUserNumLinkRelative ?? null,
      payItemNum:         item?.payGoodsNumLinkRelative ?? null,
      payOrderNum:        item?.payOrderNumLinkRelative ?? null,
      payBuyerNum:        item?.buyerNumLinkRelative ?? null,
      conversionRate:     item?.exposePayConversionRateLinkRelative ?? null,
      clickRate:          item?.exposeClickConversionRateLinkRelative ?? null,
      clickPayRate:       item?.clickPayConversionRateLinkRelative ?? null,
      searchExposureNum:  item?.searchExposeNumLinkRelative ?? null,
      searchClickNum:     item?.searchClickNumLinkRelative ?? null,
      searchPayOrderNum:  item?.searchPayOrderNumLinkRelative ?? null,
      searchPayItemNum:   item?.searchPayGoodsNumLinkRelative ?? null,
      recExposureNum:     item?.recommendExposeNumLinkRelative ?? null,
      recClickNum:        item?.recommendClickNumLinkRelative ?? null,
      recPayOrderNum:     item?.recommendPayOrderNumLinkRelative ?? null,
      recPayItemNum:      item?.recommendPayGoodsNumLinkRelative ?? null,
    };

    rows.push({
      // —— 商品信息
      platformProductId,
      platformSkcId:    item?.productSkcId != null ? String(item.productSkcId) : null,
      productName:      item?.goodsName ?? item?.productName ?? item?.title ?? null,
      pictureUrl:       item?.goodsImageUrl ?? item?.pictureUrl ?? item?.imageUrl ?? item?.mainImage ?? null,
      skuExtCode:       item?.skuExtCode ?? item?.extCode ?? null,
      categoryName:     item?.category?.name ?? item?.categoryName ?? null,
      siteId:           item?.siteId ?? null,
      siteName:         item?.siteName ?? null,
      // 周期标识 + 采集日期 + 区域(ingester 落 (shopId, platformProductId, region, statisticType, snapshotDate) 唯一键)
      statisticType:    dateLabel,
      snapshotDate,
      region,

      // —— 流量情况
      exposureNum:      pick('exposeNum', 'exposureNum', 'impressionNum', 'pv'),
      clickNum:         pick('clickNum', 'clk'),
      visitorNum:       pick('goodsDetailVisitorNum', 'visitorNum', 'uv'),
      browseNum:        pick('goodsDetailVisitNum', 'browseNum', 'viewNum'),
      addCartUserNum:   pick('addToCartUserNum', 'addCartUserNum', 'cartUserNum'),
      favoriteUserNum:  pick('collectUserNum', 'favoriteUserNum', 'collectNum'),

      // —— 支付情况
      payItemNum:       pick('payGoodsNum', 'payItemNum', 'salesItemNum', 'salesNum'),
      payOrderNum:      pick('payOrderNum', 'salesOrderNum', 'orderNum'),
      payBuyerNum:      pick('buyerNum', 'payBuyerNum'),

      // —— 转化情况(Temu 返小数 0-1,这里 ×100 转成 0-100 整数%)
      conversionRate:   rate(pick('exposePayConversionRate', 'conversionRate', 'payConvRate')),
      clickRate:        rate(pick('exposeClickConversionRate', 'clickRate', 'ctr')),
      clickPayRate:     rate(pick('clickPayConversionRate', 'clickPayRate', 'clickConvRate')),

      // —— 搜索数据
      searchExposureNum:  pick('searchExposeNum', 'searchExposureNum'),
      searchClickNum:     pick('searchClickNum'),
      searchPayOrderNum:  pick('searchPayOrderNum'),
      searchPayItemNum:   pick('searchPayGoodsNum', 'searchPayItemNum'),

      // —— 推荐数据
      recExposureNum:     pick('recommendExposeNum', 'recommendExposureNum', 'recExposureNum'),
      recClickNum:        pick('recommendClickNum', 'recClickNum'),
      recPayOrderNum:     pick('recommendPayOrderNum', 'recPayOrderNum'),
      recPayItemNum:      pick('recommendPayGoodsNum', 'recommendPayItemNum', 'recPayItemNum'),

      // —— 增长潜力 / 标签
      growthTagList: [
        ...(item?.bsrGoods ? ['BSR'] : []),
        ...(item?.canContinueToGrow ? ['可持续增长'] : []),
        ...(typeof item?.growDataText === 'string' && item.growDataText ? [item.growDataText] : []),
      ],

      // ★ 环比 — 各指标的环比变化(Temu 返的小数 (now-prev)/prev),前端直接用
      compareData,

      platformPayload:    item,  // 保 raw,后续字段扩展时方便对照
    });
  }
  console.log(`[temu] transformFluxAnalysisResponse: ${rawItems.length} items → ${rows.length} rows (statisticType=${dateLabel})`);
  return rows;
}

/**
 * Maps /api/seller/full/flow/analysis/goods/detail response → 每日真实数据明细行。
 *
 * 用法:plugin scrape:flux-analysis-detail 任务,payload 携带单个 productId,
 * detail 接口返回该 SPU 在指定窗口内每一天的明细数据。
 *
 * Detail response 字段(基于 list 模式 + 用户经验推测,实测后修正):
 *   - 顶层 result 可能是 array OR result.list OR result.dailyList
 *   - 每个元素:{ date(yyyy-mm-dd), exposeNum, clickNum, goodsDetailVisitorNum,
 *               addToCartUserNum, collectUserNum, payGoodsNum, payOrderNum,
 *               buyerNum, exposeClickConversionRate, clickPayConversionRate,
 *               exposePayConversionRate, ... }
 *   - 用户预判:detail **不返回** *LinkRelative 环比字段(环比由本地 SQL 聚合)
 *
 * 输出 dataSource='detail', reportDate=Temu 返的真实日期。
 */
export function transformFluxAnalysisDetailResponse(rawItems, payload = {}) {
  const rows = [];
  const region    = payload?.region ?? 'global';
  // ★ platformProductId 是 DB key — 用 productSpuId 跟 list 一致(可 JOIN snapshot.parent.productId)
  // goodsId 是 API body 用的(detail API 收 goodsId);二者不同,chain-trigger 同时传过来
  const platformProductId = String(payload?.productSpuId ?? payload?.productId ?? payload?.goodsId ?? '');
  if (!platformProductId) {
    console.warn('[temu] transformFluxAnalysisDetailResponse: missing payload productSpuId/productId/goodsId');
    return rows;
  }

  // 宽容 picker
  const makePick = (item) => (...keys) => {
    for (const k of keys) {
      const v = item?.[k];
      if (v != null) return v;
    }
    return null;
  };
  const rate = (v) => (v == null ? null : Number(v) * 100);

  // rawItems 可能是 result.list 或 result.dailyList 或直接 result(array)— 调度层用
  // listPath 选定后这里只看 item 内字段。
  for (const item of rawItems) {
    const pick = makePick(item);

    // ★ 实测真字段是 statDate(2026-05-18 实测)— 其他名字保留作 fallback
    const rawDate = item?.statDate ?? item?.date ?? item?.dataDate ?? item?.reportDate ?? null;
    if (!rawDate) continue;
    const reportDate = String(rawDate).match(/^\d{4}-\d{2}-\d{2}/)
      ? String(rawDate).slice(0, 10)
      : new Date(rawDate).toISOString().slice(0, 10);

    rows.push({
      // —— 标识
      platformProductId,
      productName:   payload?.productName ?? null,   // 头部复用 list,detail 不会再返
      pictureUrl:    payload?.pictureUrl ?? null,
      region,
      reportDate,
      dataSource:    'detail',
      statisticType: 1,    // detail 是按日,固定 1 (今日单点)

      // —— 流量
      exposureNum:      pick('exposeNum', 'exposureNum', 'impressionNum'),
      clickNum:         pick('clickNum', 'clk'),
      visitorNum:       pick('goodsDetailVisitorNum', 'visitorNum'),
      browseNum:        pick('goodsDetailVisitNum', 'browseNum'),
      addCartUserNum:   pick('addToCartUserNum', 'addCartUserNum'),
      favoriteUserNum:  pick('collectUserNum', 'favoriteUserNum'),

      // —— 支付
      payItemNum:       pick('payGoodsNum', 'payItemNum'),
      payOrderNum:      pick('payOrderNum'),
      payBuyerNum:      pick('buyerNum', 'payBuyerNum'),

      // —— 转化(同 list,×100 转 %)
      conversionRate:   rate(pick('exposePayConversionRate')),
      clickRate:        rate(pick('exposeClickConversionRate')),
      clickPayRate:     rate(pick('clickPayConversionRate')),

      // —— 搜索 / 推荐(detail 是否给这部分未知,先 try)
      searchExposureNum:  pick('searchExposeNum'),
      searchClickNum:     pick('searchClickNum'),
      searchPayOrderNum:  pick('searchPayOrderNum'),
      searchPayItemNum:   pick('searchPayGoodsNum'),
      recExposureNum:     pick('recommendExposeNum'),
      recClickNum:        pick('recommendClickNum'),
      recPayOrderNum:     pick('recommendPayOrderNum'),
      recPayItemNum:      pick('recommendPayGoodsNum'),

      // detail 不携带环比(用户预判) — service.query 时本地 SQL 聚合算
      compareData:      null,
      growthTagList:    null,
      platformPayload:  item,
    });
  }
  console.log(`[temu] transformFluxAnalysisDetailResponse: ${rawItems.length} day-rows for product ${platformProductId} region=${region}`);
  return rows;
}

// ────────────────────────────────────────────────────────────────────
// transformLifecycleResponse — 上新生命周期管理 / 价格申报中
// 数据来源:plugin scrape:lifecycle-management
//   POST /api/kiana/mms/robin/searchForChainSupplier
//   body: { pageSize, pageNum, removeStatus:0, supplierTodoTypeList:[1] }
//   (supplierTodoTypeList 1 = 价格申报中)
//
// 返回结构(2026-05-18 实测 cURL):
//   result.dataList[]: SPU 级,含 skcList[](SKC 级)
//   skcList[].skuList[]: SKU 级
//   skcList[].supplierPriceReviewInfoList[]: 价格审核记录(SKC 级,共享 SKC 内所有 SKU)
//     字段:supplyPrice / suggestSupplyPrice / priceOrderId / priceCurrency / status
//   单位:supplyPrice/suggestSupplyPrice 都是 cents (¥90.00 = 9000)
//
// 展开方式:1 个 SPU → N 个 SKC → M 个 SKU = N×M 行 PriceReview;
//          若 priceReviewInfo.siteList 含多站点,再 × 站点数。
//          当前 sample siteList=null,默认 siteId=-1(全局未分发到具体站点)。
// ────────────────────────────────────────────────────────────────────
export function transformLifecycleResponse(rawItems, payload = {}) {
  const rows = [];
  const supplierTodoType = (payload?.supplierTodoTypeList?.[0]) ?? 1;

  // status 映射:supplierPriceReviewInfoList[].status → PriceReview.status
  // (sample 只见到 status=1;其他 code 待实测,fallback 到 pending)
  const STATUS_MAP = {
    1: 'pending',
    // 后续实测:2=submitted / 3=approved / 4=rejected / etc.
  };
  const mapStatus = (s) => STATUS_MAP[Number(s)] ?? 'pending';

  for (const spu of rawItems) {
    const productId = spu?.productId != null ? String(spu.productId) : null;
    if (!productId) continue;

    const carouselFirst = Array.isArray(spu?.carouselImageUrlList) ? spu.carouselImageUrlList[0] : null;
    const fullCat = Array.isArray(spu?.fullCategoryName) ? spu.fullCategoryName.join(' / ') : (spu?.leafCategoryName ?? null);
    const spuAttrs = Array.isArray(spu?.productPropertyList) ? spu.productPropertyList : [];

    // 拼 attributes:SPU 通用属性 + SKU 颜色等独有属性(后置覆盖)
    const spuAttrsObj = {};
    for (const p of spuAttrs) {
      if (p?.name) spuAttrsObj[String(p.name)] = String(p.value ?? '');
    }

    const skcList = Array.isArray(spu?.skcList) ? spu.skcList : [];
    for (const skc of skcList) {
      const skcId = skc?.skcId != null ? String(skc.skcId) : null;
      const skcPreview = Array.isArray(skc?.previewImgUrlList) ? skc.previewImgUrlList[0] : null;
      const statusTime = skc?.statusTime ?? {};

      const priceReviewList = Array.isArray(skc?.supplierPriceReviewInfoList) ? skc.supplierPriceReviewInfoList : [];
      // 没有审核记录 → 这个 SKC 不在"价格申报中",跳过(supplierTodoTypeList 已过滤,理论上不会)
      if (priceReviewList.length === 0) continue;

      const skuList = Array.isArray(skc?.skuList) ? skc.skuList : [];
      for (const sku of skuList) {
        const skuId = sku?.skuId != null ? String(sku.skuId) : null;
        if (!skuId) continue;

        const skuAttrs = Array.isArray(sku?.productPropertyList) ? sku.productPropertyList : [];
        const attrsObj = { ...spuAttrsObj };
        for (const p of skuAttrs) {
          if (p?.name) attrsObj[String(p.name)] = String(p.value ?? '');
        }
        const skuExtCode = sku?.extCode || skc?.extCode || null;

        // 每个 priceReviewInfo 是一条核价记录(times 区分轮次,通常只看最新一条)
        // 也展开 siteList — siteList=null 时默认 siteId=-1(全局,未分发到具体站点)
        for (const review of priceReviewList) {
          const orderId = review?.priceOrderId != null ? String(review.priceOrderId) : null;
          const siteList = Array.isArray(review?.siteList) && review.siteList.length > 0
            ? review.siteList
            : [{ siteId: -1, siteName: null }];

          for (const site of siteList) {
            rows.push({
              // —— 标识
              platformProductId: productId,
              platformSkcId:     skcId,
              platformSkuId:     skuId,
              skuExtCode,
              productName:       spu?.productName ?? null,
              pictureUrl:        sku?.skuPreviewImage || skcPreview || carouselFirst || null,
              categoryName:      fullCat,
              attributes:        attrsObj,

              // —— 站点
              siteId:            Number(site?.siteId ?? -1),
              siteName:          site?.siteName ?? null,

              // —— 价格(cents,Temu 端已经是 cents 单位)
              originalPriceCents: review?.supplyPrice != null ? Number(review.supplyPrice) : (sku?.supplierPriceValue ?? null),
              refPriceCents:      review?.suggestSupplyPrice != null ? Number(review.suggestSupplyPrice) : null,
              newPriceCents:      null,    // 用户填,初始空
              minReviewPriceCents: null,   // 来自 SkuCostProfile,server ingester JOIN 时填
              activityDiscount:   null,    // 来自 SkuCostProfile
              currency:           review?.priceCurrency || sku?.supplierPriceCurrencyType || 'CNY',

              // —— 状态
              status:             mapStatus(review?.status),
              rejectReason:       null,

              // —— 调价工单
              platformOrderId:    orderId,

              // —— 时间(epoch ms → ISO string)
              createdAtRemote:    statusTime?.createdTime ? new Date(statusTime.createdTime).toISOString() : null,
              priceConfirmedAt:   statusTime?.priceVerificationTime ? new Date(statusTime.priceVerificationTime).toISOString() : null,
              addedToSiteAt:      statusTime?.addedToSiteTime ? new Date(statusTime.addedToSiteTime).toISOString() : null,
              removedFromSiteAt:  statusTime?.unPublishedTime ? new Date(statusTime.unPublishedTime).toISOString() : null,
              deadlineAt:         review?.remainedSeconds != null ? new Date(Date.now() + review.remainedSeconds * 1000).toISOString() : null,

              platformPayload:    { sku, review },   // 只保 SKU+review 级 raw,SPU 级太大
            });
          }
        }
      }
    }
  }

  console.log(`[temu] transformLifecycleResponse: ${rawItems.length} SPU → ${rows.length} PriceReview rows (todoType=${supplierTodoType})`);
  return rows;
}
