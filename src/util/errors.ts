/**
 * Unified error body matching zeus design §8.1:
 * `{ code, message, retryable, details? }`.
 */
export type CommerceErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CHANNEL_UNAVAILABLE'
  | 'CHANNEL_UNREGISTERED'
  | 'CREDENTIAL_MISSING'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DECISION_HELD'
  | 'DECISION_UNAVAILABLE'
  | 'CONTENT_UNAVAILABLE'
  | 'NOT_IMPLEMENTED_PLACEHOLDER'
  | 'CONFLICT';

export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: CommerceErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CommerceError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function httpStatusFor(code: CommerceErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION_FAILED':
      return 400;
    case 'CHANNEL_UNREGISTERED':
    case 'CREDENTIAL_MISSING':
      return 422;
    case 'IDEMPOTENCY_CONFLICT':
    case 'CONFLICT':
      return 409;
    case 'DECISION_HELD':
      return 423; // Locked: an approval is required before the action continues
    case 'DECISION_UNAVAILABLE':
    case 'CONTENT_UNAVAILABLE':
    case 'CHANNEL_UNAVAILABLE':
      return 503;
    case 'NOT_IMPLEMENTED_PLACEHOLDER':
      return 501;
  }
}

export function errorBody(err: CommerceError): { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } {
  return {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    ...(err.details ? { details: err.details } : {}),
  };
}
