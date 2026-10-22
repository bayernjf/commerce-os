-- 002_customer_service.sql (postgres dialect)
-- M4/T-M4-04 电商客服占位：会话、消息、应答候选。
-- 客服只对低风险普通咨询自动应答；涉及退款/承诺的候选走决策分级，D2+ 转人工。

CREATE TABLE IF NOT EXISTS cs_conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_customer_id TEXT,
  order_id TEXT,
  status TEXT NOT NULL,              -- 'open' | 'closed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS cs_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- 'customer' | 'agent'
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id)
);

CREATE TABLE IF NOT EXISTS reply_candidates (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  grade TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'proposed' | 'auto_sent' | 'awaiting_human' | 'sent_by_human' | 'discarded'
  decision_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id),
  FOREIGN KEY (message_id) REFERENCES cs_messages(id)
);

COMMENT ON TABLE cs_conversations IS '客服会话，可关联订单';
COMMENT ON TABLE cs_messages IS '会话消息（客户/客服）';
COMMENT ON TABLE reply_candidates IS '客服应答候选，分级后自动发送或转人工';
