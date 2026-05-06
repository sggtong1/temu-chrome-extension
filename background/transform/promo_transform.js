/**
 * Maps raw PROMO API response → ad_spend_daily rows.
 * Expected input: { result: { adDetailList: [{ ad_id, goods_id, spu_id, goods_title,
 *   ad_show_status, roas, reports_summary_dto: { ad_spend_all: {val}, ... } }] } }
 * Monetary values: val ÷ 100 = 元
 * Rates (ctr_all, cvr): val ÷ 100 = %
 * ROAS: ad.roas ÷ 10000
 */
export function transformPromoResponse(rawData, { shopName, date }) {
  // Diagnose response shape: try multiple list field names
  const result = rawData?.result;
  const adList = result?.ads_detail            // coconut/ads_report (current)
    ?? result?.adDetailList                    // legacy
    ?? result?.list
    ?? result?.dataList
    ?? result?.items
    ?? result?.adReportList
    ?? [];

  console.log('[temu] promo_transform: result keys:',
    result && typeof result === 'object' ? Object.keys(result) : typeof result,
    'adList len=', adList.length);
  if (adList.length > 0) {
    console.log('[temu] promo_transform: first ad keys:', Object.keys(adList[0]));
    console.log('[temu] promo_transform: first ad sample:', JSON.stringify(adList[0]).slice(0, 2000));
  }

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
      '每笔成交花费': Math.round(val('transaction_cost') / 100 * 10000) / 10000,
      '子订单量': Math.round(val('order_pay_cnt_all')),
      '件数': Math.round(val('goods_num')),
      '曝光量': Math.round(val('impr_cnt_all')),
      '点击量': Math.round(val('clk_cnt_all')),
      '点击率': Math.round(val('ctr_all') / 100 * 100) / 100,
      '转化率': Math.round(val('cvr') / 100 * 100) / 100,
      ROAS: ad.roas != null ? Math.round(ad.roas / 10000 * 100) / 100 : null,
    };
  });
}
