import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { DecisionPort } from '../decision/types.js';
import type { OrderService } from '../order/order-service.js';
import { RuleIntentClassifier } from './intent-classifier.js';
import type {
  Conversation,
  CsGrade,
  CsIntent,
  CsMessage,
  IntentClassifier,
  ReplyCandidate,
} from './types.js';

/** Grade at/above which a reply candidate is never auto-sent. */
const HUMAN_THRESHOLD: CsGrade = 'D2';
const GRADE_RANK: Record<CsGrade, number> = { D0: 0, D1: 1, D2: 2, D3: 3 };

export interface OpenConversationInput {
  channel: string;
  externalCustomerId?: string;
  orderId?: string;
}

/**
 * Customer-service agent (M4/T-M4-04). It turns each customer message into a
 * graded reply candidate. Informational replies (product/logistics) are
 * D0 and auto-sent; money-out and commitment replies are graded by zeus and
 * a grade >= D2 is queued for a human instead of being sent. The agent never
 * issues a refund or makes a commitment on its own.
 */
export class CustomerService {
  private readonly classifier: IntentClassifier;

  constructor(
    private readonly driver: StorageDriver,
    private readonly decisions: DecisionPort,
    private readonly orders: OrderService,
    classifier?: IntentClassifier,
  ) {
    this.classifier = classifier ?? new RuleIntentClassifier();
  }

