import { statfsSync } from 'node:fs';
import type { StorageDriver } from '../storage/driver.js';

export interface Check {
  ok: boolean;
  detail?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, Check>;
}

export interface ReadinessOptions {
  /** Directory whose filesystem is checked for free space (the data volume). */
  dataDir?: string;
  /** Minimum free bytes; default 100 MiB. */
  minDiskBytes?: number;
}

const DEFAULT_MIN_DISK_BYTES = 100 * 1024 * 1024;

/**
 * Readiness probes, distinct from the cheap /healthz liveness check:
 *  - db: a real round-trip so a wedged connection reports not-ready;
 *  - disk: free space on the data volume (checked when dataDir is given).
 */
export async function checkReadiness(
  driver: StorageDriver,
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  /** @type {Record<string, Check>} */
  const checks: Record<string, Check> = {};

  try {
    await driver.get('SELECT 1 AS ok');
    checks.db = { ok: true, detail: driver.dialect };
  } catch (err) {
    checks.db = { ok: false, detail: (err as Error).message };
  }

  if (options.dataDir) {
    try {
      const stat = statfsSync(options.dataDir);
      const free = stat.bsize * stat.bavail;
      const min = options.minDiskBytes ?? DEFAULT_MIN_DISK_BYTES;
      checks.disk = { ok: free >= min, detail: `free=${free};min=${min}` };
    } catch (err) {
      checks.disk = { ok: false, detail: (err as Error).message };
    }
  }

  const ready = Object.values(checks).every((c) => c.ok);
  return { ready, checks };
}
