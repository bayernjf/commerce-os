import { ChannelRegistry } from './registry.js';
import { SandboxDouyinAdapter } from './adapters/sandbox-douyin.js';

/**
 * Default adapter wiring. Adding a new channel = implement ChannelAdapter,
 * register it here, and (for live channels) require credentials.
 */
export function createDefaultRegistry(): ChannelRegistry {
  const registry = new ChannelRegistry();
  registry.register(new SandboxDouyinAdapter());
  // Live channels (e.g. 'douyin' with real credentials) are deliberately
  // absent in M3: selecting them fails closed with CHANNEL_UNREGISTERED.
  return registry;
}
