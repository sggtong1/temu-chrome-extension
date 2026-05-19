# Temu Chrome 插件 — agent 指南

## 是什么

Chrome MV3 扩展,**舵手 ERP 的"前线手脚"**。Temu 官方 Open API(`bg.*`)已死,所有需要从 Temu 抓数据 / 写操作(申报、确认价、调价)都改走这个插件。

主项目:`/Users/yyjr/coding/duoshou-erp/`(见该仓库 CLAUDE.md)。

GitHub:`github.com/sggtong1/temu-chrome-extension`,push 到 main 即生效;用户双机用 git pull 同步。

## 架构

```
ERP API 创建 agent_task → plugin SW 每 10s 轮询 /api/agent/tasks/claim
                       → dispatch by kind → captureSessionViaTab(开 hidden tab)
                       → MAIN world Request 构造器代理 → 抓 anti-content + mallid + content-type headers
                       → SW _originalFetch + headers 调 Temu 内部 API
                       → POST result 回 ERP /api/agent/tasks/:id/result
                       → ERP ingester 落业务表
```

**关键洞察**:
- Temu 卖家后台每个页面 mount 时会自然请求若干内部 API,**插件不主动伪造请求**,而是打开真页面 → 拦截那个自然的 API 调用 → 偷它的 headers → 用同一组 header 自己分页 fetch。这绕过 anti-content 校验。
- 一个 captureSessionViaTab 通常需要 10-20s(开 tab + 等页面 mount + 等真 API 发出)。session 缓存 90s 复用。

## 文件结构(知道在哪改)

| 文件 | 角色 |
|---|---|
| `manifest.json` | MV3 配置 + version |
| `background/service_worker.js` | message router + cookie 健康检查 + 触发 agent.pollOnce |
| `background/agent.js` | **主大脑**:KIND_TO_FETCH_SPEC 表 + dispatchXxx wrapper + session cache + capture 流程 |
| `background/transform/*.js` | 每个 kind 一份 raw → ERP-shape rows 的转换函数 |
| `popup/popup.{html,css,js}` | 配置 API URL/token + 在线状态 + 任务日志 + 进度树 |
| `content/fetch_hook.js` | MAIN world document_start 注入,代理 fetch/XHR(用得不多,主流靠 hidden tab 捕)|
| `options/options.html` | 备用配置页 |

## 必读约定

### AGENT_BUILD_ID(`background/agent.js` 顶部)

**每次改 agent.js 都要 bump**。格式 `agent-<topic>-<yyyymmdd><suffix>`,如 `agent-mallcache-fix-20260519d`。

用途:SW 日志带这个 BUILD_ID,用户截图发 console 时一眼能看出他装的是哪个版本的代码。

### manifest.json `version`(semver 风格)

按用户定的规则:

| 位 | 触发条件 |
|---|---|
| Z(第三位)| 小修改:文案、样式、一两行 bug fix |
| Y(第二位)| 大的修改:新功能、几文件联动、UX 升级 |
| X(第一位)| 非常重要:架构改、协议变、不兼容 |

bump Y/X 时低位归 0。

### 跟 BUILD_ID 解耦

manifest version 给用户看(popup 顶部显示),BUILD_ID 给开发看(SW 日志识别)。两个独立 bump。

## task kinds 全表

| kind | 走的 Temu 内部端点 | 落 ERP 表 |
|---|---|---|
| `scrape:marketing-activity` | `/enroll/activity/list` body=`{needSessionItem:true, needCanEnrollCnt:true}` | activity / activity_session |
| `scrape:activity-products` | `/enroll/scroll/match` body=`{activityType, activityThematicId, rowCount:50, filterUnsalableWarning:false}` | activity_product(chain trigger 自动派)|
| `scrape:activity-data` | `/enroll/list`(已报名 SKU 价快照)| activity_enrollment |
| `scrape:sales-30d` | `/mms/venom/api/supplier/sales/management/listOverall` | shop_sku_snapshot |
| `scrape:declared-price` | `/magnus/mms/price-adjust/product-adjust-query` | agent_task.result(后续 schema)|
| `scrape:flux-analysis` | `/api/seller/full/flow/analysis/goods/list` | flux_analysis_daily(list 数据源)|
| `scrape:flux-analysis-detail` | `/api/seller/full/flow/analysis/goods/detail` | flux_analysis_daily(detail 数据源)|
| `scrape:lifecycle-management` | `/mms/robin/searchForChainSupplier` | price_review |
| `submit:price-confirm` | `/magnus/mms/price-adjust/...` | price_review.status 更新 |
| `submit:activity-enroll` | `/enroll/submit` body wrapper=`productList` | activity_enrollment 状态更新 |

## 提交 body 重要发现(submit:activity-enroll)

通过实测真 cURL 反推(用户在 console 注入 hook 抓出来):

