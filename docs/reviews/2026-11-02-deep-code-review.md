# commerce-os 深度只读代码评审（2026-11-02）

- 评审方式：只读。未修改任何源码/配置/测试，未执行 commit/push/分支操作。
- 评审基线：`dev` 分支 HEAD `d55f683`（工作区干净，`git status --short` 无输出）。
- 评审人：AI 子代理（应 owner 明确授权执行，含仓内写入本报告与运行验证命令）。

## 1. 仓库定位与规模概览

自营电商最小闭环（Tier0 M3 产物，已推进至 storefront M1 / M6 本地部分）：商品中心、通道适配（沙箱回放）、订单幂等落库、zeus 决策内核远程分级（本仓不本地分级）、退款状态机、storefront 前台（catalog/cart/checkout/webhook）、客服意图分级、只读看板、可观测性。

- 规模（`git ls-files` 实测）：120 个跟踪文件；TypeScript 80（src 34 + tests 30 + front 2 tsx + 配置）、SQL 迁移 10（sqlite/postgres 各 5）、front Astro 子工程 4 页。
- 技术栈与 README 一致：Node ≥22（实测 v22.23.4）、TS 严格全开、Hono 4、`node:sqlite`、Vitest、file: 依赖同级 `zeus-client`。
- 测试实测：**30 文件 / 143 用例全绿**（handoff.md 写的 "27 文件 / 127 用例" 已过时）。

## 2. 结论摘要

**计数：P0 × 0，P1 × 2，P2 × 9，P3 × 8。**

整体工程质量高：模块边界清晰、方言隔离在存储层、决策真正远程化且 fail-closed、金额只信任服务端存储数据、鉴权启动 fail-closed、错误体统一、测试走真实 HTTP 路径。未发现当前部署形态下可直接利用的 P0。

最关键三条：

1. **【P1】同一订单行可无限次重复退款**：`requestRefund` 只校验 `qty ≤ 订单行 qty`，没有累计已退款量跟踪（`src/aftersale/aftersale-service.ts:53-67`）。自动定级（D0/D1）的小额退款不经人工即可直达通道打款——live 支付通道（LF-07）一上线即为资损 P0。
2. **【P1】`lint:secrets` 在 HEAD 实测失败（exit 1）且不在五门/CI 中**：`scripts/scan-secrets.sh:21` 的模式命中 `README.md:52` 的示例 `COMMERCE_API_TOKEN=dev-token`。handoff.md 声称"lint:secrets 零命中"与实测不符，该门形同虚设。
3. **【P2】三条审批恢复路径均为 fail-open 判定**：只排除 `status === 'rejected'`，而非要求 `=== 'decided'`（`aftersale-service.ts:137`、`publishing-service.ts:125`、`checkout-service.ts:173`）。已核实当前 zeus `approve()` 同步定结（`zeus/src/core/decision-service/service.ts:254-261`），今天不可利用；但属脆弱契约，zeus 未来引入异步多审即变资损漏洞。

## 3. 验证门实际执行结果（2026-11-02，本机 Node v22.23.4）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run check:migrations` | 0 | `OK: paired migrations (5 files each, sqlite + postgres)` |
| `npm run typecheck` | 0 | 无输出（tsc --noEmit，严格全开：strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes/noUnusedLocals/noUnusedParameters，见 tsconfig.json:6-10） |
| `npm run lint` | 0 | 无输出。注意 eslint.config.js:10-11 关闭了 `no-unused-vars` 与 `no-explicit-any`， lint 强度一般但非空壳 |
| `npm test` | 0 | `Test Files 30 passed (30)` / `Tests 143 passed (143)`，8.32s；含 fake-zeus HTTP 全链路 |
| `npm run build` | 0 | `tsc -p tsconfig.build.json` 产出 dist/ 正常 |
| `npm run lint:secrets` | **1** | `HIT [COMMERCE_API_TOKEN=[^$[:space:]]{8,}] -> README.md` / `SECRET SCAN FAILED` |
| `npm outdated` | — | 无安全级过期；vitest 2.1.9（latest 5.x）、typescript 5.9.3（latest 7.x）、eslint 9（latest 10）为大版本滞后，属维护性观察 |

