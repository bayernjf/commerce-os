# Change: commerce-os audit gate

- Change ID: `CHG-2026-11-22-01`
- Product: `commerce-os`
- Risk tier: `R2`（只新增审计门禁，不改业务运行时）
- Status: `verify passed`；本地已提交，未 push；CI 接入待 `code-audit` 0.3.0 推送后补

## Intent

让 `commerce-os` 的验证命令从“CI 里散落的 step”变成一份可复现、可追溯、带证据哈希的审计合同。fast 供本地快速反馈，release 供发布前门禁；后续 release gate 可以直接消费 `report.json`。

## Non-goals

- 不改业务代码、迁移、API 或运行时行为。
- 不把 AI review 放进 `code-audit`；本次只做确定性证据。
- 不在本次引入跨模型 verifier 或自动发布。

## Acceptance

- `AC-01`：`fast` profile 只执行 `typecheck` + `lint`，全绿退出码 0。
- `AC-02`：`release` profile 执行 migrations、typecheck、lint、secrets、test、build，全绿退出码 0。
- `AC-03`：`report.json` 包含 `profile`、`summary`、每个 check 的 `kind`、`acceptanceIds` 和 evidence 的 SHA-256。
- `AC-04`：未知 profile 以配置错误退出码 2，不执行任何检查。

## Evidence

- Fast: `node ../code-audit/dist/cli.js --repo . --config audit.config.json --profile fast --out .code-audit/fast`
  - 结果：2/2 passed。
- Release: `node ../code-audit/dist/cli.js --repo . --config audit.config.json --profile release --out .code-audit/release`
  - 结果：6/6 passed；migrations 231ms、typecheck 1332ms、lint 1019ms、secrets 4248ms、test 5932ms、build 1002ms（2026-11-22 复核运行）。
  - `report.json`: `.code-audit/release/report.json`
  - `report.sarif`: `.code-audit/release/report.sarif`
  - evidence: 12 个日志文件，SHA-256 已写入 `report.json`。
- Config validation: `node ../code-audit/dist/cli.js ... --profile missing` → `config error: unknown profile: missing`，exit 2。

## Rollback

回滚本次变更只需删除 `audit.config.json`、`.gitignore` 中的 `.code-audit/` 行，以及 CI 的 release audit 步骤；不涉及数据或运行时迁移。

## Follow-up

- `code-audit` 0.3.0 推送后，把 release audit 接入 CI 并上传 `.code-audit/release` artifact。
- 补 release manifest 生成器（当前 `report.json` 已具备所需字段）。
- 把同一 profile 模式复制到 growth-os / zeus。
- R3 变更再加独立 verifier 和人工签收。
