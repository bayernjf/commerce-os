# commerce-os handoff

> 状态主入口。开工前先读；每完成一个工作单元立即更新（已完成划掉、待办保留）。

## Current state（2026-10-28，storefront SF-01~06 完成；GATE-M6 外部阻塞未过门）

- **基线**：23 个测试文件 / **106 用例全绿**；`typecheck` 0 错；`lint` 0 错；迁移 sqlite + postgres 各 001/002/003 三份（003 storefront 五表 + L0 owner 种子，见 Active work）。
- **M6 本地部分已完成**：
  - 可观测性 `src/observability/`：结构化 JSON logger（错误走 stderr）、AlertReporter（stderr 结构化告警 + 可选 webhook、cooldown 去重）、readiness 探针（DB round-trip + 数据卷磁盘空间）。
  - HTTP：`/healthz` 保持 liveness，新增 `/readyz`（真探 DB+磁盘，失败 503 并告警）；503 依赖错误（decision/content/channel）与 500 未处理错误在错误边界发告警。
  - serve：装配 reporter、`unhandledRejection`/`uncaughtException` 告警并退出、SIGTERM/SIGINT 优雅关闭（关 server+driver，10s 安全退出）。
  - 部署：多阶段 Dockerfile（容器内编译，跨仓 zeus-client 经 named context，COPY recordings）、`docker-compose.yml`（持久卷、healthcheck、restart、日志轮转、仅绑 loopback 由宿主反代 TLS）。
  - **现网验证（容器级）**：compose build+up 后 healthy，healthz/readyz 200、自动迁移、写入后 restart 数据仍在；zeus 不可达时 listing 返 503 且 stderr 出 decision_unavailable 告警。
  - **域名/TLS/真实云部署外部阻塞，未发生不冒充**。
- **M4 已完成**：`LoomContentClient`（HTTP 调 loom content-base，替换 T-M3-07 桩，CONTENT_UNAVAILABLE 503 fail-closed）；客服模块（迁移 002 三表，规则意图分级，D2+ 转人工不自动承诺）；content-loop 闭环测试；GATE-M4 过。
- **M5 已完成（自举侧）**：`dashboard-service.ts`（只读聚合：订单/退款/内容/净额，GMV−退款不含成本）+ GET /api/v1/dashboard（3 测试）；真实部署归 M6（T-M6-03），未发生不冒充。
- **M3 基线**：11 个测试文件 / 48 用例全绿；`tsc -p tsconfig.build.json` 构建出 `dist/`；`check-migrations.sh` 配对通过。
- 真实启动验证：`node --experimental-sqlite dist/serve.js` 起服务，`GET /healthz` 200（db=sqlite，自动迁移 001_init），`POST /api/v1/payments` 正确返回 501 `NOT_IMPLEMENTED_PLACEHOLDER`。
- 迁移 CLI 验证：`migrate:up` 空库应用 001_init，二次运行幂等；`migrate:status` 正确。
- 决策链路：测试通过 `tests/helpers/fake-zeus-server.ts`（node:http 假 zeus，脚本化 DEFAULT_POLICY_V1 分级）让真实 `zeus-client` 走完整 HTTP：publish→D3 挂起、1299 CNY 退款→D2 挂起、120→D1、审批/驳回端点闭环；zeus 不可达→`DECISION_UNAVAILABLE` 503 用例通过。
- **GATE-M3 通过**：`tests/e2e-loop.test.ts` 全链路（商品→内容桩→D3 审批→沙箱上架→订单回传幂等→D2 退款审批→succeeded）+ `tests/http-smoke.test.ts` HTTP 全链路。

## 范围（T-M3-01 ~ T-M3-10，全部完成）

