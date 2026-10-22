import type { StorageDriver } from './storage/driver.js';
import { EventLog } from './storage/event-log.js';
import { createDefaultRegistry } from './channel/index.js';
import type { ChannelRegistry } from './channel/registry.js';
import { ChannelAccountService } from './channel/channel-account-service.js';
import { ProductService } from './product/product-service.js';
import { OrderService } from './order/order-service.js';
import { AftersaleService } from './aftersale/aftersale-service.js';
import { FulfillmentService } from './fulfillment/fulfillment-service.js';
import { StubContentClient } from './content/stub-content-client.js';
import type { ContentClient } from './content/types.js';
import { CustomerService } from './customer-service/customer-service.js';
import { DashboardService } from './dashboard/dashboard-service.js';
import { PublishingService } from './publishing/publishing-service.js';
import type { DecisionPort } from './decision/types.js';

export interface CommerceServices {
  driver: StorageDriver;
  events: EventLog;
  registry: ChannelRegistry;
  accounts: ChannelAccountService;
  products: ProductService;
  orders: OrderService;
  aftersales: AftersaleService;
  fulfillment: FulfillmentService;
  publishing: PublishingService;
  customerService: CustomerService;
  dashboard: DashboardService;
}

/**
 * Composition root. The DecisionPort is injected: tests use a recorded
 * zeus HTTP server, production uses ZeusDecisionClient pointing at zeus.
 */
export function createServices(
  driver: StorageDriver,
  decisions: DecisionPort,
  registry?: ChannelRegistry,
  content?: ContentClient,
): CommerceServices {
  const eventLog = new EventLog(driver);
  const resolvedRegistry = registry ?? createDefaultRegistry();
  const accounts = new ChannelAccountService(driver);
  const products = new ProductService(driver);
  const orders = new OrderService(driver, resolvedRegistry, accounts, eventLog);
  const fulfillment = new FulfillmentService(driver, resolvedRegistry, accounts);
  const aftersales = new AftersaleService(driver, eventLog, decisions, resolvedRegistry, accounts, orders);
  const contentClient = content ?? new StubContentClient();
  const publishing = new PublishingService(eventLog, decisions, resolvedRegistry, accounts, products, contentClient);
  const customerService = new CustomerService(driver, decisions, orders);
  const dashboard = new DashboardService(driver, eventLog);
  return {
    driver,
    events: eventLog,
    registry: resolvedRegistry,
    accounts,
    products,
    orders,
    aftersales,
    fulfillment,
    publishing,
    customerService,
    dashboard,
  };
}
