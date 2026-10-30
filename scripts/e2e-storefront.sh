#!/usr/bin/env bash
# GATE-S1 storefront e2e (SF-13): real zeus + real commerce (+ console) full loop.
#
# Starts the real zeus decision server and the real commerce API from their
# committed dist builds, optionally the ops-console, then drives the complete
# shopper journey and asserts every step: cart -> add item -> checkout
# (pending, real zeus decision) -> approve -> paid -> order status -> refund
# request (423, D2 held) -> approve refund -> succeeded -> refund list.
#
# Usage:
#   bash scripts/e2e-storefront.sh          # zeus + commerce only
#   bash scripts/e2e-storefront.sh --with-console
#
# Env overrides: ZEUS_DIR COMMERCE_DIR CONSOLE_DIR ZEUS_PORT COMMERCE_PORT
#               CONSOLE_PORT ZEUS_TOKEN COMMERCE_TOKEN COMMERCE_CART_SECRET
set -euo pipefail

COMMERCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZEUS_DIR="${ZEUS_DIR:-/Users/jiangfeng/000mycodes/zeus}"
CONSOLE_DIR="${CONSOLE_DIR:-/Users/jiangfeng/000mycodes/ops-console}"
ZEUS_PORT="${ZEUS_PORT:-3020}"
COMMERCE_PORT="${COMMERCE_PORT:-3021}"
CONSOLE_PORT="${CONSOLE_PORT:-3022}"
ZEUS_TOKEN="${ZEUS_TOKEN:-local-zeus-token}"
COMMERCE_TOKEN="${COMMERCE_TOKEN:-local-commerce-token}"
CART_SECRET="${COMMERCE_CART_SECRET:-cart-secret-e2e}"
WITH_CONSOLE="${1:-}"

DATA_DIR="$(mktemp -d /tmp/gate-s1.XXXXXX)"
ZEUS_PID=""
COMMERCE_PID=""
CONSOLE_PID=""

