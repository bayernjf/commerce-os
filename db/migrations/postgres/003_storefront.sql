-- 003_storefront.sql (postgres dialect)
-- L0 storefront 前台数据模型（Tier0-独立站双用方案 v1.0 §5.2）。
-- 多租户预留（D1=A 已拍板）：merchants 单行种子（owner），L2 扩为真实租户；
-- 新表直接带 merchant_id，既有表（001/002）不动。
-- 金额用微元整数（amount_micros），避免浮点误差；行级快照，改价不追溯。

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- L0 单行种子（D1=A）：owner 租户，L2 扩多租户时经新迁移注册真实租户。
INSERT INTO merchants (id, slug, name, created_at) VALUES ('mer_owner', 'owner', 'Owner', '2026-10-28T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  channel TEXT NOT NULL,               -- 'storefront'
  status TEXT NOT NULL,                -- 'open' | 'checked_out' | 'abandoned'
  created_at TEXT NOT NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  product_id TEXT NOT NULL,            -- SPU 引用（商品投影取 listed 状态）
  sku_id TEXT,
  qty INTEGER NOT NULL,
  unit_amount_micros INTEGER NOT NULL, -- 行级金额快照
  FOREIGN KEY (cart_id) REFERENCES carts(id),
  FOREIGN KEY (sku_id) REFERENCES skus(id)
);

CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  order_id TEXT,                       -- 结算成功后回填（importOrder 幂等）
  payment_id TEXT,
  status TEXT NOT NULL,                -- 'pending' | 'approved' | 'rejected' | 'paid' | 'failed'
  decision_id TEXT,                    -- D3 阈值审批挂起
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (cart_id) REFERENCES carts(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- 'fake' | 'stripe'
  status TEXT NOT NULL,                -- 'created' | 'confirmed' | 'failed' | 'refunded'
  external_ref TEXT,
  amount_micros INTEGER NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}', -- webhook 证据
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (checkout_id) REFERENCES checkouts(id)
);

COMMENT ON TABLE merchants IS '商户（租户预留，D1=A：L0 单行种子，L2 扩多租户）';
COMMENT ON TABLE carts IS 'storefront 匿名购物车（会话级）';
COMMENT ON TABLE cart_items IS '购物车行（金额快照，改价不追溯）';
COMMENT ON TABLE checkouts IS '结算记录（D3 审批挂起态）';
COMMENT ON TABLE payments IS '支付记录（PaymentPort 落点，raw 为 webhook 证据）';
