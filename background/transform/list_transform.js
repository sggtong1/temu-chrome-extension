const FIELD_MAP = {
  goodsName: '商品名称',
  goodsImageUrl: '商品图片URL',
  exposeNum: '曝光量',
  clickNum: '点击量',
  goodsDetailVisitNum: '商品详情页访问量',
  goodsDetailVisitorNum: '商品详情页访客数',
  addToCartUserNum: '加购人数',
  collectUserNum: '收藏人数',
  payGoodsNum: '支付件数',
  payOrderNum: '支付订单数',
  buyerNum: '买家数',
  exposePayConversionRate: '曝光支付转化率',
  exposeClickConversionRate: '曝光点击转化率',
  clickPayConversionRate: '点击支付转化率',
  searchExposeNum: '搜索曝光量',
  searchClickNum: '搜索点击量',
  searchPayGoodsNum: '搜索支付件数',
  searchPayOrderNum: '搜索支付订单数',
  recommendExposeNum: '推荐曝光量',
  recommendClickNum: '推荐点击量',
  recommendPayGoodsNum: '推荐支付件数',
  recommendPayOrderNum: '推荐支付订单数',
};

const CAT_MAP = {
  catId: '类目ID', catName: '类目名称',
  cat1Id: '一级类目ID', cat1Name: '一级类目名称',
  cat2Id: '二级类目ID', cat2Name: '二级类目名称',
  cat3Id: '三级类目ID', cat3Name: '三级类目名称',
  cat4Id: '四级类目ID', cat4Name: '四级类目名称',
  cat5Id: '五级类目ID', cat5Name: '五级类目名称',
};

const REGION_LABELS = { default: '全球', eu: '欧洲', us: '美国' };

/**
 * @param {object} rawData - raw API JSON response
 * @param {{ shopName: string, region: string, date: string }} ctx
 * @returns {object[]} rows for dashboard_metrics upsert
 */
export function transformListResponse(rawData, { shopName, region, date }) {
  const items = rawData?.result?.list ?? [];
  return items.map(item => {
    const row = {
      '店铺名称': shopName,
      shop_name: shopName,
      '区域': REGION_LABELS[region] || region,
      region,
      '日期': date,
      '商品SPUID': String(item.productSpuId ?? ''),
      productSpuId: String(item.productSpuId ?? ''),
      '商品ID': String(item.goodsId ?? ''),
    };
    for (const [k, col] of Object.entries(FIELD_MAP)) {
      if (item[k] != null) row[col] = item[k];
    }
    const cat = item.category ?? {};
    for (const [k, col] of Object.entries(CAT_MAP)) {
      if (cat[k] != null) row[col] = String(cat[k]);
    }
    return row;
  });
}
