import { describe, it, expect } from '@jest/globals';
import { transformOrderAmounts, buildPriceMap, parseMoneyToCents } from '../background/transform/order_transform.js';

const pageItems = [
  {
    parentOrderMap: {
      parentOrderSn: 'PO-1', parentOrderTimeStr: '2026-06-08 15:27:18', parentOrderStatus: 2,
      waybillInfoList: [{ interlineInfoForAggregationInfo: [{ estimatedAmount: '$3.00', shipStageType: 'TAIL_CHANNEL' }] }],
    },
    orderList: [
      { orderSn: 'O-1A', quantity: 1, extCodeList: ['C-WH'],
        productInfoList: [{ productSkuId: '63674842911', productSkcId: '894', productSpuId: '6425916368' }] },
      { orderSn: 'O-1B', quantity: 3, extCodeList: ['C-GR'],
        productInfoList: [{ productSkuId: '26533923364', productSkcId: '895', productSpuId: '6425916368' }] },
    ],
  },
];

describe('parseMoneyToCents', () => {
  it('"$3.27" → 327, "$1,234.56" → 123456, null → 0', () => {
    expect(parseMoneyToCents('$3.27')).toBe(327);
    expect(parseMoneyToCents('$1,234.56')).toBe(123456);
    expect(parseMoneyToCents(null)).toBe(0);
    expect(parseMoneyToCents('$0.35')).toBe(35);
  });
});

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

  it('join 出订单行 + 平台配送费按 quantity 占比分摊(estimatedAmount "$3.00"→300分)', () => {
    const rows = transformOrderAmounts(pageItems, priceMap, 'us');
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.orderSn === 'O-1A');
    expect(a).toMatchObject({
      region: 'us', parentOrderSn: 'PO-1', productSkuId: '63674842911',
      productSpuId: '6425916368', productSkcId: '894', skuExtCode: 'C-WH',
      quantity: 1, unitPriceCents: 11026, priceType: 'activity', currency: 'CNY', orderStatus: 2,
      deliveryCurrency: 'USD', shippingFeeCents: 0,
    });
    expect(a.deliveryFeeCents).toBe(75);                                  // 300 * 1/4
    expect(rows.find((r) => r.orderSn === 'O-1B').deliveryFeeCents).toBe(225); // 300 * 3/4
    expect(a.orderTime).toBe('2026-06-08 15:27:18');
  });

  it('2 段(揽收 COLLECTION + 尾程 TAIL)相加 → 配送费合计', () => {
    const twoSeg = [{
      ...pageItems[0],
      parentOrderMap: {
        ...pageItems[0].parentOrderMap,
        waybillInfoList: [{ interlineInfoForAggregationInfo: [
          { estimatedAmount: '$0.35', shipStageType: 'COLLECTION_CHANNEL' },
          { estimatedAmount: '$5.25', shipStageType: 'TAIL_CHANNEL' },
        ] }],
      },
      orderList: [{ orderSn: 'O-X', quantity: 1, extCodeList: ['C'],
        productInfoList: [{ productSkuId: '1', productSkcId: '2', productSpuId: '3' }] }],
    }];
    const rows = transformOrderAmounts(twoSeg, priceMap, 'us');
    expect(rows[0].deliveryFeeCents).toBe(560);   // 35 + 525
  });

  it('priceMap 缺该行 → unitPriceCents 0 / priceType daily(不丢行)', () => {
    const rows = transformOrderAmounts(pageItems, {}, 'us');
    expect(rows).toHaveLength(2);
    expect(rows[0].unitPriceCents).toBe(0);
    expect(rows[0].priceType).toBe('daily');
  });

  it('无 waybill → 平台配送费 0', () => {
    const noShip = [{ ...pageItems[0], parentOrderMap: { ...pageItems[0].parentOrderMap, waybillInfoList: null } }];
    const rows = transformOrderAmounts(noShip, priceMap, 'us');
    expect(rows.every((r) => r.deliveryFeeCents === 0)).toBe(true);
  });
});
