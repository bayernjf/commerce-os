-- 004_webhook.sql (postgres dialect)
-- Payments webhook deliveries（SF-07）：HMAC 验签 + delivery 幂等 + 事件审计。
-- (provider, delivery_id) 唯一 → 重复投递不重复处理；rejected 行留痕坏签名审计。

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payment_id TEXT,
  status TEXT NOT NULL,                -- 'processed' | 'duplicate' | 'rejected'
  raw_json TEXT NOT NULL DEFAULT '{}', -- 原始投递载荷（审计证据）
  created_at TEXT NOT NULL,
  UNIQUE (provider, delivery_id)
);

COMMENT ON TABLE webhook_deliveries IS '支付网关 webhook 投递记录（SF-07：验签 + 幂等 + 审计）';