cleanup() {
  [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
  [ -n "$COMMERCE_PID" ] && kill "$COMMERCE_PID" 2>/dev/null || true
  [ -n "$ZEUS_PID" ] && kill "$ZEUS_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok: %s\n' "$*"; }

# --- start real zeus ---------------------------------------------------------
step "start real zeus on :$ZEUS_PORT"
[ -f "$ZEUS_DIR/dist/http/serve.js" ] || fail "zeus dist missing; run npm run build in $ZEUS_DIR"
(
  cd "$ZEUS_DIR"
  ZEUS_PORT="$ZEUS_PORT" ZEUS_HOST=127.0.0.1 ZEUS_INTERNAL_TOKEN="$ZEUS_TOKEN" \
  ZEUS_DB_FILE="$DATA_DIR/zeus.db" node dist/http/serve.js > "$DATA_DIR/zeus.log" 2>&1 &
  echo $! > "$DATA_DIR/zeus.pid"
)
ZEUS_PID="$(cat "$DATA_DIR/zeus.pid")"
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:$ZEUS_PORT/healthz" && break
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$ZEUS_PORT/healthz" || { tail -5 "$DATA_DIR/zeus.log"; fail "zeus did not come up"; }
ok "zeus healthz 200"

# --- start real commerce ------------------------------------------------------
step "start real commerce on :$COMMERCE_PORT"
[ -f "$COMMERCE_DIR/dist/serve.js" ] || fail "commerce dist missing; run npm run build in $COMMERCE_DIR"
(
  cd "$COMMERCE_DIR"
  COMMERCE_PORT="$COMMERCE_PORT" COMMERCE_HOST=127.0.0.1 \
  COMMERCE_SQLITE_PATH="$DATA_DIR/commerce.db" \
  ZEUS_BASE_URL="http://127.0.0.1:$ZEUS_PORT" ZEUS_INTERNAL_TOKEN="$ZEUS_TOKEN" \
  COMMERCE_API_TOKEN="$COMMERCE_TOKEN" COMMERCE_STOREFRONT_CART_SECRET="$CART_SECRET" \
  node --experimental-sqlite dist/serve.js > "$DATA_DIR/commerce.log" 2>&1 &
  echo $! > "$DATA_DIR/commerce.pid"
)
COMMERCE_PID="$(cat "$DATA_DIR/commerce.pid")"
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:$COMMERCE_PORT/api/v1/storefront/catalog" && break
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$COMMERCE_PORT/api/v1/storefront/catalog" || { tail -5 "$DATA_DIR/commerce.log"; fail "commerce did not come up"; }
ok "commerce catalog 200"

# --- optionally ops-console ----------------------------------------------------
if [ "$WITH_CONSOLE" = "--with-console" ]; then
  step "start ops-console on :$CONSOLE_PORT"
  [ -f "$CONSOLE_DIR/dist/server/entry.mjs" ] || fail "console dist missing; run npm run build in $CONSOLE_DIR"
  (
    cd "$CONSOLE_DIR"
    node --experimental-sqlite dist/server/entry.mjs > "$DATA_DIR/console.log" 2>&1 &
    echo $! > "$DATA_DIR/console.pid"
  )
  CONSOLE_PID="$(cat "$DATA_DIR/console.pid")"
  for _ in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CONSOLE_PORT/" || true)"
    [ "$code" = "302" ] && break
    sleep 0.5
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CONSOLE_PORT/" || true)" = "302" ] \
    || { tail -5 "$DATA_DIR/console.log"; fail "console did not come up"; }
  ok "console / -> 302 (login gate)"
fi

# --- seed product --------------------------------------------------------------
step "seed product"
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DATA_DIR/commerce.db');
db.exec(\"INSERT INTO products (id, title, status, attributes_json, created_at, updated_at) VALUES ('prd_e2e', 'E2E 全链路商品', 'listed', '{}', datetime('now'), datetime('now'))\");
db.exec(\"INSERT INTO skus (id, product_id, sku_code, specs_json, price, currency, status, created_at, updated_at) VALUES ('sku_e2e', 'prd_e2e', 'SKU-E2E-1', '{}', 1999, 'CNY', 'active', datetime('now'), datetime('now'))\");
db.close();
"
ok "product prd_e2e / sku sku_e2e"

API="http://127.0.0.1:$COMMERCE_PORT/api/v1"
CT="Content-Type: application/json"
OPS="Authorization: Bearer $COMMERCE_TOKEN"

json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log($1)})"; }

# --- shopper journey ------------------------------------------------------------
step "create cart"
CJ="$(curl -sf -X POST "$API/storefront/carts")"
CART="$(printf '%s' "$CJ" | json 'o.cart.id')"
TOKEN="$(printf '%s' "$CJ" | json 'o.cartToken')"
AUTH="Authorization: Cart $TOKEN"
[ -n "$CART" ] && [ -n "$TOKEN" ] || fail "cart create"
ok "cart $CART"

step "add item"
curl -sf -X POST -H "$AUTH" -H "$CT" -d '{"productId":"prd_e2e","skuId":"sku_e2e","qty":1}' "$API/storefront/carts/$CART/items" >/dev/null
ok "item added"

step "checkout (real zeus decision)"
CO="$(curl -sf -X POST -H "$AUTH" -H "$CT" -d '{}' "$API/storefront/carts/$CART/checkout")"
DEC="$(printf '%s' "$CO" | json 'o.checkout.decisionId')"
ST="$(printf '%s' "$CO" | json 'o.checkout.status')"
[ "$ST" = "pending" ] && [ -n "$DEC" ] || fail "checkout not pending (got $ST)"
ok "checkout pending, decision $DEC"

step "approve checkout (real zeus approve)"
PAID="$(curl -sf -X POST -H "$OPS" -H "$CT" -d '{"approver":"owner"}' "$API/storefront/checkouts/$DEC/approve")"
PST="$(printf '%s' "$PAID" | json 'o.checkout.status')"
TOTAL="$(printf '%s' "$PAID" | json 'o.checkout.totalMicros')"
[ "$PST" = "paid" ] && [ "$TOTAL" = "1999000000" ] || fail "approve did not reach paid (got $PST/$TOTAL)"
ok "checkout paid, totalMicros $TOTAL"

step "order status under cart token"
ORD="$(curl -sf -H "$AUTH" "$API/storefront/carts/$CART/order")"
OST="$(printf '%s' "$ORD" | json 'o.order.status')"
ITEM="$(printf '%s' "$ORD" | json 'o.order.lines[0].id')"
[ "$OST" = "paid" ] && [ -n "$ITEM" ] || fail "order status (got $OST)"
ok "order $OST, line $ITEM"

step "request refund (D2 held)"
RF="$(curl -s -w '\n%{http_code}' -X POST -H "$AUTH" -H "$CT" -d "{\"reason\":\"GATE-S1 退款验证\",\"orderItemId\":\"$ITEM\"}" "$API/storefront/carts/$CART/refunds")"
CODE="$(printf '%s' "$RF" | tail -1)"
[ "$CODE" = "423" ] || fail "refund request not 423 (got $CODE)"
RFID="$(printf '%s' "$RF" | head -1 | json 'o.refund.id')"
[ -n "$RFID" ] || fail "refund id"
ok "refund $RFID parked at 423"

step "approve refund (real zeus approve -> storefront fake payout)"
SET="$(curl -sf -X POST -H "$OPS" -H "$CT" -d '{"verdict":"approve","approver":"owner"}' "$API/refunds/$RFID/decision")"
RST="$(printf '%s' "$SET" | json 'o.refund.status')"
RREF="$(printf '%s' "$SET" | json 'o.refund.externalRefundRef || "-"')"
[ "$RST" = "succeeded" ] || fail "refund not succeeded (got $RST)"
ok "refund $RST, externalRefundRef $RREF"

step "refund list shows settled entry"
LIST="$(curl -sf -H "$AUTH" "$API/storefront/carts/$CART/refunds")"
HIT="$(printf '%s' "$LIST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const r=o.refunds.find(x=>x.id==='$RFID');console.log(r&&r.status==='succeeded'?'yes':'no')})")"
[ "$HIT" = "yes" ] || fail "refund list entry"
ok "refund list settled"

step "GATE-S1 PASS (zeus $ZEUS_PORT + commerce $COMMERCE_PORT${WITH_CONSOLE:+ + console $CONSOLE_PORT})"
