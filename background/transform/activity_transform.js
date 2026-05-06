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
// Extract SKU IDs from various nesting shapes that Temu uses across endpoints.
function _extractSkuIds(act) {
  if (Array.isArray(act.productSkuIds)) return act.productSkuIds;
  if (Array.isArray(act.skuIds))         return act.skuIds;
  const ids = [];
  for (const skc of (act.skcList ?? [])) {
    // Common nesting: skcList[i].skuList[j].{productSkuId|skuId}
    for (const sku of (skc.skuList ?? skc.productSkuList ?? [])) {
      const id = sku.productSkuId ?? sku.skuId ?? sku.id;
      if (id != null) ids.push(id);
    }
    // Or flat array of IDs on the SKC itself
    for (const id of (skc.productSkuIdList ?? skc.skuIdList ?? [])) ids.push(id);
    // Or single SKU directly on the SKC
    if (skc.productSkuId != null) ids.push(skc.productSkuId);
    else if (skc.skuId != null) ids.push(skc.skuId);
  }
  return ids;
}

// Pick the SKC's price/extCode if the activity-level fields are missing.
function _firstSkc(act) {
  const skcs = act.skcList ?? [];
  return skcs[0] ?? null;
}

export function transformActivityResponse(rawData, { shopName, startDate, endDate }) {
  const activities = rawData?.result?.list ?? [];

  if (activities.length > 0) {
    const a = activities[0];
    console.log('[temu] activity_transform: first activity keys:', Object.keys(a));
    console.log('[temu] activity_transform: first activity sample:', JSON.stringify(a).slice(0, 2000));
    if (Array.isArray(a.skcList) && a.skcList.length > 0) {
      console.log('[temu] activity_transform: skcList[0] keys:', Object.keys(a.skcList[0]));
      console.log('[temu] activity_transform: skcList[0] sample:', JSON.stringify(a.skcList[0]).slice(0, 2000));
    }
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
  let skippedNoId = 0, skippedNoSku = 0;

  for (const act of activities) {
    if (act.activityStock === 1) continue; // test/placeholder activity

    // Activity ID: enrollId is the unique participation record per shop+activity.
    const actId = act.enrollId ?? act.activityId ?? act.id ?? act.sessionId ?? null;
    if (actId == null) { skippedNoId++; continue; }

    const skuIds = _extractSkuIds(act);
    if (skuIds.length === 0) { skippedNoSku++; continue; }

    const skc        = _firstSkc(act) ?? {};
    const actPrice   = act.activityPrice ?? skc.activityPrice ?? 0;
    const dailyPrice = act.dailyPrice ?? act.supplierPrice ?? skc.supplierPrice ?? skc.dailyPrice ?? 0;
    const extCode    = act.extCode ?? act.skcExtCode ?? skc.extCode ?? skc.skcExtCode ?? '';
    const actName    = act.activityThematicName ?? act.activityName ?? act.name ?? '';
    const actType    = act.activityTypeName ?? act.activityType ?? '';
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

  if (skippedNoId)  console.warn(`[temu] activity_transform: skipped ${skippedNoId} entries with no enrollId`);
  if (skippedNoSku) console.warn(`[temu] activity_transform: skipped ${skippedNoSku} entries with no SKUs`);
  console.log(`[temu] activity_transform: ${activities.length} activities → ${rows.length} rows`);
  return rows;
}