```json
{
  "activityType": 13,                         // number
  "activityThematicId": 2605120000000022,    // number
  "productList": [                            // ★ 不是 "submitList"
    {
      "productId": 4613927640,                // number(9-10 位)
      "activityStock": 15,
      "skcList": [
        { "skcId": 31505664437, "skuList": [{ "skuId": ..., "activityPrice": ... }] }
      ]
    }
  ]
}
```

**踩坑历史**:
1. 最初猜 wrapper 是 `submitList` → 一直返 errorCode=3000000 "报名货品不可为空"
2. 改 ID 全 string 透传 → 仍报错(因为 wrapper 还是错)
3. 把 wrapper 改回 `productList` + ID 改 number → 通过

**capture 锚点**:必须用 detail-new 页(`https://agentseller.temu.com/activity/marketing-activity/detail-new?type=X&thematicId=Y`),NOT 顶层 list 页。Temu submit 需要 session 在"看过具体 thematic"上下文。这条 plugin 已做 **fresh capture(不走缓存)**。

## MALL_MISMATCH 缓存约束

session 缓存按 mallId 做 key。Chrome 同时只能登 1 个 Temu mall,如果你在 cesi mall 但执行 PowerNest mall 的任务,**capture 会得到 cesi 的 headers**。

**关键顺序**(早期 bug,已修):
```js
// 1. capture
session = await captureSessionViaTab(...);
let freshlyCaptured = true;

// 2. ★ 先做 MALL_MISMATCH 检测
if (capturedMall !== expectedMall) {
  await invalidateSession(expectedMall);   // 清掉(如果有的话)脏缓存
  throw MALL_MISMATCH;
}

// 3. 通过才 setCache
if (freshlyCaptured) {
  await setCachedSession(expectedMall, session.headers, ...);
}
```

**绝对不能** capture 完立刻 setCache 再做 mismatch 检测 —— 那样 chrome 登 A 时执行 B 任务,会把 A 的 headers 写到 cache[B] 下,90 秒缓存窗口内 B 任务永远 MALL_MISMATCH。

## Login Health 缓存

`chrome.storage.local['agent:loginHealth']` 存每个 region 的实测登录态:

```ts
{
  global: { status: 'expired' | 'ok' | 'unknown', reason, updatedAt },
  us: ...,
  eu: ...,
  kjmh: ...,
}
```

- agent.js `captureSessionViaTab` 检测到 redirect 到 login 页 → 写 `expired`
- 成功 capture → 写 `ok`
- popup 读这个 + chrome.cookies 综合判断
- 24h TTL,但 popup 的"重新检测"会**清掉 expired 标记**让 cookie 检测重新生效(用户切登过就让他重新评估)

## Temu 子域映射

```ts
const HOST_TO_KEY = {
  'agentseller.temu.com':    'global',
  'agentseller-us.temu.com': 'us',
  'agentseller-eu.temu.com': 'eu',
  'seller.kuajingmaihuo.com': 'kjmh',
};
```

不同 region 的 mall 会跳 redirect 到对应子域,plugin 用这个映射定位 region。

## 常用调试

```bash
node -c background/agent.js     # 语法检查(MV3 SW 是 ES module,不跑就发布会出错)
```

popup 调试:打开 popup 后右键 → 检查弹窗 → Console,直接看 popup.js 跑的日志。

SW 调试:`chrome://extensions` → 找到插件 → "Service worker" 链接打开 SW devtools。

## ERP API URL 配置

popup 顶部"切换账号"打开 modal:
- API URL:`http://192.168.1.6:4000`(用户 mac mini 的 LAN IP)
- Token:`demo`(dev mode 通用)

存在 `chrome.storage.local` 里,SW 用 `getCfg()` 读。

## Git workflow

用户两台电脑用 GitHub 同步插件。流程:

```bash
# 改完代码:
# 1. bump AGENT_BUILD_ID(agent.js 顶部)
# 2. bump manifest.json version(按 X.Y.Z 规则)
# 3. node -c background/agent.js  # 语法 OK
# 4. git add <真实源码,跳过 .DS_Store/.bak> && git commit && git push origin main
# 5. 另一台:cd 仓库 && git pull origin main → Chrome 重新加载插件
```

`.gitignore` 已忽略 `.DS_Store / *.bak / node_modules/`,但 add 时还是用具体路径,别 `git add .`。

## 用户偏好

- 中文对话和注释
- 简洁直接
- destructive 操作(force push、删 commit)先确认
- 改完插件后告诉用户**怎么验证生效**(重载、再点 xxx 按钮、看 SW 日志)

## 状态最新更新

- 2026-05-19:popup 真实任务日志、登录态过期 banner、storage 直读兜底、重新检测清 expired
- 2026-05-19:MALL_MISMATCH 缓存污染修复(setCache 顺序)
- 2026-05-19:版本号规则写进 README,manifest 1.0.6 → 1.1.0
