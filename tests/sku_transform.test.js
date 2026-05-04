import { describe, it, expect } from '@jest/globals';
import { parseSalesResponse, parseOrdersResponse, buildSkuRows } from '../background/transform/sku_transform.js';

describe('parseSalesResponse — semi_us', () => {
  const ctx = { siteType: 'semi_us', date: '2026-05-03' };

  it('extracts sku sales and extCode from saleAnalysisDetailDTOList', () => {
    const raw = {
      result: {
        saleAnalysisDetailDTOList: [
          {
            productSkuId: 111,
            productId: 999,
            skuExtCode: 'ABC-01',
            skuSaleDTOList: [
              { date: '2026-05-02', saleNum: 3 },
              { date: '2026-05-03', saleNum: 10 },
            ],
          },
        ],
      },
    };
    const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(raw, ctx);
    expect(skuSales['111']).toBe(10);
    expect(skuPrices['111'].activityPrice).toBeNull();   // not in this API
    expect(skuPrices['111'].dailyPrice).toBeNull();
    expect(skuPrices['111'].extCode).toBe('ABC-01');
    expect(skuSpuMap['111']).toBe('999');
  });

  it('uses 0 when target date is absent from skuSaleDTOList', () => {
    const raw = {
      result: {
        saleAnalysisDetailDTOList: [
          { productSkuId: 111, skuExtCode: 'X', skuSaleDTOList: [{ date: '2026-05-01', saleNum: 5 }] },
        ],
      },
    };
    const { skuSales } = parseSalesResponse(raw, ctx);
    expect(skuSales['111']).toBe(0);
  });

  it('returns empty maps for missing result', () => {
    const { skuSales, skuPrices } = parseSalesResponse({}, ctx);
    expect(Object.keys(skuSales)).toHaveLength(0);
    expect(Object.keys(skuPrices)).toHaveLength(0);
  });
});

describe('parseSalesResponse — full_managed', () => {
  const ctx = { siteType: 'full_managed', date: '2026-05-03' };

  it('merges listOverall (meta) and querySkuSalesNumber (qty)', () => {
    const raw = {
      meta: {
        result: [
          {
            goodsId: 999,
            skuQuantityDetailList: [
              { productSkuId: 111, skuExtCode: 'ABC-01', className: 'red/M', supplierPrice: 1500 },
            ],
          },
        ],
      },
      qty: {
        result: [
          { date: '2026-05-03', prodSkuId: 111, salesNumber: 7 },
          { date: '2026-05-02', prodSkuId: 111, salesNumber: 3 },  // different date — should be ignored
        ],
      },
    };
    const { skuSales, skuPrices, skuSpuMap } = parseSalesResponse(raw, ctx);
    expect(skuSales['111']).toBe(7);
    expect(skuPrices['111'].extCode).toBe('ABC-01');
    expect(skuPrices['111'].activityPrice).toBeNull();
    expect(skuSpuMap['111']).toBe('999');
  });

  it('returns 0 sales for skus absent from qty response', () => {
    const raw = {
      meta: { result: [{ goodsId: 1, skuQuantityDetailList: [{ productSkuId: 222, skuExtCode: 'Y' }] }] },
      qty: { result: [] },
    };
    const { skuSales } = parseSalesResponse(raw, ctx);
    expect(skuSales['222']).toBe(0);
  });
});

describe('parseOrdersResponse', () => {
  it('aggregates shipping by skuId', () => {
    const raw = {
      result: {
        orderList: [{
          parentOrderMap: {
            waybillInfoList: [{
              interlineInfoForAggregationInfo: [{ shippingFeeAmount: 500, currency: 'USD' }],
            }],
          },
          orderList: [
            { skuId: 111, quantity: 2 },
            { skuId: 222, quantity: 2 },
          ],
        }],
      },
    };
    const shipping = parseOrdersResponse(raw);
    expect(shipping['111'].per_unit).toBeCloseTo(1.25);
    expect(shipping['222'].per_unit).toBeCloseTo(1.25);
  });

  it('returns empty for missing orders', () => {
    expect(parseOrdersResponse({})).toEqual({});
  });
});

describe('buildSkuRows', () => {
  it('builds rows with cost and profit', () => {
    const ctx = { shopName: 'TestShop', date: '2026-05-03', siteType: 'semi_us' };
    const salesData = {
      skuSales: { '111': 5 },
      skuPrices: { '111': { activityPrice: 20, dailyPrice: 25, extCode: 'XYZ', properties: {} } },
      skuSpuMap: { '111': 'spu1' },
    };
    const ordersShipping = {};
    const skuCostMap = { 'XYZ': [10, 2] };
    const rows = buildSkuRows(ctx, salesData, ordersShipping, skuCostMap);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r['销售件数']).toBe(5);
    expect(r['销售额']).toBeCloseTo(100);
    expect(r['成本价']).toBe(10);
    expect(r['销售成本']).toBeCloseTo(60);
    expect(r['毛利润']).toBeCloseTo(40);
    expect(r['成本缺失']).toBe(false);
  });

  it('skips skus with zero sales', () => {
    const salesData = {
      skuSales: { '111': 0 },
      skuPrices: { '111': { activityPrice: 10, extCode: 'X', properties: {} } },
      skuSpuMap: {},
    };
    const rows = buildSkuRows({ shopName: 'S', date: '2026-05-03' }, salesData, {}, {});
    expect(rows).toHaveLength(0);
  });

  it('includes 実際運費 only when orders shipping is present', () => {
    const salesData = {
      skuSales: { '111': 2 },
      skuPrices: { '111': { activityPrice: 15, extCode: 'Y', properties: {} } },
      skuSpuMap: {},
    };
    const rows = buildSkuRows(
      { shopName: 'S', date: '2026-05-03' },
      salesData,
      { '111': { per_unit: 3.5 } },
      { 'Y': [8, 2] }
    );
    expect(rows[0]['実際運費']).toBe(3.5);
  });
});
