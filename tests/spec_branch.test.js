/**
 * spec_branch.test.js
 * 验证 KIND_TO_FETCH_SPEC 中 4 个 scrape:* 的 pageUrl / apiUrlPattern
 * 在 full(全托) 和 semi(半托) 两个分支下返回正确值。
 */
import { describe, test, expect, beforeAll } from '@jest/globals';

// agent.js 顶层会访问 chrome.storage / chrome.alarms 等全局 API,需先 mock
globalThis.chrome = {
  storage: {
    session: {
      get: () => Promise.resolve({}),
      set:  () => {},
    },
    local: {
      get: () => Promise.resolve({}),
      set: () => {},
    },
  },
  alarms: {
    create:      () => {},
    getAll:      (cb) => cb && cb([]),
    onAlarm:     { addListener: () => {} },
  },
  runtime: {
    onMessage:   { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    id: 'test-extension-id',
  },
  tabs: {
    create:  () => Promise.resolve({ id: 1 }),
    remove:  () => Promise.resolve(),
    onRemoved: { addListener: () => {} },
  },
};

const { KIND_TO_FETCH_SPEC } = await import('../background/agent.js');

const fullPayload = { shopType: 'full', mallId: '123456789012345' };
const semiPayload = { shopType: 'semi', mallId: '987654321098765' };

// ── scrape:marketing-activity ─────────────────────────────────────
describe('scrape:marketing-activity', () => {
  const spec = KIND_TO_FETCH_SPEC['scrape:marketing-activity'];

  test('full → agentseller.temu.com pageUrl', () => {
    expect(spec.pageUrl(fullPayload)).toBe('https://agentseller.temu.com/activity/marketing-activity');
  });

  test('semi → seller.kuajingmaihuo.com pageUrl', () => {
    expect(spec.pageUrl(semiPayload)).toBe('https://seller.kuajingmaihuo.com/activity/marketing-activity');
  });

  test('full apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(fullPayload)).toBe('/api/kiana/gamblers/marketing/enroll/activity/list');
  });

  test('semi apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(semiPayload)).toBe('/api/kiana/gamblers/marketing/enroll/activity/list');
  });
});

// ── scrape:activity-data ──────────────────────────────────────────
describe('scrape:activity-data', () => {
  const spec = KIND_TO_FETCH_SPEC['scrape:activity-data'];

  test('full → agentseller.temu.com/log pageUrl', () => {
    expect(spec.pageUrl(fullPayload)).toBe('https://agentseller.temu.com/activity/marketing-activity/log');
  });

  test('semi → seller.kuajingmaihuo.com/log pageUrl', () => {
    expect(spec.pageUrl(semiPayload)).toBe('https://seller.kuajingmaihuo.com/activity/marketing-activity/log');
  });

  test('full apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(fullPayload)).toBe('/api/kiana/gamblers/marketing/enroll/list');
  });

  test('semi apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(semiPayload)).toBe('/api/kiana/gamblers/marketing/enroll/list');
  });
});

// ── scrape:lifecycle-management ───────────────────────────────────
describe('scrape:lifecycle-management', () => {
  const spec = KIND_TO_FETCH_SPEC['scrape:lifecycle-management'];

  test('full → agentseller.temu.com pageUrl', () => {
    expect(spec.pageUrl(fullPayload)).toBe('https://agentseller.temu.com/newon/product-select');
  });

  test('semi → seller.kuajingmaihuo.com pageUrl', () => {
    expect(spec.pageUrl(semiPayload)).toBe('https://seller.kuajingmaihuo.com/newon/product-select');
  });

  test('full apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(fullPayload)).toBe('/api/kiana/mms/robin/searchForChainSupplier');
  });

  test('semi apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(semiPayload)).toBe('/api/kiana/mms/robin/searchForChainSupplier');
  });
});

