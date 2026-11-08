# 备份与恢复（commerce-os）

> 脚本：`scripts/backup-commerce.mjs`（备）、`scripts/restore-commerce.mjs`（回）。
> 原则：备份必须能安全恢复才算数；恢复失败一律 fail-closed。

## 1. 备份范围

单文件 SQLite：`COMMERCE_SQLITE_PATH`（compose 内为 `/data/commerce-os.db`）。

不可重建的不是订单，而是**退款额度账本**：`refund_line_usage` 记录了每条订单线已退多少，
它是并发安全的准入账本（`reserveLines` 的数据库级闸），无法从订单反推。丢了它，既无法证明
历史退款，也无法继续正确拒绝超额退款。

其他纳入计数的表：`orders`、`order_items`、`payments`、`refunds`、`checkouts`、
`fulfillments`、`commerce_events`。

## 2. 备份

`npm run backup:state`，或由 compose 的 `backup` sidecar 按 `COMMERCE_BACKUP_INTERVAL_SECONDS`
（默认 86400）自动执行。

```bash
node --experimental-sqlite scripts/backup-commerce.mjs \
  --db ./data/commerce-os.db --dir ./backups --keep 7
```

每次产出 `backups/snapshot-<stamp>/`：`commerce-os.db` + `manifest.json`（含 sha256、字节数、
每表计数）。`integrity_check` 或计数校验失败的快照**直接删除**，不留"看起来成功"的坏备份。
文件 `0600`、目录 `0700`。

`./backups` 已在 `.gitignore` 与 `.dockerignore` 中排除：快照含订单与退款数据，不能入库、
不能进镜像。

## 3. 恢复

```bash
node --experimental-sqlite scripts/restore-commerce.mjs \
  --snapshot ./backups/snapshot-20261108T075120 --force
```

脚本行为：

- 必须有 `manifest.json`，且计数与快照实测一致（不一致 = 快照被改过，拒绝）；
- 快照里没有 `orders` 表 → 拒绝（一个校验通过但没有业务表的文件不是 commerce 库）；
- 目标已存在且无 `--force` → 拒绝；`--force` 时旧库保留为 `<target>.pre-restore-<stamp>`；
- 复制后复校验一次才报告成功；
- `COMMERCE_DB_DRIVER` 不是 `sqlite` 时显式拒绝，提示改用 `pg_dump`。

## 4. 回滚代码靠镜像 tag

发布前先 `docker tag commerce-os:latest commerce-os:<stamp>` 保存当版，**保留 3 个**
（当前 + 2 个上一版）；回滚时：

```bash
COMMERCE_IMAGE_TAG=<stamp> docker compose up -d
```

`COMMERCE_IMAGE_TAG` 默认是 `latest`，这与现有部署方式一致，但**默认值本身不是
回滚锚点**：任何一次重建都会覆盖 `latest`，不带环境变量的 `docker compose up -d`
只是部署“最后一次构建”，无法回答“线上现在是哪一版”。改成强制显式版本
（`${COMMERCE_IMAGE_TAG:?}`）的代价是：所有既有部署脚本、cron 和手工命令都必须
先设置该变量，否则 compose 直接启动失败；因此本次不改默认行为，只在发布流程里
要求显式传入 stamp。

**这条路径会在什么情况下失效**

- tag 只在本地 Docker daemon：换机、`docker image prune` 或清理构建缓存后不存在。
  本仓没有 registry 推送流程，不能当作跨机回滚方案。
- 只留 `latest`、不额外打 tag：数据能回、代码回不去。
- 跨机保留需 `docker save commerce-os:<stamp> | gzip` 异地保存，目标机
  `docker load`；仍不等价于 registry 的不可变 digest。

镜像 tag 只回代码；数据回滚见 §3 的 `restore-commerce.mjs`。

## 5. 演练记录（2026-11-08）

| 场景 | 结果 |
|---|---|
| 正常备份 | `orders=2`、`refund_line_usage=2` |
| 有数据恢复 | 直查 `orders 2`、额度合计 `8800` 分，与备份前一致 |
| 目标存在无 `--force` | 拒绝，`exit 1` |
| 篡改 manifest 计数 | 拒绝（`orders expected 5, found 0`），`exit 1` |
| 快照截断 | 拒绝（`database disk image is malformed`），`exit 1` |
| 空库快照 | 拒绝（`is not a migrated commerce-os database`），`exit 1` |
| 侧车循环 | 每 2 秒一次快照，`--keep 2` 剪枝正确 |

尚未做：异地副本。
