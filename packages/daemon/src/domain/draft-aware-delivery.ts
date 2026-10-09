import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { OutboxHandler, type OutboxEntry } from "./outbox-handler.js";
import type { GuardTarget, SeatDeliveryGuard } from "./seat-delivery-guard.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import type { VersionedDeliveryPolicy } from "./seat-delivery-policy.js";
import type { SendOpts, SendResult } from "./session-transport.js";

export type DeferredDeliveryState = "waiting" | "sending" | "held" | "complete" | "indeterminate";
export interface DeferredDeliverySummary {
  id: string;
  state: DeferredDeliveryState;
  attempts: number;
  maxAttempts: number;
  deadlineAt: string;
  nextAttemptAt: string | null;
  reason: string;
}

interface StoredOptions { send: SendOpts; liveOnly: boolean }
interface RequestRow {
  id: string; node_id: string; binding: string; outbox_ids: string; outbox_fingerprint: string; body: string; options: string;
  policy_revision: string; created_at: string; deadline_at: string; next_attempt_at: string;
  attempts: number; max_attempts: number; retry_interval_ms: number; state: DeferredDeliveryState;
  reason: string; result: string | null;
}

type Deliver = (session: string, text: string, opts?: SendOpts) => Promise<SendResult>;
const sameTarget = (a: GuardTarget, b: GuardTarget): boolean => a.nodeId === b.nodeId && a.session === b.session && a.pane === b.pane && a.occupant === b.occupant;
const fingerprint = (entries: OutboxEntry[]): string => createHash("sha256").update(JSON.stringify(entries.map(entry => ({
  id: entry.outboxId, sender: entry.senderSession, destination: entry.destinationSession, body: entry.body, audit: entry.auditPointer,
})))).digest("hex");
const summary = (r: RequestRow): DeferredDeliverySummary => ({ id: r.id, state: r.state, attempts: r.attempts,
  maxAttempts: r.max_attempts, deadlineAt: r.deadline_at, nextAttemptAt: r.state === "waiting" ? r.next_attempt_at : null, reason: r.reason });

function storedOptions(opts: SendOpts): StoredOptions {
  const send: Record<string, unknown> = {};
  for (const key of ["verify", "force", "waitForIdleMs", "readinessFromPaneOnly", "dangerouslyInteract", "reason", "actorSession",
    "stampISO", "expectedStagedText", "expectedStagedLineCount", "deliveryId", "auditPointer", "committedOutboxIds", "queueWake", "identityProvenance"] as const) {
    if (opts[key] !== undefined) send[key] = opts[key];
  }
  return { send: send as SendOpts, liveOnly: !!opts.beforeWrite || !!opts.onStartupMismatch || !!opts.onInputEffect };
}

/** Retries own only the existing outbox identities. A waiting request survives
 * restart; a request interrupted during an attempted write is never replayed.
 */
export class DraftAwareDelivery {
  private readonly outbox: OutboxHandler;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private stopping = false;
  private draining?: Promise<void>;
  private readonly sends = new Set<Promise<SendResult>>();
  private wakeApplicable?: (entries: readonly OutboxEntry[]) => boolean;
  private wakeObserved?: (entries: readonly OutboxEntry[], result: SendResult) => void;

  constructor(private readonly db: Database.Database, private readonly guard: SeatDeliveryGuard,
    private readonly deliver: Deliver, private readonly now: () => Date = () => new Date()) {
    this.outbox = new OutboxHandler(db);
  }

  configureWakes(applicable: (entries: readonly OutboxEntry[]) => boolean, observed: (entries: readonly OutboxEntry[], result: SendResult) => void): void {
    this.wakeApplicable = applicable;
    this.wakeObserved = observed;
  }

  private row(id: string): RequestRow | undefined {
    return this.db.prepare(`SELECT d.* FROM seat_deferred_messages d
      JOIN seat_deferred_members m ON m.delivery_id=d.id WHERE m.outbox_id=?`).get(id) as RequestRow | undefined;
  }

  lookup(id: string): DeferredDeliverySummary | null { const row = this.row(id); return row ? summary(row) : null; }

  readback(id: string): SendResult | null {
    const row = this.row(id);
    return row ? this.result(row) : null;
  }

  existing(session: string, text: string, opts: SendOpts, ids: string[]): SendResult | null {
    const row = this.row(ids[0]!);
    if (!row) return null;
    const stored = JSON.parse(row.options) as StoredOptions;
    if (row.body !== text || (JSON.parse(row.binding) as GuardTarget).session !== session || row.outbox_ids !== JSON.stringify(ids)
      || (stored.send.actorSession ?? "unknown") !== (opts.actorSession ?? "unknown")) {
      throw new DeliveryGuardError("delivery_identity_conflict", "This delivery ID already names different content or identity.");
    }
    return this.result(row);
  }