门禁真实性判断：五门（migrations/typecheck/lint/test/build）真实非空壳——typecheck 严格项全开且 include 覆盖 src+tests，测试未被 skip，lint 用 tseslint.recommended。但 **`lint:secrets` 既未纳入 AGENTS.md 五门命令、也未纳入 CI（.github/workflows/ci.yml 只跑 check:migrations/typecheck/lint/test/build），且当前在 HEAD 是红的**——该安全门实际不存在。

## 4. 逐条发现

### P1

**P1-1 同一订单行可重复退款，无累计退款量跟踪**
- 位置：`src/aftersale/aftersale-service.ts:53-67`（校验只用 `qty > orderItem.qty` 拒超量，不查历史退款）。
- 影响：对同一 `orderItemId` 反复发起退款均可通过校验并生成新决策。小额退款若被 zeus 定为 D0/D1（`decision.status === 'decided'`，:103-109）将不经人工直达 `executeChannelRefund`。当前所有通道均为 fake/sandbox（`storefront-fake.ts` 确定性 accepted），不可实际利用；一旦接入真实支付/通道（roadmap LF-07），即为可自动放大的资损漏洞。测试侧无重复退款用例（`grep -i "twice|already refunded|cumulative" tests/` 零命中）。
- 建议：`requestRefund` 汇总该 orderItem 历史上 `requested/awaiting_approval/approved/succeeded` 状态的已退 qty 并校验累计上限；或给 refunds 加 `(order_id, order_item_id)` 唯一约束（全额退场景）。

**P1-2 密钥扫描门在 HEAD 失败且未接入任何强制门禁**
- 位置：`scripts/scan-secrets.sh:21`（模式 `COMMERCE_API_TOKEN=[^$[:space:]]{8,}`）命中 `README.md:52` 示例 `COMMERCE_API_TOKEN=dev-token`（"dev-token" 9 字符）。
- 实测：`bash scripts/scan-secrets.sh` → exit 1，`SECRET SCAN FAILED`（2026-11-02 本机，干净工作区）。
- 影响：handoff.md:7 声称 "lint:secrets 零命中" 与事实不符；该门不在 AGENTS.md 五门与 ci.yml 中，红色状态无人感知。若未来真凭据入库，扫描同样可能因长期红状态被忽略（狼来了效应）。
- 建议：对文档示例值加 allowlist（如 `COMMERCE_API_TOKEN=dev-token`/`COMMERCE_API_TOKEN=$` 开头豁免），并把 `lint:secrets` 加进 ci.yml 与 AGENTS.md 五门。

### P2

**P2-1 审批恢复路径 fail-open 判定（三处同构）**
- 位置：`src/aftersale/aftersale-service.ts:137`（`if (verdict === 'reject' || decision.status === 'rejected')`，否则直接打款）；`src/publishing/publishing-service.ts:125`（同型，否则直接上架）；`src/storefront/checkout-service.ts:173`（同型，否则直接 finalize 收钱）。
- 影响：只要 zeus `approve()` 返回的不是字面 `'rejected'`（含 `'awaiting_approval'`/`'blocked'`/未来新状态），commerce 就当批准执行外部动作。已核实当前 zeus 实现同步定结为 decided/rejected（`zeus/src/core/decision-service/service.ts:254-261`），故今日不可利用；属对下游契约的脆弱假设。
- 建议：改为显式白名单 `if (decision.status !== 'decided') throw CONFLICT/DECISION_HELD`。

**P2-2 webhook deliveryId 投毒可致合法投递被永久丢弃**
- 位置：`src/storefront/webhook-service.ts:52-61`：验签失败先 `recordDelivery(..., 'rejected', ...)` 落 `webhook_deliveries`（(provider, delivery_id) 唯一，迁移 004）；之后同 deliveryId 的合法投递在 :57-61 命中已有记录，直接返回 `duplicate` 不再处理。
- 影响：知道/猜到 deliveryId 的攻击者可先发一条坏签名请求"占位"，使支付网关重试的合法 webhook 被吞。当前 webhook 处理只写审计事件、不回写支付状态，实际危害限于审计丢失；一旦 webhook 开始驱动支付状态机（roadmap 方向），危害升级为资金状态丢失。
- 建议：rejected 记录与"已处理"去重分离——幂等检查只看 `status='processed'` 的记录，或用 `ON CONFLICT DO NOTHING` + 验签通过后才占用 deliveryId。

