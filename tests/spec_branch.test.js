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

  test('semi → seller.kuajingmaihuo.com pageUrl', () => {
    expect(spec.pageUrl(semiPayload)).toBe('https://seller.kuajingmaihuo.com/price-management/price-adjust');
  });

  test('full apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(fullPayload)).toBe('/api/kiana/magnus/mms/price-adjust/product-adjust-query');
  });

  test('semi apiUrlPattern unchanged', () => {
    expect(spec.apiUrlPattern(semiPayload)).toBe('/api/kiana/magnus/mms/price-adjust/product-adjust-query');
  });
});