- T-M3-01 脚手架：package.json / tsconfig（严格全开）/ vitest / eslint / Dockerfile / CI / 双方言迁移 / migrate CLI
- T-M3-02 通道契约 `ChannelAdapter`（五方法）+ 注册表（未注册 fail-closed）+ 通道账号（live 无 credentialRef → 422）
- T-M3-03 商品中心：类目（父类校验）/ SPU-SKU（标题/价格/币种/skuCode 唯一校验）
- T-M3-04 沙箱适配器 `sandbox-douyin`：离线回放 `recordings/sandbox-douyin/fixtures.json`（商品/订单/库存/退款/内容）
- T-M3-05 订单中心：通道拉单、`(channel, external_order_id)` 幂等、SKU 编码回填、`order.imported` 事件
- T-M3-06 决策接入：`ZeusDecisionClient`（包真实 zeus-client）+ 传输错误 fail-closed 包装
- T-M3-07 内容桩 + 发布：`StubContentClient`（禁词拦截、单次审核、永不自动确认）；`PublishingService`（内容→D3 决策→审批后才 upsert/publish）
- T-M3-08 退款：金额只按订单行计算；`requested → awaiting_approval → succeeded/rejected`；审批通过后才调通道；驳回留痕
- T-M3-09 库存手工维护 + 履约/支付 501 占位
- T-M3-10 全链路 e2e + HTTP smoke（GATE-M3）

## 有意的边界（不做，勿当缺口）

- 无 live 通道：`douyin` 真实适配器需抖店资质与密钥，到位前选择 live 通道一律 422/422（未注册/缺凭据）
- 无模型：内容是离线桩，M4 接 loom 内容底座（端口 `ContentClient` 不变）
- 无支付/物流：平台外部支付，订单导入即已支付；501 是显式产品口径
- 无多租户（自用口径）
- PostgreSQL 方言只做静态配对与驱动端口，本地未装 `pg`、未联调（生产环境 `npm install pg`）

## Active work（倒序）

0. **storefront 工作包（2026-10-28，独立站双用方案 v1.0 D2=B 拍板）**：
   - `feature/storefront` 分支（基于 dev）。
   - **SF-01 迁移 003**：五表 `merchants`（L0 owner 单行种子 `mer_owner`，D1=A 租户预留）/ `carts` / `cart_items` / `checkouts` / `payments`（金额微元整数），sqlite + postgres 双方言配对，`check:migrations` OK（3/3）。提交 `b58f60d` feat + `7092408` test。
   - **SF-02 catalog 投影**：`src/storefront/catalog-service.ts` 只读投影，仅 `listed` 商品 + `active` SKU（draft/delisted 不可见，改价经商品投影不追溯）。提交 `cc0576a` feat + `a6cc809` test。
   - **SF-03 cart 服务**：`src/storefront/cart-service.ts` 匿名会话 createCart/getCart/listItems/addItem；行级校验（listed 商品/active sku/qty 正整数）、`unit_amount_micros` 首次加入快照、同 sku 合并 qty 不改快照、会话隔离。提交 `8528e6f` feat + `de117d7` test。
   - **SF-05 payment port + fake provider**：`payment-port.ts`（create/confirm/refund/getStatus/verifyWebhook，端口不持本地持久化，对齐 ChannelAdapter）+ `fake-payment-provider.ts`（确定性脚本回放，无网络，sandbox=true）。提交 `b6a9ac8` feat + `09aab7d` test。
   - **SF-06 provider registry**：`payment-registry.ts` fail-closed（未注册 → CREDENTIAL_MISSING 422，绝不静默回退 fake）；PaymentPort 增 sandbox 标记。提交 `c83397f` feat + `7857ed0` test。
   - **SF-04 checkout**：`checkout-service.ts` cart 校验 → 幂等生单（channel=storefront，external_order_id=`sf-{cartId}`，重复结算返回已有 checkout 不重复生单）→ PaymentPort.create/confirm → paid/failed 状态机；paid 关 cart 置 checked_out；D3 挂起留 SF-09。提交 `d739a6b` feat + `2843268` test。
   - 门结果：五门全绿（**23 文件 / 106 用例**；迁移测试期望列表含 003）。
   - 待续：SF-07 webhook → SF-14（详细任务见 `../bayjf/docs/tier0/Tier0-独立站双用任务拆解与推进评估.md` M1）。
