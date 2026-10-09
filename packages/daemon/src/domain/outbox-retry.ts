import type Database from "better-sqlite3";
import { OutboxHandler, type OutboxDeliveryState, type OutboxEntry } from "./outbox-handler.js";

/** Scheduling and replay data only. Identity, original bodies, custody and creation
 * time remain on the existing outbox records; a composed wake uses its first member.
 */
export interface OutboxRetryRequest {
  deadlineAt: string;
  nextAttemptAt: string | null;
  attempts: number;
  maxAttempts: number;
  retryIntervalMs: number;
  guardRevision: string;
  fingerprint: string;
  options: { send: object; liveOnly: boolean };
  composedBody?: string;
  reason: string;
  result?: object;
}

export interface OutboxRetryRecord { entry: OutboxEntry; request: OutboxRetryRequest }

export class OutboxRetryStore {
  readonly available: boolean;
  private readonly outbox: OutboxHandler;

  constructor(readonly db: Database.Database) {
    this.outbox = new OutboxHandler(db);
    this.available = (db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some(c => c.name === "retry_request");
  }

  get(id: string): OutboxRetryRecord | null {
    if (!this.available) return null;
    const row = this.db.prepare(`SELECT owner.outbox_id, owner.retry_request FROM outbox_entries member
      JOIN outbox_entries owner ON owner.outbox_id=coalesce(member.retry_owner,member.outbox_id)
      WHERE member.outbox_id=? AND owner.retry_request IS NOT NULL`).get(id) as { outbox_id: string; retry_request: string } | undefined;
    return row ? { entry: this.outbox.getById(row.outbox_id)!, request: JSON.parse(row.retry_request) as OutboxRetryRequest } : null;
  }

  create(ids: string[], request: OutboxRetryRequest): void {
    const owner = ids[0]!;
    for (const id of ids) {
      const changed = this.db.prepare("UPDATE outbox_entries SET retry_owner=? WHERE outbox_id=? AND retry_owner IS NULL AND delivery_state='retained'").run(owner, id);
      if (changed.changes !== 1) throw new Error("An original retry member is unavailable or already owned");
    }
    this.db.prepare("UPDATE outbox_entries SET retry_request=? WHERE outbox_id=?").run(JSON.stringify(request), owner);
  }

  update(id: string, patch: Partial<OutboxRetryRequest>, expectedState?: OutboxDeliveryState): boolean {
    const current = this.get(id);
    if (!current) throw new Error("The original retry record is unavailable");
    const data = JSON.stringify({ ...current.request, ...patch });
    return (expectedState
      ? this.db.prepare("UPDATE outbox_entries SET retry_request=? WHERE outbox_id=? AND delivery_state=?").run(data, current.entry.outboxId, expectedState)
      : this.db.prepare("UPDATE outbox_entries SET retry_request=? WHERE outbox_id=?").run(data, current.entry.outboxId)).changes === 1;
  }

  due(at: string, limit = 32): string[] {
    if (!this.available) return [];
    return (this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE retry_request IS NOT NULL AND delivery_state='retained'
      AND json_extract(retry_request,'$.nextAttemptAt') IS NOT NULL AND json_extract(retry_request,'$.nextAttemptAt')<=?
      ORDER BY json_extract(retry_request,'$.nextAttemptAt'),outbox_id LIMIT ?`).all(at, limit) as Array<{ outbox_id: string }>).map(r => r.outbox_id);
  }

  nextAt(): string | null {
    if (!this.available) return null;
    return (this.db.prepare(`SELECT json_extract(retry_request,'$.nextAttemptAt') AS next FROM outbox_entries
      WHERE retry_request IS NOT NULL AND delivery_state='retained' AND json_extract(retry_request,'$.nextAttemptAt') IS NOT NULL
      ORDER BY json_extract(retry_request,'$.nextAttemptAt'),outbox_id LIMIT 1`).get() as { next: string } | undefined)?.next ?? null;
  }

  interrupted(): string[] {
    if (!this.available) return [];
    // Queue recovery may already have classified a claimed wake indeterminate.
    // Its retry metadata still needs to lose the scheduled time and say why.
    return (this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE retry_request IS NOT NULL
      AND (delivery_state='sending' OR (delivery_state='indeterminate' AND json_extract(retry_request,'$.reason')='attempting'))`)
      .all() as Array<{ outbox_id: string }>).map(r => r.outbox_id);
  }

  forNode(nodeId: string, limit = 100): string[] {
    if (!this.available) return [];
    return (this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE retry_request IS NOT NULL
      AND json_extract(guard_binding,'$.nodeId')=? ORDER BY ts_dispatched DESC,outbox_id DESC LIMIT ?`)
      .all(nodeId, limit) as Array<{ outbox_id: string }>).map(r => r.outbox_id);
  }

  holdForGuard(nodeId: string, reason: string, keepRevision?: string): void {
    if (!this.available) return;
    this.db.prepare(`UPDATE outbox_entries SET retry_request=json_set(retry_request,'$.nextAttemptAt',NULL,'$.reason',?)
      WHERE retry_request IS NOT NULL AND delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=?
        AND json_extract(retry_request,'$.nextAttemptAt') IS NOT NULL
        AND (? IS NULL OR json_extract(retry_request,'$.guardRevision')!=?)`).run(reason, nodeId, keepRevision ?? null, keepRevision ?? null);
  }

  recoverGuards(): void {
    if (!this.available) return;
    this.db.prepare(`UPDATE outbox_entries SET retry_request=json_set(retry_request,'$.nextAttemptAt',NULL,'$.reason','typing_guard_changed')
      WHERE retry_request IS NOT NULL AND delivery_state='retained' AND json_extract(retry_request,'$.nextAttemptAt') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM seat_delivery_guards g WHERE g.node_id=json_extract(outbox_entries.guard_binding,'$.nodeId')
          AND json_extract(g.effective_config,'$.mode')='draft-aware'
          AND json_extract(g.effective_config,'$.revision')=json_extract(outbox_entries.retry_request,'$.guardRevision'))`).run();
    this.db.prepare(`UPDATE outbox_entries SET retry_request=json_set(retry_request,'$.nextAttemptAt',NULL,'$.reason','live_prerequisite_unavailable')
      WHERE retry_request IS NOT NULL AND delivery_state='retained' AND json_extract(retry_request,'$.options.liveOnly')=1`).run();
  }
}
