import { describe, it, expect } from '@jest/globals';
import { transformOrderAmounts, buildPriceMap } from '../background/transform/order_transform.js';

const pageItems = [
  {
    parentOrderMap: {
      parentOrderSn: 'PO-1', parentOrderTimeStr: '2026-06-08 15:27:18', parentOrderStatus: 2,
      waybillInfoList: [{ interlineInfoForAggregationInfo: [{ shippingFeeAmount: 300, currency: 'USD' }] }],
    },
    orderList: [
      { orderSn: 'O-1A', quantity: 1, extCodeList: ['C-WH'],
        productInfoList: [{ productSkuId: '63674842911', productSkcId: '894', productSpuId: '6425916368' }] },
      { orderSn: 'O-1B', quantity: 3, extCodeList: ['C-GR'],
        productInfoList: [{ productSkuId: '26533923364', productSkcId: '895', productSpuId: '6425916368' }] },
    ],
  },
];

describe('buildPriceMap', () => {
  it('从 batchQueryByOrder 响应建 (orderSn::sku)→价 map,活动价优先', () => {
    const m = buildPriceMap({
      result: { querySupplierPriceByOrderRespList: [
        { parentOrderSn: 'PO-1', supplierPriceWithSubOrderRespList: [
          { orderSn: 'O-1A', productSkuSupplierPriceRespList: [
            { productSkuId: 63674842911, supplierPrice: null, activitySupplierPrice: 11026, currencyType: 'CNY' }] } ] } ] },
    });
    expect(m['O-1A::63674842911']).toEqual({ unitPriceCents: 11026, priceType: 'activity', currency: 'CNY' });
  });

  it('无活动价回落日常供货价', () => {
    const m = buildPriceMap({ result: { querySupplierPriceByOrderRespList: [
      { parentOrderSn: 'P', supplierPriceWithSubOrderRespList: [
        { orderSn: 'O', productSkuSupplierPriceRespList: [
          { productSkuId: 1, supplierPrice: 8800, activitySupplierPrice: null, currencyType: 'CNY' }] } ] } ] } });
    expect(m['O::1']).toEqual({ unitPriceCents: 8800, priceType: 'daily', currency: 'CNY' });
  });
});

describe('transformOrderAmounts', () => {
  const priceMap = {
    'O-1A::63674842911': { unitPriceCents: 11026, priceType: 'activity', currency: 'CNY' },
    'O-1B::26533923364': { unitPriceCents: 11026, priceType: 'activity', currency: 'CNY' },
  };

  it('join 出订单行 + 运费按 quantity 占比分摊', () => {
    const rows = transformOrderAmounts(pageItems, priceMap, 'us');
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.orderSn === 'O-1A');
    expect(a).toMatchObject({
      region: 'us', parentOrderSn: 'PO-1', productSkuId: '63674842911',
      productSpuId: '6425916368', productSkcId: '894', skuExtCode: 'C-WH',
      quantity: 1, unitPriceCents: 11026, priceType: 'activity', currency: 'CNY', orderStatus: 2,
    });
    expect(a.shippingFeeCents).toBe(75);
    expect(rows.find((r) => r.orderSn === 'O-1B').shippingFeeCents).toBe(225);
    expect(a.orderTime).toBe('2026-06-08 15:27:18');
  });

  it('priceMap 缺该行 → unitPriceCents 0 / priceType daily(不丢行)', () => {
    const rows = transformOrderAmounts(pageItems, {}, 'us');
    expect(rows).toHaveLength(2);
    expect(rows[0].unitPriceCents).toBe(0);
    expect(rows[0].priceType).toBe('daily');
  });

  it('无 waybill → 运费 0', () => {
    const noShip = [{ ...pageItems[0], parentOrderMap: { ...pageItems[0].parentOrderMap, waybillInfoList: null } }];
    const rows = transformOrderAmounts(noShip, priceMap, 'us');
    expect(rows.every((r) => r.shippingFeeCents === 0)).toBe(true);
  });
});
