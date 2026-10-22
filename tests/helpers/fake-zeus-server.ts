import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal recorded zeus server implementing the decision HTTP API that
 * zeus-client calls (POST /api/v1/decisions and
 * POST /api/v1/decisions/:id/approval). It grades with a scripted mirror of
 * the DEFAULT_POLICY_V1 bands used in zeus so tests exercise the full
 * HTTP path through the real zeus-client package — commerce-os never
 * grades locally.
 */
export interface StoredDecision {
  id: string;
  grade: 'D0' | 'D1' | 'D2' | 'D3';
  mode: 'auto' | 'approve-async' | 'approve-sync' | 'human-led';
  status: 'decided' | 'awaiting_approval' | 'blocked' | 'rejected';
  ruleId: string;
  auditSeq: number;
}

export class FakeZeusServer {
  private server?: Server;
  private decisions = new Map<string, StoredDecision>();
  private seq = 0;
  url = '';
  readonly token = 'fake-token';

  async start(): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.decisions.clear();
    this.seq = 0;
  }

  private send(res: Parameters<import('node:http').RequestListener>[1], status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      this.send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
      return;
    }
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/decisions') {
      const body = (await readJson(req)) as {
        intent: string;
        amount?: { value: number; currency: string };
        impact?: string;
        reversibility?: string;
      };
      const stored = this.grade(body);
      this.decisions.set(stored.id, stored);
      this.send(res, 200, {
        decisionId: stored.id,
        grade: stored.grade,
        mode: stored.mode,
        status: stored.status,
        ruleId: stored.ruleId,
        auditSeq: stored.auditSeq,
      });
      return;
    }

    const approvalMatch = /^\/api\/v1\/decisions\/([^/]+)\/approval$/.exec(url);
    if (req.method === 'POST' && approvalMatch) {
      const id = decodeURIComponent(approvalMatch[1] ?? '');
      const stored = this.decisions.get(id);
      if (!stored) {
        this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'decision not found' } });
        return;
      }
      const body = await readJson(req);
      if (body.decision === 'approve') {
        stored.status = 'decided';
      } else {
        stored.status = 'rejected';
      }
      this.send(res, 200, {
        decisionId: stored.id,
        grade: stored.grade,
        mode: stored.mode,
        status: stored.status,
        ruleId: stored.ruleId,
        auditSeq: stored.auditSeq,
      });
      return;
    }

    this.send(res, 404, { error: { code: 'NOT_FOUND', message: `no fake route for ${req.method} ${url}` } });
  }

  // Scripted mirror of zeus DEFAULT_POLICY_V1 (CNY bands).
  private grade(body: {
    intent: string;
    amount?: { value: number; currency: string };
    impact?: string;
    reversibility?: string;
  }): StoredDecision {
    const seq = ++this.seq;
    const id = `dec_fake_${seq.toString().padStart(4, '0')}`;
    const base = { id, auditSeq: seq };

    if (body.impact === 'external' || body.reversibility === 'irreversible' || body.intent === 'product.publish') {
      return { ...base, grade: 'D3', mode: 'human-led', status: 'awaiting_approval', ruleId: 'rule-ext-001' };
    }
    const amount = body.amount?.currency === 'CNY' ? body.amount.value : undefined;
    if (amount !== undefined && amount > 5000) {
      return { ...base, grade: 'D3', mode: 'human-led', status: 'awaiting_approval', ruleId: 'rule-amount-d3' };
    }
    if (amount !== undefined && amount > 500) {
      return { ...base, grade: 'D2', mode: 'approve-sync', status: 'awaiting_approval', ruleId: 'rule-amount-d2' };
    }
    if (amount !== undefined && amount > 0) {
      return { ...base, grade: 'D1', mode: 'approve-async', status: 'awaiting_approval', ruleId: 'rule-amount-d1' };
    }
    return { ...base, grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'rule-d0' };
  }
}

function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
