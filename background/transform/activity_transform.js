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
// Extract per-SKU records (skuId + price + extCode) from various nesting shapes.
// Real Temu enroll/list response: prices live on each SKU inside skcList[].skuList[]
// (activity-level and SKC-level activityPrice/dailyPrice are null).
function _extractSkuRecords(act) {
  // Legacy fallback: flat array of IDs at activity level (then prices come from act)
  if (Array.isArray(act.productSkuIds)) {
    return act.productSkuIds.map(id => ({
      skuId: id,
      activityPrice: act.activityPrice ?? null,
      dailyPrice: act.dailyPrice ?? act.supplierPrice ?? null,
      extCode: act.extCode ?? '',
    }));
  }
  if (Array.isArray(act.skuIds)) {
    return act.skuIds.map(id => ({
      skuId: id,
      activityPrice: act.activityPrice ?? null,
      dailyPrice: act.dailyPrice ?? null,
      extCode: act.extCode ?? '',
    }));
  }

  // Nested form: skcList[].skuList[] with per-SKU prices
  const records = [];
  for (const skc of (act.skcList ?? [])) {
    for (const sku of (skc.skuList ?? skc.productSkuList ?? [])) {
      const id = sku.skuId ?? sku.productSkuId ?? sku.id;
      if (id == null) continue;
      records.push({
        skuId: id,
        // Per-SKU prices first; SKC then activity as fallback
        activityPrice: sku.activityPrice ?? skc.activityPrice ?? act.activityPrice ?? null,
        dailyPrice:    sku.dailyPrice    ?? skc.dailyPrice    ?? act.dailyPrice    ?? null,
        extCode:       sku.extCode       ?? skc.extCode       ?? act.extCode       ?? '',
      });
    }
    // Also handle SKCs that expose flat ID arrays without skuList
    for (const id of (skc.productSkuIdList ?? skc.skuIdList ?? [])) {
      records.push({
        skuId: id,
        activityPrice: skc.activityPrice ?? act.activityPrice ?? null,
        dailyPrice:    skc.dailyPrice    ?? act.dailyPrice    ?? null,
        extCode:       skc.extCode       ?? act.extCode       ?? '',
      });
    }
  }
  return records;
}

export function transformActivityResponse(rawData, { shopName, startDate, endDate }) {
  const activities = rawData?.result?.list ?? [];


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

    const skuRecords = _extractSkuRecords(act);
    if (skuRecords.length === 0) { skippedNoSku++; continue; }

    // Activity-level metadata. activityThematicName may be null (not all
    // activities are 专题); fall back to product-level name then to type label.
    const actName  = act.activityThematicName || act.activityTypeName || act.productName || '';
    const actType  = act.activityTypeName ?? '';
    const startMs  = act.sessionStartTime ?? act.startTime ?? 0;
    const endMs    = act.sessionEndTime   ?? act.endTime   ?? 0;

    const actStart = startMs ? new Date(startMs).toISOString().slice(0, 10) : startDate;
    const actEnd   = endMs   ? new Date(endMs).toISOString().slice(0, 10)   : endDate;

    // Days that are in the user's range AND within the activity period.
    // Activities crossing the boundary contribute only their overlap days.
    const activeDates = dates.filter(d => d >= actStart && d <= actEnd);

    for (const rec of skuRecords) {
      const sku = String(rec.skuId);
      for (const date of activeDates) {
        rows.push({
          '日期':         date,
          '店铺名称':     shopName,
          'sku_id':       sku,
          '活动ID':       actId,
          '活动名称':     actName || null,
          '活动类型':     actType || null,
          '活动价格':     rec.activityPrice != null ? Math.round(rec.activityPrice) / 100 : null,
          '日常价格':     rec.dailyPrice    != null ? Math.round(rec.dailyPrice)    / 100 : null,
          'ext_code':     rec.extCode || '',
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
