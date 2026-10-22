-- 001_init.sql (sqlite dialect)
-- commerce-os M3 minimal loop schema (design §5.2).
-- Application-generated ids; timestamps are ISO-8601 text set by the app.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,              -- 'sandbox-douyin' | 'douyin' | 'xiaohongshu' ...
  display_name TEXT NOT NULL,
  credential_ref TEXT,                -- secret id only; never the secret itself
  status TEXT NOT NULL,               -- 'active' | 'disabled'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  channel TEXT,                       -- optional channel scope
  name TEXT NOT NULL,
  parent_id TEXT,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,                -- SPU
  channel_account_id TEXT,
  external_ref TEXT,                  -- channel-side product id once upserted
  title TEXT NOT NULL,
  category_id TEXT,
  status TEXT NOT NULL,               -- 'draft' | 'listed' | 'delisted'
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
  price REAL NOT NULL,
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
  status TEXT NOT NULL,               -- 'imported' | 'paid' | 'fulfilling' | 'completed' | 'refunded' | 'closed'
  total_amount REAL NOT NULL,
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
  price REAL NOT NULL,
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
  lines_json TEXT NOT NULL,           -- [{orderItemId, qty, amount}]
  reason TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'requested' | 'awaiting_approval' | 'approved' | 'succeeded' | 'rejected' | 'failed'
  decision_id TEXT,
  external_refund_ref TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS fulfillments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'placeholder' only in M3
  tracking_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- Local commerce audit trail (every key action: product/order/refund/decision)
CREATE TABLE IF NOT EXISTS commerce_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,           -- 'product.created' | 'order.imported' | 'decision.requested' | 'refund.succeeded' ...
  ref_type TEXT,
  ref_id TEXT,
  decision_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
