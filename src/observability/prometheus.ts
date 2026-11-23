import type { DashboardMetrics } from '../dashboard/dashboard-service.js';

/**
 * Prometheus text exposition (format 0.0.4) for the operating dashboard.
 *
 * `/api/v1/dashboard` answers an operator with JSON; `/metrics` answers the
 * Tier0 collector with the same snapshot. This renderer is a pure projection,
 * so the two faces cannot disagree about a number.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

class Family {
  private readonly samples: string[] = [];

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly type: 'gauge' | 'counter',
  ) {}

  add(value: number, pairs: ReadonlyArray<readonly [string, string]> = []): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(`${this.name}${labels(pairs)} ${value}`);
  }

  render(): string {
    if (this.samples.length === 0) return '';
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n${this.samples.join('\n')}\n`;
  }
}

export function renderPrometheusMetrics(snapshot: DashboardMetrics): string {
  const blocks: string[] = [];
  const push = (family: Family): void => {
    const text = family.render();
    if (text) blocks.push(text);
  };

  const up = new Family('commerce_up', 'Always 1 while the operating dashboard can answer.', 'gauge');
  up.add(1);
  push(up);

  const capturedAt = Date.parse(snapshot.generatedAt) / 1000;
  const captured = new Family(
    'commerce_metrics_snapshot_timestamp_seconds',
    'Unix time the dashboard snapshot was captured; a stale value means the aggregation stopped advancing.',
    'gauge',
  );
  captured.add(capturedAt);
  push(captured);

  const currencyInfo = new Family(
    'commerce_currency_info',
    'Operating currency, as a constant 1 series labelled by ISO 4217 code.',
    'gauge',
  );
  currencyInfo.add(1, [['currency', snapshot.currency]]);
  push(currencyInfo);

  const orders = new Family(
    'commerce_orders',
    'Orders in the operating database, by aggregation bucket. state=all counts every row; paid is the GMV basis.',
    'gauge',
  );
  orders.add(snapshot.orders.total, [['state', 'all']]);
  orders.add(snapshot.orders.paid, [['state', 'paid']]);
  orders.add(snapshot.orders.completed, [['state', 'completed']]);
  push(orders);

  const gross = new Family(
    'commerce_gross_amount',
    'Gross amount of paid orders. Currency is carried as a label; no cross-currency summation happens.',
    'gauge',
  );
  gross.add(snapshot.orders.grossAmount, [['currency', snapshot.currency]]);
  push(gross);

  const refunds = new Family(
    'commerce_refunds',
    'Refund requests, by aggregation bucket. state=all counts every row; succeeded is the refunded-amount basis.',
    'gauge',
  );
  refunds.add(snapshot.refunds.total, [['state', 'all']]);
  refunds.add(snapshot.refunds.succeeded, [['state', 'succeeded']]);
  push(refunds);

  const refunded = new Family(
    'commerce_refunded_amount',
    'Succeeded refund amount, summed from refund lines. Currency is carried as a label.',
    'gauge',
  );
  refunded.add(snapshot.refunds.refundedAmount, [['currency', snapshot.currency]]);
  push(refunded);

  const content = new Family(
    'commerce_content_published',
    'Published content references, derived from product.listed events.',
    'gauge',
  );
  content.add(snapshot.content.published);
  push(content);

  const net = new Family(
    'commerce_net_amount',
    'Gross order amount minus succeeded refunds; excludes cost.',
    'gauge',
  );
  net.add(snapshot.netAmount, [['currency', snapshot.currency]]);
  push(net);

  return blocks.join('\n');
}