  private result(row: RequestRow): SendResult {
    const binding = JSON.parse(row.binding) as GuardTarget;
    const outboxIds = JSON.parse(row.outbox_ids) as string[];
    const delivery = summary(row);
    if (row.result) return { ...JSON.parse(row.result) as SendResult, outboxIds, delivery };
    if (row.state === "sending" || row.state === "indeterminate") return { ok: false, sessionName: binding.session,
      reason: row.state === "sending" ? "delivery_in_progress" : "delivery_indeterminate", outcome: "failed", outboxIds, delivery,
      error: "This delivery has an unresolved write attempt. Inspect its existing ID; do not create a replacement send." };
    return { ok: true, sessionName: binding.session, sent: false, verified: false, outcome: "retained", outboxIds, delivery,
      reason: row.state === "waiting" ? "draft_delivery_waiting" : "draft_delivery_held",
      warning: row.state === "waiting"
        ? `Held for draft-aware delivery (${row.attempts}/${row.max_attempts} attempts). Inspect rig seat held-messages ${binding.session} --id ${row.id}.`
        : `Retained without automatic retry: ${row.reason}. Inspect rig seat held-messages ${binding.session} --id ${row.id}.` };
  }

  private retain(ids: string[], target: GuardTarget, text: string, opts: SendOpts): void {
    for (const id of ids) {
      const prior = opts.committedOutboxIds ? this.outbox.getById(id) : null;
      if (opts.committedOutboxIds && !prior) throw new DeliveryGuardError("outbox_not_found", "A committed wake is missing; no replacement message was created.");
      this.outbox.retain(prior
        ? { ...prior, outboxId: id, tags: prior.tags ?? undefined, auditPointer: prior.auditPointer ?? undefined }
        : { outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: target.session, body: text,
          auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance },
      target, !!opts.committedOutboxIds);
    }
  }

  async send(session: string, text: string, opts: SendOpts, ids: string[]): Promise<SendResult> {
    const pending = this.guard.operation(session, async () => {
      const target = this.guard.target(session);
      const policy = this.guard.operationPolicy(session);
      const prior = this.existing(session, text, opts, ids);
      if (prior) return prior;
      if (policy.mode !== "draft-aware" || !this.guard.needsInputCheck(session)) return this.deliver(session, text, opts);
      const request = this.prepare(target, text, opts, ids, policy);
      const result = await this.attemptSafely(request.id, opts);
      this.arm();
      return result;
    }, async target => {
      const prior = this.existing(session, text, opts, ids);
      if (prior) return prior;
      this.db.transaction(() => this.retain(ids, target, text, opts))();
      return { ok: true, sessionName: target.session, sent: false, verified: false, outcome: "retained", outboxIds: ids,
        reason: "typing_guard_enabled", warning: "Automatic input is paused. These messages will not be replayed when protection is disabled." } as SendResult;
    });
    this.sends.add(pending);
    try { return await pending; }
    finally { this.sends.delete(pending); }
  }

  private prepare(target: GuardTarget, text: string, opts: SendOpts, ids: string[], policy: VersionedDeliveryPolicy): RequestRow {
    if (!ids.length || new Set(ids).size !== ids.length) throw new DeliveryGuardError("invalid_delivery_ids", "Distinct existing delivery IDs are required.");
    const at = this.now();
    return this.db.transaction(() => {
      this.retain(ids, target, text, opts);
      this.db.prepare(`INSERT INTO seat_deferred_messages(id,node_id,binding,outbox_ids,outbox_fingerprint,body,options,policy_revision,
        created_at,deadline_at,next_attempt_at,max_attempts,retry_interval_ms,state,reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'waiting','initial')`).run(ids[0], target.nodeId, JSON.stringify(target), JSON.stringify(ids),
        fingerprint(ids.map(id => this.outbox.getById(id)!)), text,
        JSON.stringify(storedOptions(opts)), policy.revision, at.toISOString(), new Date(at.getTime() + policy.holdSeconds * 1000).toISOString(),
        at.toISOString(), policy.maxAttempts, Math.max(250, Math.ceil(policy.holdSeconds * 1000 / policy.maxAttempts)));
      for (const id of ids) this.db.prepare("INSERT INTO seat_deferred_members(outbox_id,delivery_id) VALUES (?,?)").run(id, ids[0]);
      return this.row(ids[0]!)!;
    })();
  }

