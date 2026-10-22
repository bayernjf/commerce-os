# commerce-os handoff

> 状态主入口。开工前先读；每完成一个工作单元立即更新（已完成划掉、待办保留）。

## Current state（2026-10-22，M3 完成）

- **基线**：11 个测试文件 / **48 用例全绿**；`typecheck` 0 错；`lint` 0 错；`tsc -p tsconfig.build.json` 构建出 `dist/`；`check-migrations.sh` 配对通过（sqlite + postgres 各 1 份 001_init，10 张业务表 + schema_migrations）。
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

1. **M3 全量交付（2026-10-22）**：新建 `/Users/jiangfeng/000mycodes/commerce-os`（与六仓同级），48 测试绿、typecheck/lint/build/迁移配对全过、真实启动冒烟通过、GATE-M3 e2e 通过。~~未 commit（等用户授权）~~ **已提交（2026-10-22）**：`git init -b dev` 后 11 个英文原子提交（472ff53 脚手架 → 26b6f89 storage → f831eb7 channel → c003f64 product/order → 7aa2c9c decision → 0f2aa08 content/publishing → b847bed aftersale → 00bab44 fulfillment → 2dcf865 api → 131093e tests → 0540478 docs），作者 bayernjf 本人、无 AI co-author、**无 remote、未 push**；提交后五门（check:migrations/typecheck/lint/test/build）复跑全过。

## Next（M4 前置）

- [ ] 等用户确认模型 key 后开工 M4（loom 抽象内容底座 + 电商内容产出 + 客服占位）
- [ ] M5 真发布前准备 GitHub/Vercel/Cloudflare 凭据
- [ ] 抖店资质/店铺到位后，新增 live `douyin` 适配器（实现 ChannelAdapter + 凭据后端）
