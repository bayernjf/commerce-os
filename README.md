# commerce-os

自营电商最小闭环（Tier0 组合级落码 · M3 里程碑产物）。

- **商品**：类目 / SPU-SKU / 商品中心
- **通道**：`ChannelAdapter` 契约 + 注册表；M3 只注册离线 `sandbox-douyin`（回放录制，不触网），live 通道在凭据到位前一律 fail-closed
- **订单**：通道回传 → 本地落库，`(channel, external_order_id)` 幂等
- **决策**：所有金额/外部动作（上架、退款）经 `zeus-client` 走 HTTP 交给 zeus 决策内核，**本仓不本地分级**；zeus 不可用时 fail-closed（503）
- **售后**：退款状态机 `requested → awaiting_approval → succeeded/rejected`，zeus 审批通过后才调用通道退款
- **内容**：M3 为确定性离线桩（`StubContentClient`），M4 替换为 loom 内容底座，调用方不变
- **履约/支付**：M3 显式占位，接口返回 501 `NOT_IMPLEMENTED_PLACEHOLDER`，不伪造成功
- **存储**：SQLite（本地，内置 `node:sqlite`）/ PostgreSQL（生产）双方言，方言只在存储层，迁移文件编号配对
- **审计**：`commerce_events` 表记录全部关键动作（决策请求、上架、订单导入、退款流转）

## 技术栈

Node ≥ 22 · TypeScript（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）· Hono（`@hono/node-server`）· Vitest · 内置 `node:sqlite`。
决策客户端依赖同级仓的 `zeus-client`（`file:../zeus/packages/zeus-client`，M1 交付）。

## 目录

```
src/
  storage/            # 驱动端口、sqlite/pg 实现、迁移、事件审计
  channel/            # 通道契约、注册表、通道账号、adapters/sandbox-douyin
  product/            # 商品中心（类目/SPU/SKU）
  order/              # 订单中心（通道拉取 + 幂等落库）
  decision/           # DecisionPort + zeus-client 包装
  content/            # 内容客户端端口 + 离线桩
  publishing/         # 上架编排（内容 → 决策 → 审批 → 通道 upsert/publish）
  aftersale/          # 退款状态机
  fulfillment/        # 库存手工维护 + 履约/支付 501 占位
  api/routes.ts       # HTTP v1 路由
  services.ts         # 组合根（DecisionPort 注入）
  serve.ts            # 入口（迁移 → 装配 → listen）
db/migrations/        # sqlite / postgres 配对迁移
recordings/           # 沙箱通道录制样例
tests/                # 单测 + 全链路 e2e（GATE-M3）
```

## 快速开始

```bash
npm install
npm run check:migrations   # 双方言迁移配对校验
npm run typecheck
npm run lint
npm test                   # 48 用例（含经假 zeus HTTP 服务器的真实 zeus-client 链路）
npm run build

npm run migrate:up         # 本地 sqlite 迁移（默认 ./data/commerce-os.db）
COMMERCE_API_TOKEN=dev-token npm start   # http://127.0.0.1:8787 （node --experimental-sqlite）
```

`COMMERCE_API_TOKEN` 必须配置：授权为 fail-closed，未配置时服务拒绝启动
（启动日志会打印一行当前授权姿态）。`/api/v1` 运营路由需要
`Authorization: Bearer <token>`；前台公开路由（catalog/cart/webhook）由
各自的 cart token 与 webhook HMAC 保护。

环境变量见 `.env.example`。生产 PostgreSQL：`npm install pg` 后 `COMMERCE_DB_DRIVER=postgres DATABASE_URL=... npm run migrate:pg:up`。

## HTTP 摘要（/api/v1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/channel-accounts` | 注册通道账号（live 通道必须带 `credentialRef`，否则 422 CREDENTIAL_MISSING） |
| POST | `/categories` / POST `/products` | 类目、商品（含 SKU 校验） |
| POST | `/orders/import` | 从通道拉单并幂等落库 |
| POST | `/listings` | 提交上架（内容桩 + zeus 决策；D3 时返回 423 DECISION_HELD） |
| POST | `/listings/:decisionId/approve` · `/reject` | 上架审批 |
| POST | `/refunds` | 发起退款（金额按订单行计算；D2 时 423） |
| POST | `/refunds/:id/decision` | 退款审批（approve 后才调用通道退款） |
| POST | `/inventory` | 手工维护库存 |
| POST | `/fulfillment/ship` · `/payments` | 501 占位（M3 不实现） |
| GET | `/events` | 本地审计事件流 |

错误体统一为 `{ error: { code, message, retryable, details? } }`，错误码与 HTTP 映射见 `src/util/errors.ts`。

## GATE-M3 验收

`tests/e2e-loop.test.ts` 与 `tests/http-smoke.test.ts` 覆盖一条无外部凭据的完整闭环：

商品（SKU-DEMO-001）→ 内容桩 → 上架决策（D3，外部动作）挂起 → 人工审批 → 沙箱 upsert + 发布（商品 listed）→ 沙箱订单回传（1299 CNY 已支付，幂等）→ 退款决策（D2）挂起 → 人工审批 → 沙箱退款成功；每个关键节点均有 `commerce_events` 与 zeus decision 记录。

## M3 边界（有意不做）

- 不接真实抖店/任何 live 通道：需要资质与密钥（`credentialRef` → 密钥后端），未接前 fail-closed
- 不接模型 key：内容为离线桩（M4 接 loom 内容底座）
- 不做真实支付/物流：支付在平台外部（订单导入时已支付），物流后续里程碑
- 不做多租户（沿用 zeus M2 自用口径）

## 关联文档

- `../bayjf/docs/tier0/Tier0-组合级PRD.md`（§11 五项拍板：自营、通道先走桩/沙箱、D2、500/5000、M1→M5 串行）
- `../bayjf/docs/tier0/Tier0-设计文档.md`（§4.6 通道契约、§5.2 数据模型、§6.3/§6.4 流程）
- `../bayjf/docs/tier0/Tier0-落码任务列表.md`（T-M3-01 ~ T-M3-10、GATE-M3）
