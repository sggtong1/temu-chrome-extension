/**
 * Maps raw activity enroll/list API response → sku_activity_price rows.
 * API: /api/kiana/gamblers/marketing/enroll/list
 * Queried once for the full date range; each activity is expanded into one row
 * per day it is active within [startDate, endDate], so joins with
 * sku_daily_metrics work correctly.
 * Monetary values are in fen (÷100 = 元).
 */
export function transformActivityResponse(rawData, { shopName, startDate, endDate }) {
  const activities = rawData?.result?.list ?? [];

  // Build the requested date list using UTC to avoid local-timezone shift
  const dates = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const last = new Date(endDate + 'T00:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }

  // (date|skuId) → best row (lowest activity price wins when SKU in multiple activities)
  const best = new Map();

  for (const act of activities) {
    if (act.activityStock === 1) continue; // test/placeholder activity

    const skuIds     = act.productSkuIds ?? act.skuIds ?? [];
    const actPrice   = act.activityPrice ?? 0;
    const dailyPrice = act.dailyPrice ?? act.supplierPrice ?? 0;
    const extCode    = act.extCode ?? '';
    const actName    = act.activityName ?? act.name ?? '';
    const startMs    = act.sessionStartTime ?? act.startTime ?? 0;
    const endMs      = act.sessionEndTime   ?? act.endTime   ?? 0;

    const actStart = startMs ? new Date(startMs).toISOString().slice(0, 10) : startDate;
    const actEnd   = endMs   ? new Date(endMs).toISOString().slice(0, 10)   : endDate;

    // Only days within the requested range where the activity is active
    const activeDates = dates.filter(d => d >= actStart && d <= actEnd);

    for (const skuId of skuIds) {
      const sku = String(skuId);
      for (const date of activeDates) {
        const key = `${date}|${sku}`;
        const row = {
          '日期':         date,
          '店铺名称':     shopName,
          'sku_id':       sku,
          '活动名称':     actName,
          '活动价格':     Math.round(actPrice)   / 100,
          '日常价格':     Math.round(dailyPrice) / 100,
          'ext_code':     extCode,
          '活动开始时间': startMs ? new Date(startMs).toISOString() : null,
          '活动结束时间': endMs   ? new Date(endMs).toISOString()   : null,
        };
        const existing = best.get(key);
        if (!existing || row['活动价格'] < existing['活动价格']) {
          best.set(key, row);
        }
      }
    }
  }

  return [...best.values()];
}
