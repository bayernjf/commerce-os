// Cart island (SF-11): add-to-cart + mini cart + checkout with D3 pending state.
// Runs in the browser (client:load). The cart token is an anonymous, stateless
// session credential scoped to the cart — stored in localStorage; the API base
// URL is injected from the Astro SSR layer (never read from client env).
import { useCallback, useEffect, useRef, useState } from 'react';

export interface CartIslandProps {
  productId: string;
  skuId: string;
  priceLabel: string;
  apiBase: string;
}

interface CartItem {
  id: string;
  productId: string;
  skuId: string;
  qty: number;
  unitAmountMicros: number;
  skuCode: string;
  currency: string;
}

type CheckoutState =
  | { kind: 'idle' }
  | { kind: 'pending'; decisionId: string; checkoutId: string }
  | { kind: 'paid'; orderId: string; totalMicros: number }
  | { kind: 'failed'; message: string };

const TOKEN_KEY = 'bay_cart_token';

export default function CartIsland({ productId, skuId, priceLabel, apiBase }: CartIslandProps) {
  const [token, setToken] = useState<string | null>(() =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY),
  );
  const [cartId, setCartId] = useState<string | null>(null);
  const [items, setItems] = useState<CartItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState>({ kind: 'idle' });
  const inFlight = useRef(false);

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    'content-type': 'application/json',
    ...(token ? { authorization: `Cart ${token}` } : {}),
    ...extra,
  });

  const ensureCart = useCallback(async (): Promise<string> => {
    if (cartId) return cartId;
    const res = await fetch(`${apiBase}/api/v1/storefront/carts`, { method: 'POST' });
    if (!res.ok) throw new Error(`创建购物车失败 (${res.status})`);
    const body = (await res.json()) as { cart: { id: string }; cartToken?: string };
    if (body.cartToken) {
      localStorage.setItem(TOKEN_KEY, body.cartToken);
      setToken(body.cartToken);
    }
    setCartId(body.cart.id);
    return body.cart.id;
  }, [apiBase, cartId]);

  const loadCart = useCallback(async () => {
    if (!token || !cartId) return;
    const res = await fetch(`${apiBase}/api/v1/storefront/carts/${cartId}`, { headers: headers() });
    if (!res.ok) return;
    const body = (await res.json()) as { items: CartItem[] };
    setItems(body.items);
  }, [apiBase, token, cartId]);

  useEffect(() => {
    if (token && !cartId) {
      // Token without a cart id cannot happen (token encodes the cart), so
      // nothing to hydrate here; items load right after the first add.
    }
  }, [token, cartId]);

  const addToCart = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const id = await ensureCart();
      const res = await fetch(`${apiBase}/api/v1/storefront/carts/${id}/items`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ productId, skuId, qty: 1 }),
      });
      if (!res.ok) throw new Error(`加入购物车失败 (${res.status})`);
      await loadCart();
      setNotice('已加入购物车');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const checkoutNow = async (): Promise<void> => {
    if (!token || !cartId) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/storefront/carts/${cartId}/checkout`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setCheckout({ kind: 'failed', message: errBody?.error?.message ?? `结算失败 (${res.status})` });
        return;
      }
      const body = (await res.json()) as {
        checkout: { id: string; status: string; decisionId?: string; orderId?: string; totalMicros: number };
      };
      const c = body.checkout;
      if (c.status === 'pending') {
        setCheckout({ kind: 'pending', decisionId: c.decisionId ?? '', checkoutId: c.id });
      } else if (c.status === 'paid') {
        setCheckout({ kind: 'paid', orderId: c.orderId ?? '', totalMicros: c.totalMicros });
      } else {
        setCheckout({ kind: 'failed', message: `结算状态异常：${c.status}` });
      }
    } catch (err) {
      setCheckout({ kind: 'failed', message: err instanceof Error ? err.message : '网络错误' });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const totalMicros = items.reduce((sum, it) => sum + it.unitAmountMicros * it.qty, 0);
  const fmt = (micros: number): string =>
    new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(micros / 1_000_000);

  return (
    <div className="cart-island" style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void addToCart()}
          style={{ padding: '10px 18px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
        >
          {busy ? '处理中…' : `加入购物车 · ${priceLabel}`}
        </button>
        {notice ? <span style={{ color: '#059669', fontSize: 13 }}>{notice}</span> : null}
      </div>

      {items.length > 0 ? (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>购物车（{items.reduce((s, it) => s + it.qty, 0)} 件）</div>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151' }}>
              <span>{it.skuCode} × {it.qty}</span>
              <span>{fmt(it.unitAmountMicros * it.qty)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e5e7eb', paddingTop: 8, fontWeight: 600 }}>
            <span>合计</span>
            <span>{fmt(totalMicros)}</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkoutNow()}
            style={{ padding: '10px 18px', background: '#b45309', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
          >
            {busy ? '结算中…' : '结算'}
          </button>

          {checkout.kind === 'pending' ? (
            <div style={{ border: '1px solid #d97706', background: '#fffbeb', color: '#92400e', borderRadius: 8, padding: 10, fontSize: 13 }}>
              <strong>结算已提交，等待人工审批（D3）</strong>
              <div>决策单号：{checkout.decisionId}</div>
              <div style={{ color: '#b45309', marginTop: 4 }}>审批通过后将自动完成支付，请稍后在订单状态页查看。</div>
            </div>
          ) : checkout.kind === 'paid' ? (
            <div style={{ border: '1px solid #059669', background: '#ecfdf5', color: '#065f46', borderRadius: 8, padding: 10, fontSize: 13 }}>
              <strong>支付成功 🎉</strong>
              <div>订单号：{checkout.orderId} · 实付 {fmt(checkout.totalMicros)}</div>
              {cartId ? <div><a href={`/orders/${cartId}`} style={{ color: '#065f46', fontWeight: 600 }}>查看订单详情 →</a></div> : null}
            </div>
          ) : checkout.kind === 'failed' ? (
            <div style={{ border: '1px solid #dc2626', background: '#fef2f2', color: '#991b1b', borderRadius: 8, padding: 10, fontSize: 13 }}>
              结算失败：{checkout.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
