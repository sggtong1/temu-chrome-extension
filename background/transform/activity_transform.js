/**
 * Maps raw activity enroll/list API response → sku_activity_history rows.
 * API: /api/kiana/gamblers/marketing/enroll/list
 *
 * Queried once for the full date range. Each (activity × SKU) is expanded
 * into one row per day where:
 *   - the day is within the user's requested [startDate, endDate], AND
 *   - the day is within the activity's [actStart, actEnd] period (overlap)
 *
 * Same SKU on the same day participating in multiple activities yields
 * multiple rows. The sku_activity_price VIEW (defined in migration 003)
 * picks the lowest activity price per (date, shop, sku) automatically.
 *
 * Monetary values are in fen (÷100 = 元).
 */
export function transformActivityResponse(rawData, { shopName, startDate, endDate }) {
  const activities = rawData?.result?.list ?? [];

  if (activities.length > 0) {
    const a = activities[0];
    console.log('[temu] activity_transform: first activity keys:', Object.keys(a));
    console.log('[temu] activity_transform: first activity sample:', JSON.stringify(a).slice(0, 800));
  }

  // Build the requested date list (UTC to avoid local-tz shift)
  const dates = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const last = new Date(endDate + 'T00:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }

  const rows = [];
  let skipped = 0;

  for (const act of activities) {
    if (act.activityStock === 1) continue; // test/placeholder activity

    const actId = act.activityId ?? act.id ?? act.sessionId ?? null;
    if (actId == null) { skipped++; continue; }

    const skuIds     = act.productSkuIds ?? act.skuIds ?? [];
    const actPrice   = act.activityPrice ?? 0;
    const dailyPrice = act.dailyPrice ?? act.supplierPrice ?? 0;
    const extCode    = act.extCode ?? '';
    const actName    = act.activityName ?? act.name ?? '';
    const actType    = act.activityType ?? act.type ?? '';
    const startMs    = act.sessionStartTime ?? act.startTime ?? 0;
    const endMs      = act.sessionEndTime   ?? act.endTime   ?? 0;

    const actStart = startMs ? new Date(startMs).toISOString().slice(0, 10) : startDate;
    const actEnd   = endMs   ? new Date(endMs).toISOString().slice(0, 10)   : endDate;

    // Days that are in the user's range AND within the activity period.
    // Activities crossing the boundary contribute only their overlap days.
    const activeDates = dates.filter(d => d >= actStart && d <= actEnd);

    for (const skuId of skuIds) {
      const sku = String(skuId);
      for (const date of activeDates) {
        rows.push({
          '日期':         date,
          '店铺名称':     shopName,
          'sku_id':       sku,
          '活动ID':       actId,
          '活动名称':     actName,
          '活动类型':     actType || null,
          '活动价格':     Math.round(actPrice)   / 100,
          '日常价格':     Math.round(dailyPrice) / 100,
          'ext_code':     extCode,
          '活动开始时间': startMs ? new Date(startMs).toISOString() : null,
          '活动结束时间': endMs   ? new Date(endMs).toISOString()   : null,
        });
      }
    }
  }

  if (skipped) console.warn(`[temu] activity_transform: skipped ${skipped} entries with no activityId`);
  return rows;
}
