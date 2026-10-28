import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless cart session token (SF-08): HMAC-SHA256 over the cart id with a
 * shared secret. No token column, no migration — revocation is by secret
 * rotation. Used with the `Cart <token>` Authorization scheme, separate from
 * the ops Bearer token.
 */

export function issueCartToken(cartId: string, secret: string): string {
  return createHmac('sha256', secret).update(`cart:${cartId}`, 'utf8').digest('hex');
}

export function verifyCartToken(cartId: string, token: string, secret: string): boolean {
  const expected = issueCartToken(cartId, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
