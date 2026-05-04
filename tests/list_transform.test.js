import { describe, it, expect } from '@jest/globals';
import { transformListResponse } from '../background/transform/list_transform.js';

const SAMPLE_RESPONSE = {
  success: true,
  result: {
    list: [
      {
        goodsId: 606573883703398,
        goodsName: 'Test Product',
        goodsImageUrl: 'https://img.example.com/a.jpg',
        productSpuId: 4963349736,
        statDate: '2026-05-03',
        exposeNum: 1000,
        clickNum: 50,
        payGoodsNum: 5,
        exposePayConversionRate: 0.005,
        category: { catId: 39200, catName: '电动剃须刀', cat1Id: 2096, cat1Name: '家电' },
      },
    ],
    total: 1,
  },
};

describe('transformListResponse', () => {
  it('maps top-level traffic fields', () => {
    const rows = transformListResponse(SAMPLE_RESPONSE, { shopName: 'TestShop', region: 'us', date: '2026-05-03' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row['曝光量']).toBe(1000);
    expect(row['点击量']).toBe(50);
    expect(row['支付件数']).toBe(5);
    expect(row['曝光支付转化率']).toBe(0.005);
  });

  it('maps shop and region fields', () => {
    const [row] = transformListResponse(SAMPLE_RESPONSE, { shopName: 'TestShop', region: 'us', date: '2026-05-03' });
    expect(row['店铺名称']).toBe('TestShop');
    expect(row['区域']).toBe('美国');
    expect(row.region).toBe('us');
    expect(row['日期']).toBe('2026-05-03');
  });

  it('maps category fields', () => {
    const [row] = transformListResponse(SAMPLE_RESPONSE, { shopName: 'S', region: 'eu', date: '2026-05-03' });
    expect(row['类目ID']).toBe('39200');
    expect(row['类目名称']).toBe('电动剃须刀');
    expect(row['一级类目名称']).toBe('家电');
  });

  it('returns empty array for missing list', () => {
    const rows = transformListResponse({ success: true, result: {} }, { shopName: 'S', region: 'us', date: '2026-05-03' });
    expect(rows).toHaveLength(0);
  });

  it('uses raw region value for unknown region', () => {
    const [row] = transformListResponse(SAMPLE_RESPONSE, { shopName: 'S', region: 'jp', date: '2026-05-03' });
    expect(row['区域']).toBe('jp');
  });
});
