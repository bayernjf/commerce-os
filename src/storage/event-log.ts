import type { StorageDriver } from './driver.js';
import { newId, nowIso } from '../util/ids.js';

export interface CommerceEvent {
  id: string;
  eventType: string;
  refType?: string;
  refId?: string;
  decisionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Local commerce audit trail. Every key action appends one event. */
export class EventLog {
  constructor(private readonly driver: StorageDriver) {}

  async record(event: {
    eventType: string;
    refType?: string;
    refId?: string;
    decisionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<CommerceEvent> {
    const row: CommerceEvent = {
      id: newId('evt'),
      eventType: event.eventType,
      ...(event.refType ? { refType: event.refType } : {}),
      ...(event.refId ? { refId: event.refId } : {}),
      ...(event.decisionId ? { decisionId: event.decisionId } : {}),
      payload: event.payload ?? {},
      createdAt: nowIso(),
    };
    await this.driver.run(
      `INSERT INTO commerce_events (id, event_type, ref_type, ref_id, decision_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.eventType,
        row.refType ?? null,
        row.refId ?? null,
        row.decisionId ?? null,
        JSON.stringify(row.payload),
        row.createdAt,
      ],
    );
    return row;
  }

  async list(filter?: { refType?: string; refId?: string; eventType?: string }): Promise<CommerceEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.refType) {
      where.push('ref_type = ?');
      params.push(filter.refType);
    }
    if (filter?.refId) {
      where.push('ref_id = ?');
      params.push(filter.refId);
    }
    if (filter?.eventType) {
      where.push('event_type = ?');
      params.push(filter.eventType);
    }
    const sql = `SELECT * FROM commerce_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC`;
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): CommerceEvent {
    return {
      id: String(r.id),
      eventType: String(r.event_type),
      ...(r.ref_type ? { refType: String(r.ref_type) } : {}),
      ...(r.ref_id ? { refId: String(r.ref_id) } : {}),
      ...(r.decision_id ? { decisionId: String(r.decision_id) } : {}),
      payload: (() => {
        try {
          return JSON.parse(String(r.payload_json ?? '{}')) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      createdAt: String(r.created_at),
    };
  }
}
