/**
 * Channel adapter contract (design §4.6). A channel is a storefront
 * platform (douyin/xiaohongshu/taobao...). Adding a channel = adding one
 * adapter file + one registry line (job-agent source-adapter pattern).
 */

export interface ExternalProductRef {
  channel: string;
  externalProductId: string;
  externalSkuRefs: { skuCode: string; externalSkuId: string }[];
  listedAt: string;
}

export interface ChannelOrderLine {
  externalItemId: string;
  externalSkuCode: string;
  title: string;
  qty: number;
  price: number;
}

export interface ChannelOrder {
  externalOrderId: string;
  status: 'paid' | 'pending_payment' | 'shipped' | 'completed' | 'closed';
  totalAmount: number;
  currency: string;
  buyerRef?: string;
  lines: ChannelOrderLine[];
  createdAt: string;
}

export interface ChannelInventory {
  skuCode: string;
  qtyAvailable: number;
}

export interface RefundRequest {
  externalOrderId: string;
  lines: { externalItemId?: string; externalSkuCode?: string; qty: number; amount: number }[];
  reason: string;
}

export interface RefundResult {
  channel: string;
  externalRefundId: string;
  externalOrderId: string;
  status: 'accepted' | 'processing' | 'rejected';
  raw?: unknown;
}

export interface PublishRequest {
  externalProductId?: string;
  title: string;
  body: unknown;
  contentType: 'detail' | 'post' | 'short_video_script' | 'qa';
}

export interface PublishResult {
  channel: string;
  externalContentId: string;
  status: 'published' | 'submitted';
  url?: string;
  raw?: unknown;
}

export interface ChannelAdapter {
  /** Channel identifier, e.g. 'sandbox-douyin' or 'douyin'. */
  readonly channel: string;
  /** True only for offline replay adapters that never touch the network. */
  readonly sandbox: boolean;
  upsertProduct(product: {
    channelProductId?: string;
    title: string;
    skus: { skuCode: string; specs: Record<string, unknown>; price: number; currency: string }[];
  }): Promise<ExternalProductRef>;
  listOrders(query?: { since?: string }): Promise<ChannelOrder[]>;
  getInventory(skuCodes: string[]): Promise<ChannelInventory[]>;
  createRefund(request: RefundRequest): Promise<RefundResult>;
  publish(content: PublishRequest): Promise<PublishResult>;
}
