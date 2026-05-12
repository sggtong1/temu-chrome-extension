# Temu 数据采集 Chrome 插件

Chrome MV3 扩展，一键自动采集 Temu 卖家后台数据（流量分析、SKU 销量、营销活动、广告报表），写入 Supabase。

---

## 功能模块

| 模块 | 数据表 | 支持店铺类型 |
|------|--------|------------|
| 流量分析 (list) | `dashboard_metrics` | semi_us、full_managed |
| SKU 销量 (sales) | `sku_daily_metrics` | semi_us（单 API）、full_managed（双 API 合并）|
| 订单 (orders) | 不单独写库，合并到 sales | semi_us only |
| 营销活动 (activity) | `sku_activity_price` | full_managed only |
| 广告报表 (promo) | `ad_spend_daily` | semi_us、full_managed |

---

## 技术架构

```
manifest.json (MV3)
├── background/service_worker.js      # 状态机：协调采集流程、Supabase 写入
│   ├── transform/list_transform.js
│   ├── transform/sku_transform.js
│   ├── transform/promo_transform.js
│   └── transform/activity_transform.js
├── content/fetch_hook.js             # MAIN world, document_start：拦截 fetch/XHR
├── content/content_script.js         # ISOLATED world, document_idle：面板 UI + 消息中转
└── options/                          # Supabase URL / Anon Key 配置页
```

**跨世界通信链路：**

```
service_worker → chrome.tabs.sendMessage → content_script (ISOLATED)
                                              ↓ CustomEvent temu:setConfig
                                           fetch_hook (MAIN)
                                              ↓ CustomEvent temu:apiCapture
                                           content_script
                                              ↓ chrome.runtime.sendMessage
                                           service_worker
```

---

## 开发中遇到的问题与解决方案

### 1. API 拦截时序问题（核心难点）

**问题**：`fetch_hook.js` 运行在 `document_start` / MAIN world，目标页面的 API 请求在页面加载初期就发出。而 `ACTIVATE_CAPTURE` 消息需要等 `tabs.onUpdated` 的 `status=complete` 才发送，此时 API 早已触发完毕。结果 `_activeModule=null`、`_siteType='semi_us'`（默认值），全部拦截失效。

**日志证据：**
```
[temu-hook] sales URL hit via fetch, activeModule= null match= undefined
[temu-hook] activity URL hit via fetch, activeModule= null match= undefined
```

**解决方案**：在 `navigateToNextModule()` 导航前，将采集配置编码进 URL Hash：
```js
// service_worker.js
url += '#__tmu=' + encodeURIComponent(JSON.stringify({ mod, date, site, startDate, endDate }));
```
`fetch_hook.js` 在脚本最顶层（所有 `let` 声明之前）同步读取：
```js
const _hashCfg = _readHashConfig();   // 读 location.hash
let _siteType    = _hashCfg?.site || 'semi_us';
let _activeModule = _hashCfg?.mod  || null;
let _targetDate   = _hashCfg?.date || null;
```
Hash 在页面加载前就存在于 URL 中，无需任何异步消息，彻底消除竞争条件。

---

### 2. full_managed 销量需要两个 API 合并

**问题**：`semi_us` 的销量数据来自单一接口，而 `full_managed` 需要：
- `listOverall`：SKU 元数据（货号、供应商价格）
- `querySkuSalesNumber`：按日期的销售数量

两个接口各自触发，必须都到齐才能写库。

**解决方案**：在 service worker 中维护 `salesPartials: { meta, qty }`，收到第一个时暂存，两个都到后合并再调用 `processModule('sales', ...)`.

---

### 3. 营销活动：直接 fetch 缺少鉴权 Header

**问题**：尝试在 content script 里直接 `fetch` 活动列表 API，返回 401/403。Temu 的 API 依赖页面登录态（Cookie + 自定义鉴权 Token），content script 发出的裸请求不带这些 Header。

**解决方案**：放弃主动 fetch，改为被动拦截——让页面自己加载活动报名记录页，`fetch_hook.js` 拦截页面发出的原始请求（携带完整 Header），获取第一页数据后再用同一 `init`（含所有 Header）分页拉取剩余数据。

---

### 4. 营销活动分页

**问题**：页面只加载第 1 页，后续页需要插件自己补全。

**解决方案**：`fetchActivityAllPages()` 复用页面原始请求的 `init`（含鉴权 Header），递增 `pageNo` 直到 `allList.length >= total`。