**P2-3 webhook 签名校验基于重序列化 JSON，而非原始请求体**
- 位置：`src/storefront/webhook-service.ts:49-50`（`const raw = JSON.stringify(input.payload ?? {})`，`routes.ts:102-118` 先 `c.req.json()` 再传入）。
- 影响：非标做法。语义等价但字节不同的报文（空白、键序、数字写法 `1e2` vs `100`、重复键）归一后为同一签名输入——合法发送方若键序/空白不同会验签失败（可用性），且与"签原始体"的网关互操作必然失败。今天不可伪造签名（仍需密钥），故不定 P1。
- 建议：在路由层取 `c.req.text()` 原始体计算 HMAC，payload 从验签后的原文解析。

**P2-4 approveCheckout 硬编码 provider='fake'，且 checkouts 不持久化下单时的 provider**
- 位置：`src/storefront/checkout-service.ts:177`（`finalize(..., 'fake')`）；`checkout-service.ts:116-120` 的 INSERT 不含 provider 列。
- 影响： shopper 在 `checkout()` 里指定的 provider（routes.ts:66-69 支持传 `provider`）在挂起审批后被静默替换为 fake。当前注册表只有 fake（services.ts:76-77），第二个 provider 注册即成 bug。
- 建议：checkouts 增加 provider 列并在 approve 路径回读。

**P2-5 finalize 非事务，且 payments.checkout_id 无唯一约束**
- 位置：`src/storefront/checkout-service.ts:194-237`（decide→ensureOrder→create payment→confirm 多步写无事务包裹）；`db/migrations/sqlite/003_storefront.sql:52-63`（payments 仅 FK，无 `UNIQUE(checkout_id)`）。
- 影响：两个并发 `approveCheckout` 都通过快照校验后可重复 finalize，同一 checkout 产生两行支付；`port.create` 在 fake 端会因 paymentId 不同而都成功。真实 provider 下即重复收款风险。
- 建议：`payments.checkout_id` 加唯一约束；approve 路径先 `UPDATE checkouts SET status='approving' WHERE id=? AND status='pending'` 抢占式状态迁移，冲突即 409。

**P2-6 finalize 失败后 checkout 永久卡死 pending，无恢复路径**
- 位置：`checkout-service.ts:116-125`（先插 pending 再 finalize）+ `:260-265`（`findExisting` 对 pending 直接原样返回）。
- 影响：finalize 中 `port.create/confirm` 抛错（如 provider 不可用）后，该 cart 再次 checkout 永远返回卡死的 pending checkout；zeus 侧决策已 decided，重新 approve 也会因 zeus 状态机拒绝（非 awaiting_approval 不能 approve，zeus service.ts:237-243）。唯一恢复是手工改库。
- 建议：finalize 失败把 checkout 置 `failed`（释放 cart），或提供显式 retry 端点。

**P2-7 混合币种购物车未拒绝，金额跨币种求和**
- 位置：`checkout-service.ts:92-93`（`totalMicros` 直接累加所有行，`currency` 取首行）。
- 影响：不同 currency 的 SKU 同车时，总价以首行币种计，金额语义错误。当前 SKU 默认 CNY 且币种校验只在创建时（product-service.ts:101），无全局约束。
- 建议：checkout 时校验所有行币种一致，不一致 422。

**P2-8 看板 grossAmount 计入未支付订单**
- 位置：`src/dashboard/dashboard-service.ts:53-55`（`grossAmount` 对全部 orders 求和，无状态过滤；`PAID_STATUSES` 只用于计数）。
- 影响：storefront 支付失败的订单（状态停留 `imported`）也计入 GMV 与 netAmount，经营口径虚高。
- 建议：gross/net 只统计 `PAID_STATUSES` 内订单。

**P2-9 公开端点无任何配额/限流**
- 位置：`routes.ts:51-55`（`POST /api/v1/storefront/carts` 无认证无限流，每次调用写一行 carts）。
- 影响：公网部署后任何人可无限造 cart/加购行膨胀 DB；webhook 端点同理（坏签名也落库，见 P2-2）。compose 形态仅绑 loopback 靠宿主反代，反代若不限流即暴露。
- 建议：反代层限流写入 DEPLOYMENT 要求；应用层至少对 webhook rejected 记录做限量/短 TTL。

### P3

