import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Minimal fixed-window rate limiter for public endpoints (review 2026-11-02
 * P2-9). Counters live in this process only: multiple instances/containers do
 * NOT share state, so this is single-instance protection, not a distributed
 * limiter. Public deployments still need a shared quota at the reverse proxy
 * or gateway.
 */
export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FixedWindowLimiter {
  consume(key: string): RateLimitVerdict;
}

export function createFixedWindowLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): FixedWindowLimiter {
  const entries = new Map<string, { count: number; resetAt: number }>();
  const clock = options.now ?? Date.now;
  let lastSweep = clock();

  return {
    consume(key: string): RateLimitVerdict {
      const now = clock();
      // Opportunistic sweep keeps memory bounded when many one-off clients
      // hit the endpoint: an entry older than the window carries no weight.
      if (now - lastSweep >= options.windowMs) {
        for (const [candidate, entry] of entries) {
          if (now >= entry.resetAt) entries.delete(candidate);
        }
        lastSweep = now;
      }

      const entry = entries.get(key);
      if (!entry || now >= entry.resetAt) {
        entries.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (entry.count >= options.limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * Resolve the client address behind the deployment's reverse proxy. X-Forwarded-
 * For wins, then X-Real-IP, then the socket address under @hono/node-server.
 * Tests (app.request) carry no socket, so they fall back to 'unknown' unless
 * they set one of the proxy headers.
 */
export function clientAddress(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
