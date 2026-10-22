# AGENTS.md

本仓是 Tier0 组合级落码 M3 的产物，AI 协作者必须遵守。

## 状态入口

- `handoff.md` 是本仓状态、待办、基线的唯一主入口，开工前先读它。
- 每完成一个工作单元，立即更新 `handoff.md`（已完成划掉、待办保留），并同步项目仓 `../Tier0-深度分析/handoff.md`。

## 工程纪律

- Node ≥ 22，ESM（`type: module`），import 路径必须带 `.js` 后缀。
- TypeScript 严格全开：`strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noUnusedLocals` / `noUnusedParameters`。可选字段在 exactOptional 下只能用条件展开（`...(x ? { k: x } : {})`），禁止显式赋 `undefined`。
- 业务代码只用 `?` 占位符 SQL；方言差异只能出现在 `src/storage/`。新增迁移必须同时写 `db/migrations/sqlite/` 与 `db/migrations/postgres/`，编号文件名一一对应，跑 `npm run check:migrations`。
- 决策一律走 `DecisionPort`（HTTP 到 zeus），禁止在本仓实现任何分级逻辑；zeus 不可用必须 fail-closed。
- 通道：新增通道 = 实现 `ChannelAdapter` + 在 `src/channel/index.ts` 注册一行。live 通道没有 `credentialRef` 必须拒绝；沙箱通道不触网、只回放 `recordings/`。
- 履约/支付未实现的接口必须返回 501 `NOT_IMPLEMENTED_PLACEHOLDER`，禁止伪成功。
- 金额从订单行计算，不信任客户端传入金额；所有关键动作写 `commerce_events`。

## 验证门（交付前全绿）

```bash
npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build
```

测试经 `tests/helpers/fake-zeus-server.ts` 起真实 HTTP 服务器，让 `zeus-client` 走完整网络路径；禁止用本地分级替身替代。

## 提交

- 英文原子提交：`<type>(<scope>): <subject>`，按任务分组；**不 push**。
- 提交作者必须是用户本人，禁止 AI co-author trailer。
- 未授权不得 commit。
