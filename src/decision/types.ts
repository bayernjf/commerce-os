/**
 * Decision port. commerce-os never grades locally: every money/external
 * action is sent to zeus, and the result is enforced here.
 *
 * A decision response is either:
 *  - already decided (D0 auto, or a grade zeus settled inline) → proceed
 *  - held (D1 async / D2 sync / D3 human-led) → the caller must wait for an
 *    approval; the action stays parked and an approval resumes it.
 */
export interface CommerceDecisionInput {
  intent: string;                 // e.g. 'product.publish' | 'order.refund'
  domain: string;                 // e.g. 'commerce'
  amount?: { value: number; currency: string };
  impact?: 'self' | 'team' | 'org' | 'external';
  reversibility?: 'reversible' | 'hard' | 'irreversible';
  riskTags?: string[];
  proposal?: string;
  idempotencyKey?: string;
}

export interface CommerceDecision {
  decisionId: string;
  grade: 'D0' | 'D1' | 'D2' | 'D3';
  mode: 'auto' | 'approve-async' | 'approve-sync' | 'human-led';
  status: 'decided' | 'awaiting_approval' | 'blocked' | 'rejected';
  ruleId?: string;
  auditSeq?: number;
}

export interface DecisionPort {
  decide(input: CommerceDecisionInput): Promise<CommerceDecision>;
  approve(decisionId: string, approver: string, comment?: string): Promise<CommerceDecision>;
  reject(decisionId: string, approver: string, comment?: string): Promise<CommerceDecision>;
}

export function isHeld(decision: CommerceDecision): boolean {
  return decision.status === 'awaiting_approval' || decision.status === 'blocked';
}