1. `src/order/order-service.ts:129`：`getOrderByExternalId` 只按 `external_order_id` 查，不带 channel 条件，与 `(channel, external_order_id)` 的唯一口径不一致；建议补上 `channel='storefront'` 过滤。
2. `src/storefront/fake-payment-provider.ts:28`：支付状态在内存 Map，进程重启后 DB 里 `created` 的 payment 在 provider 侧 NOT_FOUND，confirm 500；建议启动时对账或文档明示。
3. `src/storage/migrate.ts`：迁移无单文件事务、无校验和/漂移检测；`db/migrations/sqlite/003_storefront.sql:15` 的种子 `INSERT INTO merchants` 非幂等，文件内部分失败重跑会撞 UNIQUE。
4. `src/storage/postgres/postgres-driver.ts:40-44`：`?`→`$n` 用正则全局替换，未来 SQL 含字面 `?`（如 postgres jsonb `?` 操作符、字符串字面量）会被误替换；建议注释固化约束或实现最小词法扫描。
5. 文档漂移三处：`.env.example` 缺 `COMMERCE_STOREFRONT_CART_SECRET`/`COMMERCE_WEBHOOK_FAKE_SECRET`/`COMMERCE_ALLOWED_ORIGINS`（serve.ts:72-84 已使用）；`handoff.md:7` 的 "27 文件/127 用例" 与实测 30/143 不符；ci.yml `Install dependencies` 用 `npm install` 而非 `npm ci`，锁文件纪律弱于本地约定。
6. `checkout-service.ts:347-348`：pending checkout 的响应 `totalMicros=0`、`currency=''`（从 payments/orders join 取数，pending 时两行都不存在），前端展示误导；建议回落到 checkouts 行的 `total_micros/currency`。
7. `src/content/loom-content-client.ts:114-121`：loom 返回的错误正文拼进 CommerceError.message 透传给 API 客户端，可能内含上游内部细节；ops Bearer 保护下风险低，建议截断/脱敏。
8. `src/storefront/cart-token.ts`：HMAC token 无过期、无单 cart 撤销（仅密钥轮换），属文档化取舍；如 storefront 公网上线建议加过期声明。

### 已核实为"有意设计/当前安全"的项（不计入发现）

- 决策 fail-closed：zeus 不可达 → DECISION_UNAVAILABLE 503（zeus-decision-client.ts:75-88），有测试覆盖；启动无 token 拒绝引导（boot.ts）。
- cartGuard 对未配置 secret fail-closed（routes.ts:33-44），`timingSafeEqual` 使用正确；shopper 订单/退款端点按 `sf-{cartId}` 派生，无越权读他人订单路径。
- 退款金额由订单行服务端计算，不信任客户端金额（aftersale-service.ts:65），符合 AGENTS.md 纪律。
- 全仓 SQL 均为 `?` 占位符参数化（抽查 routes/services/driver 无字符串拼接 SQL）；EventLog.list 的 where 拼接只用固定列名（event-log.ts:50-66），无注入面。
- 未知异常不回显内部信息（routes.ts:155-171，ProblemDetails），系 2026-10-30 评审 H2 的已落地修复。
- 500 内部错误不回显、live 通道无 credentialRef 一律 422、支付注册表不静默回退 fake——抽查均与文档一致。
- listing-ingest 的 URL/图片输入走离线桩或 422 拒绝（listing-ingest.ts:62-71），当前无 SSRF 面。

## 5. 架构与文档一致性

- 目录布局、端口契约（DecisionPort/ContentClient/ChannelAdapter/PaymentPort）与 README/AGENTS.md 描述一致；方言差异确实只在 `src/storage/`。
- README.md:48 声称 "npm test # 48 用例"，实测 143——README 测试计数过时（同 P3-5）。
- handoff.md 声明的 "lint:secrets 零命中" 与实测相反（见 P1-2）。
- 其余文档声明（fail-closed、501 占位、迁移配对、storefront 三进程 e2e）均与代码相符。

## 6. 修复优先级建议

1. **先做（接入真实支付/通道前的硬前提）**：P1-1 退款累计上限；P2-1 三处改白名单判定；P2-4 provider 持久化；P2-5 payments 唯一约束 + 抢占式状态迁移。
2. **门禁修复（低成本高杠杆）**：P1-2 扫描 allowlist + 纳入 CI；顺手修 P3-5 的 `npm ci` 与 .env.example 补齐。
3. **数据正确性**：P2-6 卡死 pending 恢复路径、P2-7 币种一致性、P2-8 看板口径、P2-2 webhook 去重分离。
4. **常态化**：P2-3 原始体签名（接真实支付网关时必做）、P2-9 限流、P3 各项随迭代清理。