1. **运营只读缺口关闭（2026-10-26，ops-console T-M8 登记的 commerce 内核缺口）**：
   - `GET /api/v1/refunds` 列表（`AftersaleService.listRefunds()`，ids 逐行 map，与 listOrders 同形）——此前只有 `GET /api/v1/refunds/:id` 详情。
   - `GET /api/v1/content` 列表 + `GET /api/v1/content/:id` 详情（`src/content/content-read-model.ts`，只读投影 `product.listed` 事件，详情按 payload.externalContentId 读取，未命中 404 NOT_FOUND）——此前控制台只能从事件流 + dashboard `content.published` 口径派生。
   - 两个家族均为纯只读，Bearer 中间件已覆盖 `/api/v1/*`；每端点带 HTTP 级测试（空列表/种子读回/未知 id 404/无 token 401/正确 token 200）。
   - 门结果：`check:migrations` OK（未动迁移）、`typecheck` 0 错、`lint` 0 错、`vitest run` **18 文件 / 83 用例全绿**（原 73 + 新增 9）、`build` 成功。
   - 提交：`4c07a40` feat(refunds)、`032d36d` feat(content)、`c25482b` test(read-lists)、`本提交 docs`。
   - 未做 ops-console 前端接线（本仓边界外）；ops-console 侧可在下一批把内容页从事件流派生切到 `/api/v1/content`。
1. **M6 本地部分（2026-10-23，T-M6-03/04/05）**：observability（logger/AlertReporter/readiness）、/readyz 与错误边界告警、serve 优雅关闭、多阶段 Dockerfile + compose 生产形态；容器级演练 healthy、重启续跑、503 告警；live 缺凭据 HTTP 422 测试。原子提交：2c19e2b（observability）、1e83673（http readyz）、eac0151（serve）、f1fe010（deploy）、69e7fa5（live 422 测试）。**现网/真实店铺外部阻塞**。
2. **M5 交付自举（2026-10-23，自举侧）**：T-M5-04 只读经营看板（`dashboard/dashboard-service.ts` + GET /api/v1/dashboard，JS 内聚合，netAmount=GMV−成功退款不含成本），3 测试；commit d6d87c8。发布接入由 agent-dev onboarding 完成（T-M5-02），真实 Preview/Production 待外部凭据（M6）。
2. **M4 内容底座（2026-10-23）**：`content/loom-content-client.ts` HTTP 替换桩（dbeb0f0）；客服 `customer-service/` + 迁移 002（意图分级、D2+ 转人工）；content-loop 闭环测试（686e7e5）；GATE-M4 过。
3. **M3 全量交付（2026-10-22）**：新建 `/Users/jiangfeng/000mycodes/commerce-os`（与六仓同级），48 测试绿、typecheck/lint/build/迁移配对全过、真实启动冒烟通过、GATE-M3 e2e 通过。~~未 commit（等用户授权）~~ **已提交（2026-10-22）**：`git init -b dev` 后 11 个英文原子提交（472ff53 脚手架 → 26b6f89 storage → f831eb7 channel → c003f64 product/order → 7aa2c9c decision → 0f2aa08 content/publishing → b847bed aftersale → 00bab44 fulfillment → 2dcf865 api → 131093e tests → 0540478 docs），作者 bayernjf 本人、无 AI co-author、**无 remote、未 push**；提交后五门（check:migrations/typecheck/lint/test/build）复跑全过。

## Next（M6 外部条件 + M7 + storefront）

- [ ] **storefront SF-07~SF-14（2026-10-28 起）**：SF-01~06 已落地（迁移 003 + catalog/cart/checkout 服务 + payment port/registry）；下一任务 SF-07 payments webhook（HMAC 验签 + delivery 幂等 + 事件审计）。详见 `../bayjf/docs/tier0/Tier0-独立站双用任务拆解与推进评估.md` M1。
- [ ] M6 现网（T-M6-03，外部）：准备 Vercel/Cloudflare/云凭据 + 域名/TLS，按生产工件或 agent-dev 发布编排真做现网部署，跑 healthz/readyz
- [ ] T-M6-04（外部）：抖店资质/店铺到位后，新增 live `douyin` 适配器（实现 ChannelAdapter 五方法 + 凭据后端），完成 1 次真实 upsert+拉单
- [ ] T-M6-05 现网冒烟（外部）：含 D2/D3 真实审批一次，补 GATE-M6 证据后过门
- [ ] 各仓 push 与真实 PR 由 owner 决定；GATE-M6 过门后进 M7（执行器接线）
