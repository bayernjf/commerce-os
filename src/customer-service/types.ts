/**
 * Customer-service domain types (M4/T-M4-04).
 *
 * A customer message is turned into a reply candidate. The candidate is
 * graded: low-risk informational replies (product/logistics) may be sent
 * automatically (D0); anything that moves money (refund/compensation) or
 * makes a commitment to the customer (delivery/effect guarantee) is sent to
 * zeus. A grade >= D2 is never auto-sent — it is queued for a human.
 */

export type CsIntent =
  | 'product_inquiry'
  | 'logistics_inquiry'
  | 'refund_request'
  | 'compensation_request'
  | 'promise_request'
  | 'other';

export type CsGrade = 'D0' | 'D1' | 'D2' | 'D3';

export type CandidateStatus =
  | 'proposed'
  | 'auto_sent'
  | 'awaiting_human'
  | 'sent_by_human'
  | 'discarded';

export interface CsMessage {
  id: string;
  role: 'customer' | 'agent';
  text: string;
  createdAt: string;
}

export interface ReplyCandidate {
  id: string;
  conversationId: string;
  messageId: string;
  intent: CsIntent;
  replyText: string;
  grade: CsGrade;
  status: CandidateStatus;
  decisionId?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  channel: string;
  externalCustomerId?: string;
  orderId?: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

/** Intent classifier port (rule-based in M4; LLM-backed later). */
export interface IntentClassifier {
  classify(text: string): CsIntent;
}
