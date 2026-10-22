import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReadiness } from '../src/observability/readiness.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import type { StorageDriver } from '../src/storage/driver.js';

describe('readiness probes (T-M6-03)', () => {
  it('reports ready when the DB round-trip succeeds', async () => {
    const driver = new SqliteDriver(':memory:');
    const result = await checkReadiness(driver);
    expect(result.ready).toBe(true);
    expect(result.checks.db?.ok).toBe(true);
    await driver.close();
  });

  it('reports not-ready when the DB round-trip fails', async () => {
    const failing: StorageDriver = {
      dialect: 'sqlite',
      all: async () => [],
      get: async () => {
        throw new Error('connection wedged');
      },
      run: async () => ({ changes: 0 }),
      exec: async () => {},
      close: async () => {},
    };
    const result = await checkReadiness(failing);
    expect(result.ready).toBe(false);
    expect(result.checks.db?.ok).toBe(false);
    expect(result.checks.db?.detail).toMatch(/connection wedged/);
  });

  it('passes the disk probe when the data volume has space', async () => {
    const driver = new SqliteDriver(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'commerce-ready-'));
    const result = await checkReadiness(driver, { dataDir, minDiskBytes: 1 });
    expect(result.checks.disk?.ok).toBe(true);
    await driver.close();
  });

  it('fails the disk probe below the threshold', async () => {
    const driver = new SqliteDriver(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'commerce-ready-'));
    const result = await checkReadiness(driver, { dataDir, minDiskBytes: Number.MAX_SAFE_INTEGER });
    expect(result.ready).toBe(false);
    expect(result.checks.disk?.ok).toBe(false);
    await driver.close();
  });
});