---

### 5. 营销活动按区间采集而非逐日

**问题**：最初逻辑把活动当成普通模块，每个日期都导航一次，实际活动 API 接受区间查询，不需要逐日重复。

**解决方案**：Activity 模块只采集一次（使用完整 `startDate~endDate`）。`transformActivityResponse` 将每条活动展开为区间内每天一行，供 `sku_daily_metrics` 按日 JOIN。采集完成后将 `activity` 从 `originalModules` 移除，后续日期跳过。

---

### 6. 日期时区偏移

**问题**：`new Date('2026-04-01T00:00:00').toISOString()` 在 UTC+8 本地环境下输出 `'2026-03-31T16:00:00Z'`，`.slice(0,10)` 得到 `'2026-03-31'`，日期少一天。

**解决方案**：所有日期字符串转 Date 时明确加 `T00:00:00Z` 强制 UTC：
```js
new Date(startDate + 'T00:00:00Z')
```

---

### 7. 采集完成后挂起（activity 后续日期 modules 为空）

**问题**：Activity 完成后将自身从 `originalModules` 移除，后续日期 `modules = [...originalModules]` 为空数组，`navigateToNextModule` 检测到 `!mod` 直接 `return`，集合状态永远不结束。

**解决方案**：在 `!mod` 分支补充判断——若 `originalModules.length === 0` 说明没有任何模块需要继续，直接关闭采集标签页并广播 `complete`。

---

### 8. sku_activity_price 日期列类型不匹配

**问题**：初版建表时 `"日期"` 为 `text`，而 `sku_daily_metrics."日期"` 为 `date`，JOIN View 编译报类型错误。

**解决方案**：建表迁移改为 `"日期" date NOT NULL`，与主表一致。

---

### 9. Supabase CLI 非 TTY 登录

**问题**：在 Claude Code 内执行 `supabase login` 需要交互式终端，直接 `exec` 失败。

**解决方案**：将 `SUPABASE_ACCESS_TOKEN` 写入 `~/.claude/settings.json` 的 `env` 字段，每次 shell 命令自动携带，无需交互登录。

---

## 数据存储 (mini-postgres + PostgREST)

数据存到一台**服务器机器**上的 `mini-postgres` 容器（database `ecommerce`，端口 5432）。
浏览器无法直连 PG wire protocol，需要前置一层 HTTP API —— 用 PostgREST（与 Supabase
同源的 REST-over-PG 包装）作翻译。

**服务器机器（单机部署，跑 PG + PostgREST）**：

```bash
bash scripts/start-api.sh         # 默认绑 0.0.0.0:3003, 局域网共享
BIND=127.0.0.1 bash scripts/start-api.sh   # 仅本机, 不让 LAN 其他人访问
```

脚本完成后输出可用 URL，例如：
- `http://yyjrs-Mac-mini.local:3003` （mDNS 主机名, Mac/iOS 自动解析）
- `http://192.168.1.6:3003`           （LAN IP, 全平台可用但 DHCP 续约可能变）

**客户端（团队成员的笔记本，跑扩展）**：

打开扩展选项页（chrome://extensions 找到扩展 → 选项），把 **API URL** 填成服务器
机器的上述 URL 之一，点保存 → 测试连接应返回"✅ 连接成功"。

### 服务器机器要求

- 一直开机（同事采集时它必须在线）
- 跟同事在同一个局域网（同 WiFi 或同有线网）
- macOS 防火墙允许端口 3003 入站（默认 OFF 通常不用动；如果开了 ALF 防火墙需要把
  Docker 加白名单）

### 安全注意

PostgREST 当前以 `admin` 作为 anon role，**任何能连到 3003 的人都能 INSERT/DELETE
所有表**。LAN 共享模式假设你的 WiFi 里都是可信设备（家人 / 同事，不含陌生人 / 不
受控的 IoT 设备）。如需更严格：

- 用 `BIND=127.0.0.1` 限本机, 再叠 Tailscale/Cloudflare Tunnel 暴露给同事
- 给 PostgREST 配 JWT (PGRST_JWT_SECRET), 改成只允许带 token 的请求写入

---

## 本地开发

```bash
npm install
node dev-watch.mjs   # 监听文件变化，写入 dev-reload.json 触发扩展自动重载
```

在 Chrome 中加载 `chrome://extensions` → 加载已解压的扩展 → 选择本目录。
