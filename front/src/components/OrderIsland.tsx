// Order status island (SF-12): shopper views their order and requests a
// refund. The cart token (anonymous session credential) authorizes reads and
// the refund request; the API base URL is injected from the SSR layer.
import { useCallback, useEffect, useState } from 'react';

export interface OrderIslandProps {
  cartId: string;
  apiBase: string;
}

interface OrderLine {
  id: string;
  externalItemId: string;
  qty: number;
  price: number;
}

interface Order {
  id: string;
  externalOrderId: string;
  status: string;
  totalAmount: number;
  currency: string;
  lines: OrderLine[];
  createdAt: string;
}

interface Refund {
  id: string;
  reason: string;
  status: string;
  createdAt: string;
  lines: { qty: number; amount: number }[];
}

const TOKEN_KEY = 'bay_cart_token';

const STATUS_LABEL: Record<string, string> = {
  imported: '已导入',
  paid: '已支付',
  refunded: '已退款',
  cancelled: '已取消',
  requested: '退款申请中',
  awaiting_approval: '退款待审批',
  approved: '退款已批准',
  succeeded: '退款成功',
  rejected: '退款已拒绝',
  failed: '退款失败',
};

export default function OrderIsland({ cartId, apiBase }: OrderIslandProps) {
  const [token] = useState<string | null>(() =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY),
  );
  const [order, setOrder] = useState<Order | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(token ? { authorization: `Cart ${token}` } : {}),
  });

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const orderRes = await fetch(`${apiBase}/api/v1/storefront/carts/${cartId}/order`, { headers: headers() });
      if (!orderRes.ok) throw new Error(`订单加载失败 (${orderRes.status})`);
      const { order: o } = (await orderRes.json()) as { order: Order };
      setOrder(o);

      const refundRes = await fetch(`${apiBase}/api/v1/storefront/carts/${cartId}/refunds`, { headers: headers() });
      if (refundRes.ok) {
        const { refunds: rs } = (await refundRes.json()) as { refunds: Refund[] };
        setRefunds(rs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiBase, cartId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestRefund = async (lineId: string): Promise<void> => {
    if (!token) return;
    setBusyId(lineId);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/storefront/carts/${cartId}/refunds`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ reason: '客户申请退款', orderItemId: lineId }),
      });
      const body = (await res.json().catch(() => null)) as { refund?: Refund; error?: { message?: string } } | null;
      if (!res.ok || !body?.refund) {
        throw new Error(body?.error?.message ?? `退款申请失败 (${res.status})`);
      }
      setNotice(body.refund.status === 'awaiting_approval' ? '退款申请已提交，等待审批（D2）' : '退款申请已提交');
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '退款申请失败');
    } finally {
      setBusyId(null);
    }
  };

  const fmt = (n: number, currency: string): string =>
    new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);

  if (loading) return <div style={{ color: '#6b7280', fontSize: 14 }}>订单加载中…</div>;
  if (error || !order) {
    return (
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, color: '#6b7280', fontSize: 14 }}>
        {error ?? '未找到订单（该购物车尚未完成结算）'}
      </div>
    );
  }

  return (
    <div className="order-island" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>订单 {order.externalOrderId}</div>
        <span
          style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: order.status === 'paid' ? '#ecfdf5' : '#f3f4f6',
            color: order.status === 'paid' ? '#065f46' : '#374151',
          }}
        >
          {STATUS_LABEL[order.status] ?? order.status}
        </span>
      </div>
      <div style={{ color: '#6b7280', fontSize: 13 }}>下单时间 {new Date(order.createdAt).toLocaleString('zh-CN')} · 实付 {fmt(order.totalAmount, order.currency)}</div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#6b7280', fontSize: 12, textAlign: 'left' }}>
            <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>商品</th>
            <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>数量</th>
            <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>金额</th>
            <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }} />
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id} style={{ fontSize: 13 }}>
              <td style={{ padding: '10px', borderBottom: '1px solid #f3f4f6' }}>{line.externalItemId}</td>
              <td style={{ padding: '10px', borderBottom: '1px solid #f3f4f6' }}>{line.qty}</td>
              <td style={{ padding: '10px', borderBottom: '1px solid #f3f4f6' }}>{fmt(line.price * line.qty, order.currency)}</td>
              <td style={{ padding: '10px', borderBottom: '1px solid #f3f4f6', textAlign: 'right' }}>
                {order.status === 'paid' ? (
                  <button
                    type="button"
                    disabled={busyId === line.id}
                    onClick={() => void requestRefund(line.id)}
                    style={{
                      padding: '6px 12px', background: '#fff', color: '#b45309', border: '1px solid #d97706',
                      borderRadius: 8, cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    {busyId === line.id ? '提交中…' : '申请退款'}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {notice ? (
        <div
          style={{
            padding: '10px 12px', borderRadius: 8, fontSize: 13,
            border: '1px solid #d97706', background: '#fffbeb', color: '#92400e',
          }}
        >
          {notice}
        </div>
      ) : null}

      {refunds.length > 0 ? (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>退款记录</div>
          {refunds.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151' }}>
              <span>
                {r.reason} · {r.lines.reduce((s, l) => s + l.amount, 0).toFixed(2)} {order.currency}
              </span>
              <span>{STATUS_LABEL[r.status] ?? r.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
