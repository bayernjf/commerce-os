import { ZeusClient, ZeusClientError, type DecisionResponse } from 'zeus-client';
import { CommerceError } from '../util/errors.js';
import type { CommerceDecision, CommerceDecisionInput, DecisionPort } from './types.js';

export interface ZeusDecisionClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/**
 * Real DecisionPort over zeus-client (the typed bearer client delivered in
 * M1). commerce-os never grades locally; when zeus is unreachable or rejects
 * a transport-level call, the action fails closed with DECISION_UNAVAILABLE
 * (503, retryable) rather than guessing a grade.
 */
export class ZeusDecisionClient implements DecisionPort {
  private readonly client: ZeusClient;

  constructor(options: ZeusDecisionClientOptions) {
    this.client = new ZeusClient({
      baseUrl: options.baseUrl,
      token: options.token,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  async decide(input: CommerceDecisionInput): Promise<CommerceDecision> {
    try {
      const response = await this.client.decide({
        intent: input.intent,
        domain: input.domain,
        ...(input.amount ? { amount: input.amount } : {}),
        ...(input.impact ? { impact: input.impact } : {}),
        ...(input.reversibility ? { reversibility: input.reversibility } : {}),
        ...(input.riskTags ? { riskTags: input.riskTags } : {}),
        ...(input.proposal !== undefined ? { proposal: input.proposal } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      return this.map(response);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async approve(decisionId: string, approver: string, comment?: string): Promise<CommerceDecision> {
    try {
      const response = await this.client.approve(decisionId, { decision: 'approve', approver, ...(comment ? { comment } : {}) });
      return this.map(response);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async reject(decisionId: string, approver: string, comment?: string): Promise<CommerceDecision> {
    try {
      const response = await this.client.approve(decisionId, { decision: 'reject', approver, ...(comment ? { comment } : {}) });
      return this.map(response);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private map(response: DecisionResponse): CommerceDecision {
    return {
      decisionId: response.decisionId,
      grade: response.grade,
      mode: response.mode,
      status: response.status,
      ruleId: response.ruleId,
      auditSeq: response.auditSeq,
    };
  }

  private wrap(err: unknown): CommerceError {
    if (err instanceof CommerceError) return err;
    if (err instanceof ZeusClientError) {
      // A business-level rejection (e.g. already decided) is non-retryable;
      // transport/5xx is retryable.
      return new CommerceError(
        'DECISION_UNAVAILABLE',
        `decision kernel rejected the request: ${err.message}`,
        err.retryable,
        { code: err.code, status: err.status },
      );
    }
    return new CommerceError('DECISION_UNAVAILABLE', `decision kernel call failed: ${(err as Error).message}`, true);
  }
}
