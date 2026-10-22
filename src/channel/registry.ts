import type { ChannelAdapter } from './types.js';
import { CommerceError } from '../util/errors.js';

/**
 * Channel adapter registry. Unregistered channels fail closed with
 * CHANNEL_UNREGISTERED — the API never guesses a channel.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.channel)) {
      throw new CommerceError('CONFLICT', `channel adapter already registered: ${adapter.channel}`);
    }
    this.adapters.set(adapter.channel, adapter);
  }

  get(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new CommerceError(
        'CHANNEL_UNREGISTERED',
        `no channel adapter registered for '${channel}'; register one in adapters/registry.ts before use`,
        false,
        { channel, registered: this.list() },
      );
    }
    return adapter;
  }

  has(channel: string): boolean {
    return this.adapters.has(channel);
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
