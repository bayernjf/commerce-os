import { CommerceError } from '../../util/errors.js';
import type {
  ChannelAdapter,
  ChannelInventory,
  ChannelOrder,
  ExternalProductRef,
  PublishRequest,
  PublishResult,
  RefundRequest,
  RefundResult,
} from '../types.js';

/**
 * Storefront fake payout adapter (SF-13). Storefront self-operated sales carry
 * no channel account in the local/dev form, so refunds are settled through a
 * deterministic fake payout ('accepted'). Real payout providers (e.g. Stripe)
 * land with LF-07 once merchant credentials are registered; until then this
 * adapter keeps the storefront refund loop honest (approved refunds do settle
 * and record an external refund ref) without pretending to touch a real bank.
 * Non-refund channel operations are unsupported by design and fail closed.
 */
export class StorefrontFakeAdapter implements ChannelAdapter {
  readonly channel = 'storefront';
  readonly sandbox = true;

  async createRefund(request: RefundRequest): Promise<RefundResult> {
    return {
      channel: this.channel,
      externalOrderId: request.externalOrderId,
      externalRefundId: `fake-refund-${request.externalOrderId}`,
      status: 'accepted',
    };
  }

  upsertProduct(): Promise<ExternalProductRef> {
    throw new CommerceError('NOT_IMPLEMENTED_PLACEHOLDER', 'storefront adapter does not manage channel listings', false);
  }

  listOrders(): Promise<ChannelOrder[]> {
    throw new CommerceError('NOT_IMPLEMENTED_PLACEHOLDER', 'storefront orders are native; no channel import', false);
  }

  getInventory(): Promise<ChannelInventory[]> {
    throw new CommerceError('NOT_IMPLEMENTED_PLACEHOLDER', 'storefront inventory is native; no channel sync', false);
  }

  publish(_content: PublishRequest): Promise<PublishResult> {
    throw new CommerceError('NOT_IMPLEMENTED_PLACEHOLDER', 'storefront adapter does not publish to channels', false);
  }
}