// ── scrape:declared-price ─────────────────────────────────────────
describe('scrape:declared-price', () => {
  const spec = KIND_TO_FETCH_SPEC['scrape:declared-price'];

  test('full → agentseller.temu.com pageUrl', () => {
    expect(spec.pageUrl(fullPayload)).toBe('https://agentseller.temu.com/price-management/price-adjust');
  });

  test('semi → seller.kuajingmaihuo.com/declared-price pageUrl', () => {
    expect(spec.pageUrl(semiPayload)).toBe('https://seller.kuajingmaihuo.com/price-management/declared-price');
  });

  test('full apiUrlPattern → magnus price-adjust path', () => {
    expect(spec.apiUrlPattern(fullPayload)).toBe('/api/kiana/magnus/mms/price-adjust/product-adjust-query');
  });

  test('semi apiUrlPattern → robin queryProductSkuPriceAndStatus', () => {
    expect(spec.apiUrlPattern(semiPayload)).toBe('/api/kiana/mms/robin/queryProductSkuPriceAndStatus');
  });
});

// ── siteType compat (popup vocabulary) ───────────────────────────
describe('siteType compat — popup 派任务用 siteType 字段', () => {
  test('scrape:sales-30d siteType=semi (popup vocabulary) → 数据中心 sale/analysis/detail', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
    // 半托走数据中心「商品数据」页(按 region 选 agentseller host),endpoint /api/sale/analysis/detail
    const url = spec.pageUrl({ siteType: 'semi' });
    const api = spec.apiUrlPattern({ siteType: 'semi' });
    expect(url).toContain('agentseller.temu.com');
    expect(url).toContain('/main/data-center/goods-data');
    expect(api).toBe('/api/sale/analysis/detail');
  });

  test('scrape:sales-30d siteType=semi → 销量 host 固定主域,不分 region', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
    // 销量 detail 只在主域,与 payload.region 无关(流量才分区)
    expect(spec.pageUrl({ siteType: 'semi', region: 'us' })).toContain('agentseller.temu.com');
    expect(spec.pageUrl({ siteType: 'semi', region: 'us' })).not.toContain('agentseller-us');
    expect(spec.pageUrl({ siteType: 'semi', region: 'pa' })).toContain('agentseller.temu.com');
    expect(spec.pageUrl({ siteType: 'semi' })).toContain('agentseller.temu.com');
  });

  test('scrape:sales-30d semi body = { timeType } + pageNum/pageSize 分页(实测 body shape)', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
    const p = { siteType: 'semi' };
    expect(spec.buildBody(p)).toEqual({ timeType: 4 });
    expect(spec.pageNoKey(p)).toBe('pageNum');
    expect(spec.pageSizeKey(p)).toBe('pageSize');
    expect(spec.pageSize(p)).toBe(30);
    // payload.timeType 可覆盖默认 4
    expect(spec.buildBody({ siteType: 'semi', timeType: 2 })).toEqual({ timeType: 2 });
  });

  test('scrape:sales-30d full → listOverall(销售管理页,不受半托改动影响)', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:sales-30d'];
    expect(spec.apiUrlPattern({ shopType: 'full' })).toBe('/mms/venom/api/supplier/sales/management/listOverall');
    expect(spec.pageUrl({ shopType: 'full' })).toContain('/stock/fully-mgt/sale-manage/main');
  });

  test('scrape:declared-price siteType=semi → robin namespace URL', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:declared-price'];
    const api = spec.apiUrlPattern({ siteType: 'semi' });
    expect(api).toBe('/api/kiana/mms/robin/queryProductSkuPriceAndStatus');
  });

  test('scrape:marketing-activity siteType=semi → semi host', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:marketing-activity'];
    expect(spec.pageUrl({ siteType: 'semi' })).toContain('seller.kuajingmaihuo.com');
  });

  test('scrape:declared-price full → unchanged price-adjust path', () => {
    const spec = KIND_TO_FETCH_SPEC['scrape:declared-price'];
    const api = spec.apiUrlPattern({ shopType: 'full' });
    expect(api).toBe('/api/kiana/magnus/mms/price-adjust/product-adjust-query');
  });
});
