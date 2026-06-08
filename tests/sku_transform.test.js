import { describe, it, expect } from '@jest/globals';
import { parseSalesResponse, parseOrdersResponse, buildSkuRows, transformSemiSalesResponse, transformSemiSalesDailyResponse } from '../background/transform/sku_transform.js';

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

describe('transformSemiSalesResponse — 半托 /api/sale/analysis/detail', () => {
  // 实测响应形状(节选自真半托店 mallId 634418221310504)
  const sampleItem = {
    productSkuId: 39396279178,
    productSkcId: 22961983155,
    productId: 9489993747,
    skuExtCode: '',
    goodsName: 'Mini Electric Shaver',
    goodsImage: 'https://img.kwcdn.com/x.jpg',
    goodsCat: '电动剃须刀',
    skuSize: 'Grey',
    goodsSkuLast1DQty: 0,
    goodsSkuLast7DQty: 0,
    goodsSkuLast30DQty: 5,
    inventoryNum: 6,
    authWhInventoryNum: 0,
    avlbDay: 9999.0,
    skuSaleDTOList: [ // 含未来预测日,不应被累加
      { date: '2026-05-20', saleNum: 1 },
      { date: '2026-07-31', saleNum: 0, isSellOut: -1 },
    ],
  };

  it('uses pre-aggregated goodsSkuLast{1,7,30}DQty (NOT summed daily)', () => {
    const rows = transformSemiSalesResponse([sampleItem]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.platformSkuId).toBe('39396279178');
    expect(r.sales30dVolume).toBe(5);   // = goodsSkuLast30DQty,不是 skuSaleDTOList 之和
    expect(r.sales7dVolume).toBe(0);
    expect(r.todaySaleVolume).toBe(0);
    expect(r.totalSaleVolume).toBe(5);
    expect(r.avgDailySales).toBeCloseTo(5 / 30);
  });

  it('maps SKC/SPU/name/image/inventory from the real fields', () => {
    const r = transformSemiSalesResponse([sampleItem])[0];
    expect(r.productId).toBe('9489993747');
    expect(r.productSkcId).toBe('22961983155');   // SKC 确实存在
    expect(r.productName).toBe('Mini Electric Shaver');
    expect(r.productSkcPicture).toBe('https://img.kwcdn.com/x.jpg');
    expect(r.category).toBe('电动剃须刀');
    expect(r.warehouseQty).toBe(6);               // inventoryNum
    expect(r.daysRemaining).toBeNull();           // avlbDay=9999 → null 哨兵
    expect(r.supplierPriceCents).toBeNull();
  });

  it('empty skuExtCode → null; avlbDay<9999 kept', () => {
    const r = transformSemiSalesResponse([{ ...sampleItem, skuExtCode: '  ', avlbDay: 42 }])[0];
    expect(r.skuExtCode).toBeNull();
    expect(r.daysRemaining).toBe(42);
  });

  it('skips items without productSkuId and returns [] for empty input', () => {
    expect(transformSemiSalesResponse([])).toEqual([]);
    expect(transformSemiSalesResponse([{ productId: 1 }])).toEqual([]);
  });
});

describe('transformSemiSalesDailyResponse — 半托每日明细 → 日快照行', () => {
  it('emits {platformSkuId,date,salesNumber} per past day, drops future (isSellOut=-1)', () => {
    const rawItems = [{
      productSkuId: 111,
      skuSaleDTOList: [
        { date: '2026-06-05', saleNum: 3, isSellOut: 0 },
        { date: '2026-06-06', saleNum: 1, isSellOut: 0 },
        { date: '2026-06-07', saleNum: 0, isSellOut: -1 },  // 未来预测,丢弃
        { date: '2026-06-08', saleNum: 0, isSellOut: -1 },  // 未来预测,丢弃
      ],
    }];
    const rows = transformSemiSalesDailyResponse(rawItems);
    expect(rows).toEqual([
      { platformSkuId: '111', date: '2026-06-05', salesNumber: 3 },
      { platformSkuId: '111', date: '2026-06-06', salesNumber: 1 },
    ]);
  });

  it('flattens multiple SKUs and skips items without productSkuId / empty input', () => {
    const rawItems = [
      { productSkuId: 1, skuSaleDTOList: [{ date: '2026-06-01', saleNum: 2, isSellOut: 0 }] },
      { skuSaleDTOList: [{ date: '2026-06-01', saleNum: 9, isSellOut: 0 }] }, // 无 productSkuId
      { productSkuId: 2, skuSaleDTOList: [{ date: '2026-06-01', saleNum: 5, isSellOut: 1 }] },
    ];
    const rows = transformSemiSalesDailyResponse(rawItems);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.platformSkuId)).toEqual(['1', '2']);
    expect(transformSemiSalesDailyResponse([])).toEqual([]);
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
