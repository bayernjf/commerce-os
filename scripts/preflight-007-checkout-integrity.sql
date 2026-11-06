-- preflight-007-checkout_integrity.sql (postgres dialect)
-- Read-only preflight for 007_checkout_integrity. Run before the migration;
-- every statement is a SELECT and writes nothing.
--
-- 007 adds checkouts.provider and the payments.checkout_id unique index.
-- Two failure modes it screens for:
--   * schema_migrations has no 007 row but the objects already exist
--     (a half-applied window created by a manual run or a crashed job);
--   * payments already holds duplicate checkout_id values, which makes
--     CREATE UNIQUE INDEX fail mid-migration.
--
-- 判读：逐条看输出。P0/P6 的 verdict 为 STOP 时不要直接重跑 007，
-- 先按 verdict 的提示处理（补 ledger 行或清理重复付款行）再迁移。

-- P0) 迁移账本是否存在，以及 003/005/006/007 的记录状态。
--     无输出且 to_regclass 为 NULL 时，说明 001 还没跑过：按顺序整批迁移。
SELECT to_regclass('public.schema_migrations') AS schema_migrations_table;

SELECT version, applied_at
  FROM schema_migrations
 WHERE version IN ('003_storefront', '005_checkout_snapshot', '006_refund_line_usage', '007_checkout_integrity')
 ORDER BY version;

-- P1) checkout_* 相关表是否存在（本库为 checkouts）。
SELECT tablename
  FROM pg_tables
 WHERE schemaname = current_schema()
   AND tablename LIKE 'checkout%'
 ORDER BY tablename;

-- P2) checkouts 表与 007 要新增的 provider 列。
SELECT to_regclass('public.checkouts') AS checkouts_table;

SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'checkouts'
            AND column_name = 'provider'
       ) AS provider_column_exists;

-- P3) payments 表是否存在。
SELECT to_regclass('public.payments') AS payments_table;

-- P4) 重复的 checkout_id（NULL 不参与唯一索引，排除）。期望 0 行。
--     有输出时先人工核对：这些行一旦建唯一索引就会冲突，迁移会失败。
SELECT checkout_id, COUNT(*) AS duplicate_rows
  FROM payments
 WHERE checkout_id IS NOT NULL
 GROUP BY checkout_id
HAVING COUNT(*) > 1
 ORDER BY duplicate_rows DESC, checkout_id;

-- P5) 唯一索引是否已存在（含 checkout_ 相关索引一览）。
SELECT indexname
  FROM pg_indexes
 WHERE schemaname = current_schema()
   AND indexname LIKE 'checkout%'
 ORDER BY indexname;

SELECT EXISTS (
         SELECT 1
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'payments'
            AND indexname = 'payments_checkout_id_uniq'
       ) AS payments_unique_index_exists;

-- P6) 综合判定：账本记录与对象状态是否一致。
WITH state AS (
  SELECT
    EXISTS (
      SELECT 1 FROM schema_migrations WHERE version = '007_checkout_integrity'
    ) AS ledger_applied,
    EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'checkouts'
         AND column_name = 'provider'
    ) AS column_exists,
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'payments'
         AND indexname = 'payments_checkout_id_uniq'
    ) AS index_exists
)
SELECT ledger_applied,
       column_exists,
       index_exists,
       CASE
         WHEN ledger_applied AND column_exists AND index_exists
           THEN 'OK: already applied; a re-run is a no-op'
         WHEN NOT ledger_applied AND NOT column_exists AND NOT index_exists
           THEN 'OK: safe to apply 007'
         WHEN NOT ledger_applied
           THEN 'STOP: objects partially exist without a ledger row; inspect before re-run'
         ELSE 'STOP: ledger says applied but objects are missing; inspect schema drift'
       END AS verdict
  FROM state;
