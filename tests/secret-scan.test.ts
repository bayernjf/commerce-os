import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Review 2026-11-02 P1-2: the secret-scan gate ran red on HEAD (documentation
 * placeholders tripped the COMMERCE_API_TOKEN pattern) while handoff claimed
 * zero hits, and nothing enforced it. These tests run the real script: the
 * tracked tree must pass, a real-looking token must fail, and the allowlisted
 * placeholder must be skipped. Fixture values are concatenated at runtime so
 * no contiguous credential-shaped literal lands in this file (or trips push
 * protection / the scanner itself).
 */
const root = process.cwd();
const fixtureDir = join('tests', '.secret-scan-fixture');
const fixturePath = join(root, fixtureDir);

const runScan = (files?: string) =>
  spawnSync('bash', ['scripts/scan-secrets.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...(files ? { SCAN_FILES: files } : {}) }
  });

const writeFixture = (name: string, content: string): string => {
  mkdirSync(fixturePath, { recursive: true });
  writeFileSync(join(fixturePath, name), content);
  return join(fixtureDir, name);
};

afterEach(() => {
  rmSync(fixturePath, { recursive: true, force: true });
});

describe('secret scan gate (P1-2)', () => {
  it('passes on the tracked tree', () => {
    const result = runScan();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SECRET SCAN CLEAN');
  });

  it('fails on a real-looking COMMERCE_API_TOKEN value', () => {
    const fake = ['COMMERCE_API_TOKEN=', 'ck_live', '_', 'a'.repeat(24)].join('');
    const file = writeFixture('real-looking.txt', `${fake}\n`);
    const result = runScan(file);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HIT');
  });

  it('skips the allowlisted documentation placeholder', () => {
    const placeholder = ['COMMERCE_API_TOKEN=', 'dev', '-', 'token'].join('');
    const file = writeFixture('README-fixture.md', `${placeholder} npm start\n`);
    const result = runScan(file);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP');
  });
});
