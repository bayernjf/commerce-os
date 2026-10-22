import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../src/storage/migrate.js';
import { createServices, type CommerceServices } from '../../src/services.js';
import { ZeusDecisionClient } from '../../src/decision/zeus-decision-client.js';
import { FakeZeusServer } from './fake-zeus-server.js';

export interface TestHarness {
  services: CommerceServices;
  driver: SqliteDriver;
  zeus: FakeZeusServer;
}

export async function setupHarness(): Promise<TestHarness> {
  const zeus = new FakeZeusServer();
  const url = await zeus.start();
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const decisions = new ZeusDecisionClient({ baseUrl: url, token: zeus.token });
  const services = createServices(driver, decisions);
  return { services, driver, zeus };
}

export async function teardownHarness(harness: TestHarness): Promise<void> {
  await harness.driver.close();
  await harness.zeus.stop();
}
