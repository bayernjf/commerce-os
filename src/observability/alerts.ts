/**
 * Minimal operational alerting. Every alert is emitted as a structured JSON
 * line on stderr (always captured by the container log pipeline) and, when
 * COMMERCE_ALERT_WEBHOOK is set, POSTed to a generic webhook (e.g. a Feishu
 * bot or a relay). Alert delivery never blocks or throws into business code:
 * a failed webhook is logged and dropped.
 */
export type AlertKind =
  | 'decision_unavailable'
  | 'content_unavailable'
  | 'channel_unavailable'
  | 'process_fatal'
  | 'readiness_failed'
  | 'disk_low';

export type AlertSeverity = 'warning' | 'critical';

export interface AlertDetails {
  [key: string]: unknown;
}

export interface AlertEvent {
  time: string;
  type: 'alert';
  service: 'commerce-os';
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  suppressedCount?: number;
  details?: AlertDetails;
}

/** Cooldown key: same kind+message is collapsed within the window. */
function keyFor(kind: AlertKind, message: string): string {
  return `${kind}:${message}`;
}

export interface AlertReporterOptions {
  webhookUrl?: string;
  /** De-dupe window for repeated identical alerts; default 60s. */
  cooldownMs?: number;
  /** Injection point for tests and for a custom fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AlertReporter {
  private readonly webhookUrl: string | undefined;
  private readonly cooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly lastSent = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();

  constructor(options: AlertReporterOptions = {}) {
    this.webhookUrl = options.webhookUrl;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  report(
    kind: AlertKind,
    severity: AlertSeverity,
    message: string,
    details?: AlertDetails,
  ): void {
    const key = keyFor(kind, message);
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.cooldownMs) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return;
    }
    const suppressedCount = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    this.lastSent.set(key, now);

    const event: AlertEvent = {
      time: new Date(now).toISOString(),
      type: 'alert',
      service: 'commerce-os',
      kind,
      severity,
      message,
      ...(suppressedCount > 0 ? { suppressedCount } : {}),
      ...(details ? { details } : {}),
    };
    process.stderr.write(`${JSON.stringify(event)}\n`);
    if (this.webhookUrl) this.deliver(event);
  }

  private deliver(event: AlertEvent): void {
    if (!this.webhookUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch(() => {
        process.stderr.write(
          `${JSON.stringify({ type: 'alert', service: 'commerce-os', message: 'webhook delivery failed' })}\n`,
        );
      })
      .finally(() => clearTimeout(timer));
  }
}

/**
 * Build the process reporter from the environment. COMMERCE_ALERT_WEBHOOK is
 * optional; without it alerts still flow to stderr.
 */
export function createAlertReporter(): AlertReporter {
  const webhookUrl = process.env.COMMERCE_ALERT_WEBHOOK;
  return new AlertReporter({
    ...(webhookUrl ? { webhookUrl } : {}),
  });
}
