import type { StorageDriver } from '../storage/driver.js';
import type { EventLog } from '../storage/event-log.js';

export interface OrderMetrics {
  total: number;
  paid: number;
  completed: number;
  grossAmount: number;
}

export interface RefundMetrics {
  total: number;
  succeeded: number;
  refundedAmount: number;
}

export interface ContentMetrics {
  /** product.listed events (published content references). */
  published: number;
}

export interface DashboardMetrics {
  /** Single-currency internal-operating basis; multi-currency needs grouping. */
  currency: string;
  orders: OrderMetrics;
  refunds: RefundMetrics;
  content: ContentMetrics;
  /** Gross order amount minus succeeded refunds (excludes cost). */
  netAmount: number;
  generatedAt: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const PAID_STATUSES = new Set(['paid', 'fulfilling', 'completed', 'refunded', 'closed']);

/**
 * Read-only operating dashboard (T-M5-04). Aggregation is done in JS over
 * stored rows so the queries stay dialect-portable. Metrics are computed
 * from persisted data, never from client input.
 */
export class DashboardService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly events: EventLog,
  ) {}

  async getMetrics(): Promise<DashboardMetrics> {
    const orderRows = await this.driver.all<Record<string, unknown>>('SELECT * FROM orders', []);
    const refundRows = await this.driver.all<Record<string, unknown>>('SELECT * FROM refunds', []);
    const listedEvents = await this.events.list({ eventType: 'product.listed' });

    const grossAmount = round2(
      orderRows.reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0),
    );
    const orders: OrderMetrics = {
      total: orderRows.length,
      paid: orderRows.filter((r) => PAID_STATUSES.has(String(r.status))).length,
      completed: orderRows.filter((r) => r.status === 'completed').length,
      grossAmount,
    };

    const succeededRows = refundRows.filter((r) => r.status === 'succeeded');
    let refundedAmount = 0;
    for (const r of succeededRows) {
      try {
        const lines = JSON.parse(String(r.lines_json)) as { amount?: number }[];
        refundedAmount += lines.reduce((sum, l) => sum + Number(l.amount ?? 0), 0);
      } catch {
        // Malformed lines contribute zero; a real row is written by the service.
      }
    }
    const refunds: RefundMetrics = {
      total: refundRows.length,
      succeeded: succeededRows.length,
      refundedAmount: round2(refundedAmount),
    };

    const content: ContentMetrics = { published: listedEvents.length };

    return {
      currency: 'CNY',
      orders,
      refunds,
      content,
      netAmount: round2(grossAmount - refunds.refundedAmount),
      generatedAt: new Date().toISOString(),
    };
  }
}
