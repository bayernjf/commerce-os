import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { AlertReporter } from '../src/observability/alerts.js';

describe('AlertReporter (T-M6-03)', () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('always emits a structured JSON line on stderr', () => {
    const reporter = new AlertReporter({ now: () => 0 });
    reporter.report('decision_unavailable', 'warning', 'kernel down');
    expect(stderrSpy).toHaveBeenCalled();
    const line = String(stderrSpy.mock.calls[0]?.[0]);
    const event = JSON.parse(line);
    expect(event.type).toBe('alert');
    expect(event.kind).toBe('decision_unavailable');
    expect(event.severity).toBe('warning');
  });

  it('POSTs to the webhook when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const reporter = new AlertReporter({
      webhookUrl: 'https://example.test/hook',
      fetchImpl,
      now: () => 0,
    });
    reporter.report('content_unavailable', 'warning', 'loom down');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/hook');
    expect(init?.method).toBe('POST');
  });

  it('collapses repeated identical alerts within the cooldown', () => {
    let t = 0;
    const reporter = new AlertReporter({ now: () => t, cooldownMs: 1000 });
    reporter.report('channel_unavailable', 'warning', 'same');
    t = 500;
    reporter.report('channel_unavailable', 'warning', 'same');
    t = 900;
    reporter.report('channel_unavailable', 'warning', 'same');
    // Only the first is emitted within the window.
    const emitted = stderrSpy.mock.calls.filter((c) => String(c[0]).includes('"kind"'));
    expect(emitted).toHaveLength(1);
  });

  it('reports the suppressed count once the cooldown passes', () => {
    let t = 0;
    const reporter = new AlertReporter({ now: () => t, cooldownMs: 1000 });
    reporter.report('disk_low', 'critical', 'disk');
    t = 100;
    reporter.report('disk_low', 'critical', 'disk');
    t = 200;
    reporter.report('disk_low', 'critical', 'disk');
    t = 1500;
    reporter.report('disk_low', 'critical', 'disk');
    const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
    const second = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(second.suppressedCount).toBe(2);
  });

  it('does not throw when the webhook fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const reporter = new AlertReporter({
      webhookUrl: 'https://example.test/hook',
      fetchImpl,
      now: () => 0,
    });
    expect(() => reporter.report('process_fatal', 'critical', 'boom')).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });
});
