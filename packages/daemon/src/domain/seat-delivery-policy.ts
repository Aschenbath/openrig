import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const SEAT_DELIVERY_MODES = ["automatic", "draft-aware", "inbox-only"] as const;
export type SeatDeliveryMode = (typeof SEAT_DELIVERY_MODES)[number];

export interface SeatDeliveryPolicy {
  mode: SeatDeliveryMode;
  holdSeconds: number;
  maxAttempts: number;
}

export interface VersionedDeliveryPolicy extends SeatDeliveryPolicy {
  revision: string;
}

export interface SeatDeliveryPreference {
  nodeId: string;
  desired: VersionedDeliveryPolicy;
  effective: VersionedDeliveryPolicy;
  pending: boolean;
}

const DEFAULT_POLICY: VersionedDeliveryPolicy = {
  mode: "automatic", holdSeconds: 120, maxAttempts: 10, revision: "default",
};

export class SeatDeliveryPolicyError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parseSeatDeliveryPolicy(value: unknown): SeatDeliveryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SeatDeliveryPolicyError("invalid_delivery_policy", "A delivery policy object is required.");
  }
  const input = value as Record<string, unknown>;
  if (!(SEAT_DELIVERY_MODES as readonly unknown[]).includes(input.mode)) {
    throw new SeatDeliveryPolicyError("invalid_delivery_policy", "mode must be automatic, draft-aware or inbox-only.");
  }
  const holdSeconds = input.holdSeconds === undefined ? DEFAULT_POLICY.holdSeconds : input.holdSeconds;
  const maxAttempts = input.maxAttempts === undefined ? DEFAULT_POLICY.maxAttempts : input.maxAttempts;
  if (typeof holdSeconds !== "number" || !Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 3600) {
    throw new SeatDeliveryPolicyError("invalid_delivery_policy", "holdSeconds must be an integer from 1 to 3600.");
  }
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new SeatDeliveryPolicyError("invalid_delivery_policy", "maxAttempts must be an integer from 1 to 100.");
  }
  return { mode: input.mode as SeatDeliveryMode, holdSeconds, maxAttempts };
}

function readPolicy(raw: string): VersionedDeliveryPolicy {
  const input = JSON.parse(raw) as Record<string, unknown>;
  const policy = parseSeatDeliveryPolicy(input);
  if (typeof input.revision !== "string" || !input.revision) {
    throw new SeatDeliveryPolicyError("invalid_delivery_policy", "The stored delivery policy has no revision.");
  }
  return { ...policy, revision: input.revision };
}

/** Preferences belong to a seat; deferred messages separately pin its current occupant.
 * Activation is serialized by SeatDeliveryGuard with all input and lifecycle operations.
 */
export class SeatDeliveryPolicyStore {
  readonly available: boolean;

  constructor(readonly db: Database.Database) {
    // Curated old-schema test fixtures cannot opt in and retain automatic delivery.
    this.available = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seat_delivery_policies'").get();
  }

  get(nodeId: string): SeatDeliveryPreference {
    const row = this.available ? this.db.prepare("SELECT desired_policy, effective_policy FROM seat_delivery_policies WHERE node_id=?")
      .get(nodeId) as { desired_policy: string; effective_policy: string } | undefined : undefined;
    const desired = row ? readPolicy(row.desired_policy) : { ...DEFAULT_POLICY };
    const effective = row ? readPolicy(row.effective_policy) : { ...DEFAULT_POLICY };
    return { nodeId, desired, effective, pending: desired.revision !== effective.revision };
  }

  request(nodeId: string, value: unknown, actor: string, reason: string, at: string): VersionedDeliveryPolicy {
    if (!this.available) throw new SeatDeliveryPolicyError("delivery_policy_unavailable", "The delivery policy schema is unavailable.");
    if (!actor.trim() || !reason.trim()) throw new SeatDeliveryPolicyError("delivery_policy_reason_required", "Actor and reason are required.");
    const parsed = parseSeatDeliveryPolicy(value);
    return this.db.transaction(() => {
      const prior = this.get(nodeId);
      const unchanged = parsed.mode === prior.desired.mode && parsed.holdSeconds === prior.desired.holdSeconds
        && parsed.maxAttempts === prior.desired.maxAttempts && prior.desired.revision !== "default";
      const desired = { ...parsed, revision: unchanged ? prior.desired.revision : randomUUID() };
      this.db.prepare(`INSERT INTO seat_delivery_policies(node_id, desired_policy, effective_policy, actor, reason, requested_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET desired_policy=excluded.desired_policy,
        actor=excluded.actor, reason=excluded.reason, requested_at=excluded.requested_at, effective_at=NULL`)
        .run(nodeId, JSON.stringify(desired), JSON.stringify(prior.effective), actor, reason, at);
      return desired;
    })();
  }

  activate(nodeId: string, policy: VersionedDeliveryPolicy, at: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE seat_delivery_policies SET effective_policy=?, effective_at=? WHERE node_id=?")
        .run(JSON.stringify(policy), at, nodeId);
      this.db.prepare("UPDATE seat_deferred_messages SET state='held', reason='delivery_policy_changed' WHERE node_id=? AND state='waiting' AND policy_revision!=?")
        .run(nodeId, policy.revision);
    })();
  }

  holdPending(nodeId: string, reason: string): void {
    if (this.available) this.db.prepare("UPDATE seat_deferred_messages SET state='held', reason=? WHERE node_id=? AND state='waiting'").run(reason, nodeId);
  }

  recoverActivation(at: string): void {
    if (!this.available) return;
    this.db.prepare("UPDATE seat_delivery_policies SET effective_policy=desired_policy, effective_at=? WHERE effective_policy!=desired_policy").run(at);
    this.db.prepare(`UPDATE seat_deferred_messages SET state='held', reason='delivery_policy_changed'
      WHERE state='waiting' AND NOT EXISTS (SELECT 1 FROM seat_delivery_policies p WHERE p.node_id=seat_deferred_messages.node_id
        AND json_extract(p.effective_policy,'$.revision')=seat_deferred_messages.policy_revision
        AND json_extract(p.effective_policy,'$.mode')='draft-aware')`).run();
  }
}
