import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal recorded loom content-base server implementing the HTTP API
 * that LoomContentClient calls (POST /api/v1/content/requests and
 * POST /api/v1/content/:id/review). It echoes a scripted candidate view so
 * tests exercise the full HTTP path without a real loom or model.
 */
interface StoredCandidate {
  candidate_id: string;
  product_id: string;
  channel: string;
  content_type: string;
  body: Record<string, unknown>;
  evidence_refs: string[];
  status: string;
  created_at: string;
}

export class FakeLoomServer {
  private server?: Server;
  private candidates = new Map<string, StoredCandidate>();
  private seq = 0;
  url = '';
  /** When set, /requests returns this status once (error-path testing). */
  failRequestsWith = 0;

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
    this.candidates.clear();
    this.seq = 0;
    this.failRequestsWith = 0;
  }

  private send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private view(c: StoredCandidate) {
    return { ...c, final_body: null, review_note: null, reviewed_by: null, reviewed_at: null };
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/content/requests') {
      if (this.failRequestsWith) {
        const status = this.failRequestsWith;
        this.failRequestsWith = 0;
        this.send(res, status, { detail: 'scripted failure' });
        return;
      }
      const body = await readJson(req);
      const stored: StoredCandidate = {
        candidate_id: `loom_fake_${(++this.seq).toString().padStart(4, '0')}`,
        product_id: String(body.product_id),
        channel: String(body.channel),
        content_type: String(body.content_type),
        body: { title: 'T', text: 'B' },
        evidence_refs: ['llm:agnes-3.0-flash'],
        status: 'pending_review',
        created_at: new Date().toISOString(),
      };
      this.candidates.set(stored.candidate_id, stored);
      this.send(res, 201, this.view(stored));
      return;
    }

    const reviewMatch = /^\/api\/v1\/content\/([^/]+)\/review$/.exec(url);
    if (req.method === 'POST' && reviewMatch) {
      const id = decodeURIComponent(reviewMatch[1] ?? '');
      const stored = this.candidates.get(id);
      if (!stored) {
        this.send(res, 404, { detail: 'not found' });
        return;
      }
      const body = await readJson(req);
      stored.status = String(body.decision);
      this.send(res, 200, this.view(stored));
      return;
    }

    this.send(res, 404, { detail: `no fake route for ${req.method} ${url}` });
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
