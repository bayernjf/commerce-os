import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { assertFailClosedBoot } from '../src/util/boot.js';

/**
 * Tier0 review 2026-10-30 (H1): auth is fail-closed. serve.ts cannot be
 * imported in tests (module evaluation boots the server), so the gate lives
 * in a side-effect-free helper and these tests additionally pin it into the
 * startup path ahead of any service construction.
 */
describe('fail-closed boot gate (H1)', () => {
  it('refuses to boot when COMMERCE_API_TOKEN is unset or empty', () => {
    expect(() => assertFailClosedBoot(undefined)).toThrowError(/COMMERCE_API_TOKEN is not configured/);
    expect(() => assertFailClosedBoot('')).toThrowError(/fail-closed, refusing to start/);
  });

  it('boots normally once a token is configured', () => {
    expect(() => assertFailClosedBoot('dev-token')).not.toThrow();
  });

  it('is wired into startup before any driver or service is created', async () => {
    const source = await readFile(new URL('../src/serve.ts', import.meta.url), 'utf8');
    const gate = source.indexOf('assertFailClosedBoot(');
    const services = source.indexOf('createServices(');
    const server = source.indexOf('createApp(');
    expect(gate).toBeGreaterThan(-1);
    expect(services).toBeGreaterThan(gate);
    expect(server).toBeGreaterThan(gate);
  });
});
