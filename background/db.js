// HTTP client for the local Postgres data store (via PostgREST in front of
// mini-postgres). Replaces the previous Supabase-based code; the API surface
// is identical because Supabase is itself a PostgREST wrapper.
//
// Default URL: http://localhost:3003 (the PostgREST container started in
// docker-compose / scripts/start-api.sh). User can override via options page.
//
// Auth: in local dev we run PostgREST with PGRST_DB_ANON_ROLE=admin (no JWT
// required), so requests do NOT need apikey / Authorization headers. If you
// later put this behind a JWT-protected PostgREST, add an apiKey arg and
// re-introduce the headers — the rest of the API surface stays the same.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * GET rows from a table.
 * qs: raw query string (NOT URLSearchParams — keeps `in.(...)` filter values
 * unescaped, matching PostgREST's expectations).
 */
export async function dbGet(apiUrl, table, qs = '') {
  const sep = qs ? '?' : '';
  const resp = await fetch(`${apiUrl}/${table}${sep}${qs}`);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DB GET ${table} ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Upsert rows into a table.
 * @param onConflict optional comma-separated column list. Required when the
 *   natural unique key is a UNIQUE constraint rather than the PK — without
 *   it PostgREST tries to merge by PK, can't find a row (id is auto-genned),
 *   then INSERT violates the UNIQUE → HTTP 409.
 */
export async function dbUpsert(apiUrl, table, rows, onConflict) {
  if (!rows.length) return { count: 0, error: null };
  const qs = onConflict
    ? `?on_conflict=${onConflict.split(',').map(c => encodeURIComponent(c.trim())).join(',')}`
    : '';
  const resp = await fetch(`${apiUrl}/${table}${qs}`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
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

/**
 * Returns { 货号: [cost_price, shipping_cost] } for given extCode list.
 * Queries sku_cost where sku_id = 货号 (extCode), effective_from <= date,
 * and (effective_to IS NULL OR effective_to > date).
 * Prefers rows where platform matches siteType; falls back to platform=null.
 */
export async function getSkuCost(apiUrl, extCodes, date, siteType) {
  if (!extCodes.length) return {};
  const inList = extCodes.join(',');
  const rows = await dbGet(
    apiUrl, 'sku_cost',
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
