import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';

export interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  credentialRef?: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

/**
 * Channel account registration. Live channels must reference a credential
 * in the deployment secret backend (credentialRef only). Sandbox channels
 * need no credential. A live channel without a credentialRef fails closed
 * with CREDENTIAL_MISSING.
 */
export class ChannelAccountService {
  constructor(private readonly driver: StorageDriver) {}

  async create(input: {
    channel: string;
    displayName: string;
    credentialRef?: string;
    status?: 'active' | 'disabled';
  }): Promise<ChannelAccount> {
    if (!input.channel?.trim()) throw new CommerceError('VALIDATION_FAILED', 'channel is required');
    if (!input.displayName?.trim()) throw new CommerceError('VALIDATION_FAILED', 'displayName is required');
    const isSandbox = input.channel.startsWith('sandbox-');
    if (!isSandbox && !input.credentialRef) {
      throw new CommerceError(
        'CREDENTIAL_MISSING',
        `live channel '${input.channel}' requires a credentialRef to a secret backend entry; sandbox channels do not`,
        false,
        { channel: input.channel },
      );
    }
    const account: ChannelAccount = {
      id: newId('acc', input.channel),
      channel: input.channel,
      displayName: input.displayName.trim(),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      status: input.status ?? 'active',
      createdAt: nowIso(),
    };
    await this.driver.run(
      `INSERT INTO channel_accounts (id, channel, display_name, credential_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [account.id, account.channel, account.displayName, account.credentialRef ?? null, account.status, account.createdAt],
    );
    return account;
  }

  async get(id: string): Promise<ChannelAccount> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM channel_accounts WHERE id = ?', [id]);
    if (!row) throw new CommerceError('NOT_FOUND', `channel account not found: ${id}`, false, { channelAccountId: id });
    return {
      id: String(row.id),
      channel: String(row.channel),
      displayName: String(row.display_name),
      ...(row.credential_ref ? { credentialRef: String(row.credential_ref) } : {}),
      status: row.status as ChannelAccount['status'],
      createdAt: String(row.created_at),
    };
  }

  async list(): Promise<ChannelAccount[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT * FROM channel_accounts ORDER BY created_at ASC');
    return rows.map((r) => ({
      id: String(r.id),
      channel: String(r.channel),
      displayName: String(r.display_name),
      ...(r.credential_ref ? { credentialRef: String(r.credential_ref) } : {}),
      status: r.status as ChannelAccount['status'],
      createdAt: String(r.created_at),
    }));
  }
}
