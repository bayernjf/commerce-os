-- 005_checkout_snapshot.sql (postgres dialect)
-- Tier0 code review 2026-10-30 (H5): bind checkout approval to the cart line
-- snapshot taken at checkout time. checkouts stores total_micros / currency /
-- lines_digest when the decision is requested; approve re-reads the cart lines
-- and refuses (409 CONFLICT) when they drifted, asking for a fresh checkout.

ALTER TABLE checkouts ADD COLUMN total_micros BIGINT;
ALTER TABLE checkouts ADD COLUMN currency TEXT;
ALTER TABLE checkouts ADD COLUMN lines_digest TEXT;
