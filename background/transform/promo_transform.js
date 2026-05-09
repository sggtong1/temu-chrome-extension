/**
 * Maps raw PROMO API response → ad_spend_daily rows.
 *
 * 服务端有两种结构, 兼容读取:
 *   - 新结构: ad.summary.{key}.{total|ad|net_ad|net_total}.val
 *     e.g. ad.summary.spend.total.val=20473 → trans_val "￥204.73" → val÷100=元
 *   - 旧结构: ad.reports_summary_dto.{key}_all.val
 *     e.g. rsd.ad_spend_all.val=20473 → trans_val "￥204.73" → val÷100=元
 *
 * 都读 'total' 维度 (店铺总), 跟旧逻辑里 *_all 的口径一致;
 * 'ad' 维度是广告归因 (常为 0), 不在这里写.
 *
 * 标度:
 *   金额类 (spend / transaction_cost): val÷100 = 元
 *   计数类 (order_pay_cnt / goods_num / impr_cnt / clk_cnt): val 原值
 *   百分率 (ctr / cvr): val÷100 = %
 *   ROAS: val÷1000 (注意: 不是÷10000, 跟 ad 顶层的 roas 字段口径不同)
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

  return adList.map(ad => {
    const summary = ad.summary ?? null;
    const rsd     = ad.reports_summary_dto ?? null;

    // 新结构: 读 summary.{key}.total.val; 旧结构: 读 rsd.{oldKey}.val
    const val = (newKey, oldKey) => {
      if (summary) return summary[newKey]?.total?.val ?? 0;
      if (rsd)     return rsd[oldKey]?.val ?? rsd[oldKey] ?? 0;
      return 0;
    };

    // ROAS 在两种结构下 key 名不同, 单独取.
    // summary/rsd 都没有时 fallback 到顶层 ad.roas (不同口径: ÷10000 而非 ÷1000)
    const roasFromSummary = summary?.roas?.total?.val ?? null;
    const roasFromRsd     = rsd?.roas_all?.val ?? null;
    const roasFromTop     = ad.roas != null ? ad.roas / 10 : null; // ÷10 把 /10000 标度对齐到 /1000

    return {
      '日期': date,
      '店铺名称': shopName,
      '平台': 'temu',
      ad_id: String(ad.ad_id ?? ''),
      '商品id': String(ad.goods_id ?? ''),
      '商品spuid': String(ad.spu_id ?? ''),
      '商品名称': ad.goods_title ?? '',
      '投放状态': ad.ad_show_status ?? null,
      '总花费':       Math.round(val('spend',            'ad_spend_all')        / 100  * 100) / 100,
      '每笔成交花费': Math.round(val('transaction_cost', 'transaction_cost')    / 100  * 100) / 100,
      '子订单量':     Math.round(val('order_pay_cnt',    'order_pay_cnt_all')),
      '件数':         Math.round(val('goods_num',        'goods_num')),
      '曝光量':       Math.round(val('impr_cnt',         'impr_cnt_all')),
      '点击量':       Math.round(val('clk_cnt',          'clk_cnt_all')),
      '点击率':       Math.round(val('ctr',              'ctr_all')             / 100  * 100) / 100,
      '转化率':       Math.round(val('cvr',              'cvr')                 / 100  * 100) / 100,
      ROAS:           (() => {
        const v = roasFromSummary ?? roasFromRsd ?? roasFromTop;
        return v != null ? Math.round(v / 1000 * 100) / 100 : null;
      })(),
    };
  });
}
