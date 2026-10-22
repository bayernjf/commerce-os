-- 001_init.sql (postgres dialect)
-- commerce-os M3 minimal loop schema (design §5.2).
-- Paired with sqlite/001_init.sql; table/column names must match.
-- Application-generated ids; timestamps are ISO-8601 text set by the app.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credential_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  channel TEXT,
  name TEXT NOT NULL,
  parent_id TEXT,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  channel_account_id TEXT,
  external_ref TEXT,
  title TEXT NOT NULL,
  category_id TEXT,
  status TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  sku_code TEXT NOT NULL UNIQUE,
  specs_json TEXT NOT NULL DEFAULT '{}',
  price NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  channel_account_id TEXT,
  status TEXT NOT NULL,
  total_amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  buyer_ref TEXT,
  created_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (channel, external_order_id),
  FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sku_id TEXT,
  external_sku_code TEXT,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price NUMERIC NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (sku_id) REFERENCES skus(id)
);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL UNIQUE,
  qty_available INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES skus(id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_id TEXT,
  external_refund_ref TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS fulfillments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tracking_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS commerce_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  decision_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

COMMENT ON TABLE channel_accounts IS '店铺通道账号，credential_ref 只存密钥引用不存密钥';
COMMENT ON TABLE orders IS '通道回传订单，按 (channel, external_order_id) 幂等';
COMMENT ON TABLE refunds IS '退款单，关联 zeus decision_id';
COMMENT ON TABLE fulfillments IS 'M3 占位，真实履约在后续里程碑';
COMMENT ON TABLE commerce_events IS 'commerce 侧本地审计事件流';