  private entries(row: RequestRow): OutboxEntry[] {
    return (JSON.parse(row.outbox_ids) as string[]).map(id => {
      const entry = this.outbox.getById(id);
      if (!entry) throw new DeliveryGuardError("outbox_not_found", "An original delivery record is unavailable.");
      return entry;
    });
  }

  private hold(id: string, reason: string): SendResult {
    this.db.prepare("UPDATE seat_deferred_messages SET state='held', reason=? WHERE id=? AND state='waiting'").run(reason, id);
    return this.result(this.row(id)!);
  }

  /** Retiring any original member cancels the whole composed wake. */
  retired(outboxId: string): void {
    const row = this.row(outboxId);
    if (row) this.hold(row.id, "message_retired");
  }

  private async attemptSafely(id: string, liveOpts?: SendOpts): Promise<SendResult> {
    try { return await this.attempt(id, liveOpts); }
    catch (error) {
      const row = this.row(id);
      if (row?.state !== "sending") throw error;
      // A failed final ledger write cannot become a claimed no-write error at
      // the HTTP boundary. If reconciliation also fails, leave visible sending
      // evidence for startup recovery instead of permitting another attempt.
      try { this.db.transaction(() => this.interrupted(row))(); } catch { /* Recover on the next startup. */ }
      return this.result(this.row(id) ?? row);
    }
  }

