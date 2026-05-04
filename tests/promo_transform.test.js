import { describe, it, expect } from '@jest/globals';
import { transformPromoResponse } from '../background/transform/promo_transform.js';

const SAMPLE = {
  result: {
    adDetailList: [{
      ad_id: 9001,
      goods_id: 606573883703398,
      spu_id: 4963349736,
      goods_title: 'Test Ad Product',
      ad_show_status: 1,
      roas: 25000,
      reports_summary_dto: {
        ad_spend_all: { val: 5000 },
        transaction_cost: { val: 2500 },
        order_pay_cnt_all: { val: 2 },
        goods_num: { val: 2 },
        impr_cnt_all: { val: 1000 },
        clk_cnt_all: { val: 50 },
        ctr_all: { val: 500 },
        cvr: { val: 400 },
      },
    }],
  },
};

describe('transformPromoResponse', () => {
  it('converts monetary values from cents to yuan', () => {
    const [row] = transformPromoResponse(SAMPLE, { shopName: 'S', date: '2026-05-03' });
    expect(row['总花费']).toBeCloseTo(50.0);
    expect(row['每笔成交花费']).toBeCloseTo(25.0);
  });

  it('converts rates from raw to percent', () => {
    const [row] = transformPromoResponse(SAMPLE, { shopName: 'S', date: '2026-05-03' });
    expect(row['点击率']).toBeCloseTo(5.0);
    expect(row['转化率']).toBeCloseTo(4.0);
  });

  it('converts ROAS from raw to decimal', () => {
    const [row] = transformPromoResponse(SAMPLE, { shopName: 'S', date: '2026-05-03' });
    expect(row.ROAS).toBeCloseTo(2.5);
  });

  it('returns empty array for missing list', () => {
    expect(transformPromoResponse({}, { shopName: 'S', date: '2026-05-03' })).toHaveLength(0);
  });
});
