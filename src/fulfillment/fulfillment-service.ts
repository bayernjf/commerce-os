import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { ChannelRegistry } from '../channel/registry.js';
import type { ChannelAccountService } from '../channel/channel-account-service.js';

export interface InventoryRow {
  id: string;
  skuId: string;
  qtyAvailable: number;
  updatedAt: string;
}

/**
 * Inventory is a M3 placeholder that allows manual maintenance (design §5.2:
 * "本期占位，可手工维护") and an optional channel pull. Fulfillment and
 * payment are explicitly NOT implemented: their endpoints exist to make
 * the gap visible and return 501 NOT_IMPLEMENTED_PLACEHOLDER instead of
 * pretending to succeed.
 */
export class FulfillmentService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly registry: ChannelRegistry,
    private readonly accounts: ChannelAccountService,
  ) {}

  async setInventory(skuId: string, qty: number): Promise<InventoryRow> {
    if (!Number.isInteger(qty) || qty < 0) {
      throw new CommerceError('VALIDATION_FAILED', 'qty must be a non-negative integer', false, { qty });
    }
    const sku = await this.driver.get<Record<string, unknown>>('SELECT id FROM skus WHERE id = ?', [skuId]);
    if (!sku) throw new CommerceError('NOT_FOUND', `sku not found: ${skuId}`, false, { skuId });
    const now = nowIso();
    const existing = await this.driver.get<Record<string, unknown>>('SELECT id FROM inventory WHERE sku_id = ?', [skuId]);
    if (existing) {
      await this.driver.run('UPDATE inventory SET qty_available = ?, updated_at = ? WHERE sku_id = ?', [qty, now, skuId]);
      return { id: String(existing.id), skuId, qtyAvailable: qty, updatedAt: now };
    }
    const row: InventoryRow = { id: newId('inv', skuId), skuId, qtyAvailable: qty, updatedAt: now };
    await this.driver.run('INSERT INTO inventory (id, sku_id, qty_available, updated_at) VALUES (?, ?, ?, ?)', [
      row.id, row.skuId, row.qtyAvailable, row.updatedAt,
    ]);
    return row;
  }

  async listInventory(): Promise<InventoryRow[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT * FROM inventory ORDER BY sku_id ASC');
    return rows.map((r) => ({
      id: String(r.id),
      skuId: String(r.sku_id),
      qtyAvailable: Number(r.qty_available),
      updatedAt: String(r.updated_at),
    }));
  }

  async pullFromChannel(channelAccountId: string, skuCodes: string[]): Promise<InventoryRow[]> {
    const account = await this.accounts.get(channelAccountId);
    const adapter = this.registry.get(account.channel);
    const channelInventory = await adapter.getInventory(skuCodes);
    const rows: InventoryRow[] = [];
    for (const item of channelInventory) {
      const sku = await this.driver.get<Record<string, unknown>>('SELECT id FROM skus WHERE sku_code = ?', [item.skuCode]);
      if (!sku) continue;
      rows.push(await this.setInventory(String(sku.id), item.qtyAvailable));
    }
    return rows;
  }

  placeholderShip(): never {
    throw new CommerceError(
      'NOT_IMPLEMENTED_PLACEHOLDER',
      'fulfillment (shipping/tracking) is a M3 placeholder; payment happens on the channel and logistics is wired in a later milestone',
      false,
      { module: 'fulfillment', action: 'ship' },
    );
  }

  placeholderPay(): never {
    throw new CommerceError(
      'NOT_IMPLEMENTED_PLACEHOLDER',
      'payment is external to commerce-os in M3 (orders arrive from the channel already paid); the payment interface is reserved for a later milestone',
      false,
      { module: 'payment', action: 'createPayment' },
    );
  }
}
