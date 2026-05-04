export function makeHeaders(anonKey) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * GET rows from a Supabase table.
 * qs: raw query string (NOT URLSearchParams — avoids encoding in.(...) filter values).
 */
export async function supabaseGet(supabaseUrl, anonKey, table, qs = '') {
  const sep = qs ? '?' : '';
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}${sep}${qs}`, {
    headers: makeHeaders(anonKey),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Supabase GET ${table} ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Upsert rows into a Supabase table.
 * Returns { count, error } where error is null on success.
 */
export async function supabaseUpsert(supabaseUrl, anonKey, table, rows) {
  if (!rows.length) return { count: 0, error: null };
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...makeHeaders(anonKey),
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return { count: 0, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { count: rows.length, error: null };
}

/** Look up a shop by mallId. Returns null if not found. */
export async function getShopByMallId(supabaseUrl, anonKey, mallId) {
  const rows = await supabaseGet(
    supabaseUrl, anonKey, 'shops',
    `mall_id=eq.${mallId}&select=shop_name,site_type,mall_id`
  );
  return rows[0] || null;
}

/**
 * Returns { 货号: [cost_price, shipping_cost] } for given extCode list.
 * Queries sku_cost table where sku_id = 货号 (extCode).
 * Prefers rows where platform matches siteType; falls back to platform=null rows.
 */
export async function getSkuCost(supabaseUrl, anonKey, extCodes, date, siteType) {
  if (!extCodes.length) return {};
  const inList = extCodes.join(',');
  const rows = await supabaseGet(
    supabaseUrl, anonKey, 'sku_cost',
    `sku_id=in.(${inList})&effective_from=lte.${date}&select=sku_id,cost_price,shipping_cost,platform,effective_from,effective_to`
  );
  const result = {};
  for (const r of rows) {
    if (r.effective_to && r.effective_to <= date) continue;
    const key = r.sku_id;
    const incoming = [parseFloat(r.cost_price), parseFloat(r.shipping_cost || 0), r.platform];
    if (!result[key]) {
      result[key] = incoming;
    } else if (siteType && r.platform === siteType && result[key][2] !== siteType) {
      result[key] = incoming;
    }
  }
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, [v[0], v[1]]]));
}
