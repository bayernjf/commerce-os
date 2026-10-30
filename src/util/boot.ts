/**
 * Fail-closed boot gate (Tier0 review 2026-10-30 H1). Ops routes under
 * /api/v1 are guarded by a Bearer token, so the server must refuse to boot
 * when no token is configured instead of starting with /api/v1 open.
 * Kept side-effect-free so tests can exercise it without booting the server.
 */
export function assertFailClosedBoot(apiToken: string | undefined): asserts apiToken is string {
  if (!apiToken) {
    throw new Error(
      'COMMERCE_API_TOKEN is not configured: auth is fail-closed, refusing to start with /api/v1 open',
    );
  }
}
