-- Cumulative refund guard: one row per order item tracking how much has
-- already been refunded (qty + amount in cents). Rows are created lazily by
-- the conditional upsert in AftersaleService.reserveLines; the upsert only
-- succeeds while the cumulative total stays within the purchased qty/amount,
-- which makes over-refunding impossible even under concurrent requests.
CREATE TABLE IF NOT EXISTS refund_line_usage (
  order_item_id TEXT PRIMARY KEY,
  refunded_qty INTEGER NOT NULL DEFAULT 0,
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Idempotent refund submission: a client-supplied key makes replayed requests
-- return the original refund instead of paying out twice.
ALTER TABLE refunds ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS refunds_idempotency_key_idx
  ON refunds (idempotency_key) WHERE idempotency_key IS NOT NULL;