  private async attempt(id: string, liveOpts?: SendOpts): Promise<SendResult> {
    const row = this.row(id)!;
    if (row.state !== "waiting") return this.result(row);
    if (this.stopping) return this.result(row);
    const target = JSON.parse(row.binding) as GuardTarget;
    const policy = this.guard.operationPolicy(target.nodeId);
    if (!sameTarget(target, this.guard.target(target.nodeId))) return this.hold(id, "recipient_changed");
    if (policy.mode !== "draft-aware" || policy.revision !== row.policy_revision) return this.hold(id, "delivery_policy_changed");
    if (this.now().getTime() >= Date.parse(row.deadline_at) || row.attempts >= row.max_attempts) return this.hold(id, "hold_limit_reached");
    const stored = JSON.parse(row.options) as StoredOptions;
    if (stored.liveOnly && !liveOpts) return this.hold(id, "live_prerequisite_unavailable");
    const entries = this.entries(row);
    if (fingerprint(entries) !== row.outbox_fingerprint || entries.some(entry => entry.deliveryState !== "retained" || !entry.guardBinding || !sameTarget(entry.guardBinding, target))) {
      return this.hold(id, "original_delivery_changed");
    }
    if (stored.send.queueWake && (!this.wakeApplicable || !this.wakeApplicable(entries))) return this.hold(id, "wake_no_longer_applicable");
    const claimed = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE seat_deferred_messages SET state='sending', attempts=attempts+1, reason='attempting' WHERE id=? AND state='waiting'").run(id);
      if (!changed.changes) return false;
      for (const entry of entries) {
        if (this.db.prepare("UPDATE outbox_entries SET delivery_state='sending' WHERE outbox_id=? AND delivery_state='retained'").run(entry.outboxId).changes !== 1) {
          throw new DeliveryGuardError("original_delivery_changed", "The original held delivery changed before its attempt.");
        }
      }
      return true;
    })();
    if (!claimed) return this.result(this.row(id)!);
    const opts = liveOpts ?? stored.send;
    let result: SendResult;
    let inputWritten = false;
    try {
      result = await this.deliver(target.session, row.body, { ...opts,
        onInputEffect: phase => { inputWritten = true; opts.onInputEffect?.(phase); },
        ...(opts.waitForIdleMs ? { waitForIdleMs: Math.min(opts.waitForIdleMs, Math.max(1, Date.parse(row.deadline_at) - this.now().getTime())) } : {}),
        beforeWrite: () => {
          if (this.now().getTime() >= Date.parse(row.deadline_at)) throw new DeliveryGuardError("draft_hold_expired", "The hold deadline was reached; no further input was written.");
          if (stored.send.queueWake && !this.wakeApplicable?.(entries)) throw new DeliveryGuardError("draft_wake_superseded", "The queue wake is no longer applicable; no further input was written.");
          opts.beforeWrite?.();
        },
      });
    } catch (error) {
      const refusal = error instanceof DeliveryGuardError && error.code.startsWith("draft_");
      result = { ok: false, sessionName: target.session, outcome: "failed",
        ...(refusal || inputWritten ? { sent: inputWritten } : {}), reason: refusal ? error.code : "delivery_indeterminate",
        error: refusal ? error.message : "The delivery attempt ended without a reliable write result. Automatic retry is disabled." };
    }
    if (inputWritten) result = { ...result, sent: true };
    const retryable = ["draft_input_busy", "draft_input_unknown", "draft_input_changed", "draft_hold_expired", "target_needs_input", "wait_for_idle_timeout", "target_activity_unknown"].includes(result.reason ?? "");
    const noWrite = !result.ok && !inputWritten && (result.sent === false || result.reason === "target_needs_input");
    this.db.transaction(() => {
      const current = this.row(id)!;
      if (noWrite) {
        const again = retryable && !stored.liveOnly && current.attempts < current.max_attempts && this.now().getTime() < Date.parse(current.deadline_at);
        for (const entry of entries) this.outbox.finalizeDelivery(entry.outboxId, "retained");
        this.db.prepare("UPDATE seat_deferred_messages SET state=?, reason=?, next_attempt_at=? WHERE id=? AND state='sending'")
          .run(again ? "waiting" : "held", !retryable || again ? result.reason ?? "delivery_refused" : stored.liveOnly ? "live_prerequisite_unavailable" : "hold_limit_reached",
            new Date(Math.min(Date.parse(current.deadline_at), this.now().getTime() + current.retry_interval_ms)).toISOString(), id);
      } else {
        const state = result.ok && result.verified ? "complete" : "indeterminate";
        for (const entry of entries) this.outbox.finalizeDelivery(entry.outboxId, state === "complete" ? "delivered" : "indeterminate");
        this.db.prepare("UPDATE seat_deferred_messages SET state=?, reason=?, result=? WHERE id=? AND state='sending'")
          .run(state, result.reason ?? (state === "complete" ? "delivered" : "delivery_unconfirmed"), JSON.stringify(result), id);
      }
    })();
    const finished = this.result(this.row(id)!);
    if (stored.send.queueWake && !liveOpts) {
      try { this.wakeObserved?.(entries, finished); }
      catch { console.warn("[draft-delivery] wake observation could not be recorded; retained delivery evidence is available."); }
    }
    return finished;
  }

  recover(): void {
    this.db.transaction(() => {
      const abandoned = this.db.prepare("SELECT * FROM seat_deferred_messages WHERE state='sending'").all() as RequestRow[];
      for (const row of abandoned) this.interrupted(row);
      this.db.prepare("UPDATE seat_deferred_messages SET state='held', reason='live_prerequisite_unavailable' WHERE state='waiting' AND json_extract(options,'$.liveOnly')=1").run();
    })();
  }

  private interrupted(row: RequestRow): void {
    for (const id of JSON.parse(row.outbox_ids) as string[]) {
      if (this.outbox.getById(id)) this.outbox.finalizeDelivery(id, "indeterminate");
    }
    this.db.prepare("UPDATE seat_deferred_messages SET state='indeterminate', reason='interrupted_write' WHERE id=? AND state='sending'").run(row.id);
  }

  inspect(nodeId: string, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM seat_deferred_messages WHERE node_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(nodeId, Math.max(1, Math.min(100, limit))) as RequestRow[];
    return rows.map(summary);
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = async () => {
      const rows = this.db.prepare("SELECT * FROM seat_deferred_messages WHERE state='waiting' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 32")
        .all(this.now().toISOString()) as RequestRow[];
      let index = 0;
      const worker = async () => {
        while (index < rows.length && !this.stopping) {
          const row = rows[index++]!;
          try {
            await this.guard.operation(row.node_id, () => this.attemptSafely(row.id), async () => this.hold(row.id, "typing_guard_enabled"));
          } catch {
            this.db.transaction(() => {
              if (this.row(row.id)?.state === "sending") this.interrupted(row);
              else this.hold(row.id, "recipient_or_input_unavailable");
            })();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    };
    this.draining = run().finally(() => { this.draining = undefined; this.arm(); });
    return this.draining;
  }

  start(): void { if (!this.started) { this.recover(); this.stopping = false; this.started = true; this.arm(); } }
  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.draining;
    await Promise.allSettled([...this.sends]);
  }

  private arm(): void {
    if (!this.started || this.draining) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const next = this.db.prepare("SELECT min(next_attempt_at) AS at FROM seat_deferred_messages WHERE state='waiting'").get() as { at: string | null };
    if (!next.at) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => { console.warn("[draft-delivery] retry scan failed; no replacement messages were created."); });
    }, Math.max(100, Date.parse(next.at) - this.now().getTime()));
    this.timer.unref();
  }
}
