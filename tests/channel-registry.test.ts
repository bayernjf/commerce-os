import { describe, it, expect } from 'vitest';
import { ChannelRegistry } from '../src/channel/registry.js';
import { createDefaultRegistry } from '../src/channel/index.js';
import { SandboxDouyinAdapter } from '../src/channel/adapters/sandbox-douyin.js';
import { CommerceError } from '../src/util/errors.js';

describe('channel registry (T-M3-02)', () => {
  it('fails closed for an unregistered channel', () => {
    const registry = new ChannelRegistry();
    try {
      registry.get('douyin');
      throw new Error('expected CHANNEL_UNREGISTERED');
    } catch (err) {
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).code).toBe('CHANNEL_UNREGISTERED');
    }
  });

  it('registers and resolves the sandbox adapter', () => {
    const registry = new ChannelRegistry();
    const adapter = new SandboxDouyinAdapter();
    registry.register(adapter);
    expect(registry.has('sandbox-douyin')).toBe(true);
    expect(registry.get('sandbox-douyin').channel).toBe('sandbox-douyin');
    expect(registry.list()).toEqual(['sandbox-douyin']);
  });

  it('rejects duplicate registration', () => {
    const registry = new ChannelRegistry();
    registry.register(new SandboxDouyinAdapter());
    expect(() => registry.register(new SandboxDouyinAdapter())).toThrow(/already registered/);
  });

  it('default registry only contains offline sandbox adapters (no live channels)', () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toEqual(['sandbox-douyin', 'storefront']);
    expect(registry.get('sandbox-douyin').sandbox).toBe(true);
    expect(registry.get('storefront').sandbox).toBe(true);
  });

  it('live channel account without credentialRef fails closed', async () => {
    const { SqliteDriver } = await import('../src/storage/sqlite/sqlite-driver.js');
    const { migrateUp } = await import('../src/storage/migrate.js');
    const { ChannelAccountService } = await import('../src/channel/channel-account-service.js');
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const accounts = new ChannelAccountService(driver);
    await expect(
      accounts.create({ channel: 'douyin', displayName: 'real shop' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
    const sandbox = await accounts.create({ channel: 'sandbox-douyin', displayName: 'sandbox shop' });
    expect(sandbox.id).toMatch(/^acc_/);
    await driver.close();
  });
});