  async openConversation(input: OpenConversationInput): Promise<Conversation> {
    if (input.orderId) {
      const order = await this.orders.getOrder(input.orderId);
      if (!order) throw new CommerceError('NOT_FOUND', `order not found: ${input.orderId}`, false);
    }
    const now = nowIso();
    const conversation: Conversation = {
      id: newId('cvs'),
      channel: input.channel,
      ...(input.externalCustomerId ? { externalCustomerId: input.externalCustomerId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.run(
      `INSERT INTO cs_conversations (id, channel, external_customer_id, order_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.channel,
        conversation.externalCustomerId ?? null,
        conversation.orderId ?? null,
        conversation.status,
        conversation.createdAt,
        conversation.updatedAt,
      ],
    );
    return conversation;
  }

  /** Handle a customer message and return the graded reply candidate. */
  async handleMessage(conversationId: string, text: string): Promise<ReplyCandidate> {
    const conversation = await this.getConversation(conversationId);
    if (conversation.status !== 'open') {
      throw new CommerceError('CONFLICT', `conversation is ${conversation.status}`, false);
    }

    const message = await this.addMessage(conversationId, 'customer', text);
    const intent = this.classifier.classify(text);
    const { grade, decisionId } = await this.grade(intent, conversation, text);

    const needsHuman = GRADE_RANK[grade] >= GRADE_RANK[HUMAN_THRESHOLD];
    const status = needsHuman ? 'awaiting_human' : 'auto_sent';
    const replyText = this.composeReply(intent, needsHuman);

    const candidate: ReplyCandidate = {
      id: newId('rpl'),
      conversationId,
      messageId: message.id,
      intent,
      replyText,
      grade,
      status,
      ...(decisionId ? { decisionId } : {}),
      createdAt: nowIso(),
    };
    await this.persistCandidate(candidate);

    // Auto-sent replies are recorded as agent messages; awaiting ones are not.
    if (status === 'auto_sent') {
      await this.addMessage(conversationId, 'agent', replyText);
    }
    await this.touch(conversationId);
    return candidate;
  }

  /** A human sends a reply; supersedes any pending candidate. */
  async humanReply(conversationId: string, text: string): Promise<ReplyCandidate> {
    const conversation = await this.getConversation(conversationId);
    if (conversation.status !== 'open') {
      throw new CommerceError('CONFLICT', `conversation is ${conversation.status}`, false);
    }
    const message = await this.addMessage(conversationId, 'agent', text);
    const candidate: ReplyCandidate = {
      id: newId('rpl'),
      conversationId,
      messageId: message.id,
      intent: 'other',
      replyText: text,
      grade: 'D0',
      status: 'sent_by_human',
      createdAt: nowIso(),
    };
    await this.persistCandidate(candidate);
    await this.touch(conversationId);
    return candidate;
  }

  private async grade(
    intent: CsIntent,
    conversation: Conversation,
    rawText: string,
  ): Promise<{ grade: CsGrade; decisionId?: string }> {
    if (intent === 'product_inquiry' || intent === 'logistics_inquiry' || intent === 'other') {
      return { grade: 'D0' };
    }

    if (intent === 'promise_request') {
      const decision = await this.decisions.decide({
        intent: 'customer.commitment',
        domain: 'commerce',
        impact: 'external',
        reversibility: 'hard',
        riskTags: ['customer-service', 'commitment'],
        proposal: rawText,
        idempotencyKey: `cs-commit:${conversation.id}:${newId('x')}`,
      });
      return { grade: decision.grade, decisionId: decision.decisionId };
    }

    // refund / compensation: money-out. Without an order the amount cannot be
    // verified, so fail closed to D2 (human).
    if (!conversation.orderId) {
      return { grade: 'D2' };
    }
    const order = await this.orders.getOrder(conversation.orderId);
    const decision = await this.decisions.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: order.totalAmount, currency: order.currency },
      impact: 'org',
      reversibility: 'hard',
      riskTags: ['customer-service', intent],
      proposal: `${intent} ${order.totalAmount} ${order.currency} for order ${order.externalOrderId}`,
      idempotencyKey: `cs-refund:${conversation.id}:${order.id}`,
    });
    return { grade: decision.grade, decisionId: decision.decisionId };
  }

  private composeReply(intent: CsIntent, needsHuman: boolean): string {
    if (needsHuman) {
      return '您好，您的情况已为您转接人工客服，稍后会有专人跟进，请稍候。';
    }
    switch (intent) {
      case 'logistics_inquiry':
        return '您好，已为您查询订单物流，包裹正在正常运输中，您可在订单页查看最新轨迹。';
      case 'product_inquiry':
        return '您好，关于商品的规格与库存，商品详情页有完整说明，如需进一步确认可随时告知。';
      case 'refund_request':
      case 'compensation_request':
        // 信息性回复：仅确认已登记，不承诺金额或时效，不执行退款。
        return '您好，您的售后需求已登记，我们会按流程尽快处理。';
      default:
        return '您好，请问有什么可以帮您？';
    }
  }

  private async addMessage(
    conversationId: string,
    role: CsMessage['role'],
    text: string,
  ): Promise<CsMessage> {
    const message: CsMessage = { id: newId('csm'), role, text, createdAt: nowIso() };
    await this.driver.run(
      'INSERT INTO cs_messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
      [message.id, conversationId, message.role, message.text, message.createdAt],
    );
    return message;
  }

  private async persistCandidate(candidate: ReplyCandidate): Promise<void> {
    await this.driver.run(
      `INSERT INTO reply_candidates (id, conversation_id, message_id, intent, reply_text, grade, status, decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidate.id,
        candidate.conversationId,
        candidate.messageId,
        candidate.intent,
        candidate.replyText,
        candidate.grade,
        candidate.status,
        candidate.decisionId ?? null,
        candidate.createdAt,
      ],
    );
  }

  private async touch(conversationId: string): Promise<void> {
    await this.driver.run('UPDATE cs_conversations SET updated_at = ?, status = ? WHERE id = ?', [
      nowIso(),
      'open',
      conversationId,
    ]);
  }

  async getConversation(id: string): Promise<Conversation> {
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM cs_conversations WHERE id = ?',
      [id],
    );
    if (!row) throw new CommerceError('NOT_FOUND', `conversation not found: ${id}`, false);
    return {
      id: String(row.id),
      channel: String(row.channel),
      ...(row.external_customer_id ? { externalCustomerId: String(row.external_customer_id) } : {}),
      ...(row.order_id ? { orderId: String(row.order_id) } : {}),
      status: row.status as Conversation['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
