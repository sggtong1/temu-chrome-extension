/**
 * Maps raw PROMO API response → ad_spend_daily rows.
 * Expected input: { result: { adDetailList: [{ ad_id, goods_id, spu_id, goods_title,
 *   ad_show_status, roas, reports_summary_dto: { ad_spend_all: {val}, ... } }] } }
 * Monetary values: val ÷ 100 = 元
 * Rates (ctr_all, cvr): val ÷ 100 = %
 * ROAS: ad.roas ÷ 10000
 */
export function transformPromoResponse(rawData, { shopName, date }) {
  // ads_detail is the field used by /api/v1/coconut/ad/ads_report.
  // Fallbacks kept for older deployments / different endpoints.
  const result = rawData?.result;
  const adList = result?.ads_detail
    ?? result?.adDetailList
    ?? result?.list
    ?? result?.dataList
    ?? result?.items
    ?? result?.adReportList
    ?? [];

  // Store-wide summary (same shape as per-ad reports_summary_dto, aggregated
  // across all ads in the result set — i.e. the user's date-range filter).
  const summary = result?.reports_summary ?? {};
  if (Object.keys(summary).length > 0) {
    console.log('[temu] promo_transform: reports_summary keys:', Object.keys(summary));
  }
  const sumVal = key => (summary[key]?.val ?? null);

  // Store ACOS (费比) and store transaction_cost (每笔成交花费) — these go on
  // every row since they describe the whole shop's totals, not per-ad.
  const store_费比 = sumVal('acos_all') != null ? Math.round(sumVal('acos_all') / 100 * 100) / 100 : null;
  const store_每笔成交花费 = sumVal('transaction_cost') != null ? Math.round(sumVal('transaction_cost') / 100 * 100) / 100 : null;

  return adList.map(ad => {
    const rsd = ad.reports_summary_dto ?? {};
    const val = key => (rsd[key]?.val ?? rsd[key] ?? 0);

    return {
      '日期': date,
      '店铺名称': shopName,
      '平台': 'temu',
      ad_id: String(ad.ad_id ?? ''),
      '商品id': String(ad.goods_id ?? ''),
      '商品spuid': String(ad.spu_id ?? ''),
      '商品名称': ad.goods_title ?? '',
      '投放状态': ad.ad_show_status ?? null,
      '总花费': Math.round(val('ad_spend_all') / 100 * 100) / 100,
      '每笔成交花费': Math.round(val('transaction_cost') / 100 * 100) / 100,
      '子订单量': Math.round(val('order_pay_cnt_all')),
      '件数': Math.round(val('goods_num')),
      '曝光量': Math.round(val('impr_cnt_all')),
      '点击量': Math.round(val('clk_cnt_all')),
      '点击率': Math.round(val('ctr_all') / 100 * 100) / 100,
      '转化率': Math.round(val('cvr') / 100 * 100) / 100,
      // 费比 (per-ad ACOS) = ad_spend / sales_amount; val is in 1/100 percent
      '费比': val('acos_all') != null ? Math.round(val('acos_all') / 100 * 100) / 100 : null,
      // ROAS comes from reports_summary_dto.roas_all (val/1000 = displayed
      // ratio). The top-level ad.roas field is something else (possibly a
      // long-window aggregate) and doesn't match what the UI shows.
      ROAS: rsd.roas_all?.val != null ? Math.round(rsd.roas_all.val / 1000 * 100) / 100 : null,
      // Store-wide metrics duplicated on each row (for convenient JOINs)
      '费比_全店': store_费比,
      '每笔成交花费_全店': store_每笔成交花费,
    };
  });
}
