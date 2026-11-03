-- 007_checkout_integrity.sql (postgres dialect)
-- Review 2026-11-02 (P2-4/P2-5): checkouts persists the payment provider
-- chosen at checkout time (the approve path reads it back instead of
-- hardcoding 'fake'), and payments gets one row per checkout so a raced
-- double-finalize fails on the unique index before the provider is charged.

ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'fake';
CREATE UNIQUE INDEX IF NOT EXISTS payments_checkout_id_uniq ON payments (checkout_id);
