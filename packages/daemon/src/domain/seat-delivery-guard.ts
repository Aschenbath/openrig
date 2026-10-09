import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { SeatDeliveryPolicyStore, type VersionedDeliveryPolicy } from "./seat-delivery-policy.js";
import { composerContainsOwnedText, inspectComposerInput, ownCollapsedPaste, type ComposerSnapshot } from "./composer-input.js";

/** A binding is captured before waiting. Never rebind an old operation to a new occupant. */
export interface GuardTarget {
  nodeId: string;
  session: string;
  occupant: string | null;
  pane: string | null;
}

interface Lease {
  target: GuardTarget;
  active: boolean;
  origin: "automatic" | "human";
  lifecycle?: boolean;
  freshLifecycle?: boolean;
  policy?: VersionedDeliveryPolicy;
  humanEpoch: number;
  staged?: { text: string; collapsedPaste: string | null };
}

export class DeliveryGuardError extends Error {
  constructor(readonly code: string, message: string) { super(message); }

  // Hono's error protocol also preserves this typed refusal on lifecycle routes.
  getResponse(): Response {
    return Response.json({ ok: false, code: this.code, error: this.message }, { status: 409 });
  }
}

export interface GuardPreference {
  nodeId: string;
  desired: boolean;
  effective: boolean;
  pending: boolean;
}

/** One serialization domain for preference activation, delivery and writing lifecycle.
 * No timer drains held messages. Async context carries a lease through nested adapters;
 * active=false prevents a detached task from retaining permission after its operation ends.
 */
export class SeatDeliveryGuard {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scope = new AsyncLocalStorage<Map<string, Lease>>();
  private readonly humanLeases = new Set<Lease>();
  private readonly humanEpochs = new Map<string, number>();
  private inspectInput?: (target: GuardTarget) => Promise<ComposerSnapshot | null>;
  private inputAbsent?: (target: GuardTarget) => Promise<boolean>;
  readonly policies: SeatDeliveryPolicyStore;

  constructor(
    readonly db: Database.Database,
    private readonly resolve: (target: string) => GuardTarget | null,
  ) { this.policies = new SeatDeliveryPolicyStore(db); }

  attachInputInspection(inspect: (target: GuardTarget) => Promise<ComposerSnapshot | null>, absent: (target: GuardTarget) => Promise<boolean>): void {
    this.inspectInput = inspect;
    this.inputAbsent = absent;
  }

  /** Startup-only, before exposing routes or starting writers. A stopped operation cannot
   * retain an in-memory lease. Persisted desired protection applies at the new boundary. */
  recoverActivation(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE seat_delivery_guards SET effective = desired WHERE effective != desired").run();
      this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE effective_at IS NULL")
        .run(new Date().toISOString());
      this.policies.recoverActivation(new Date().toISOString());
      if (this.policies.available) {
        for (const row of this.db.prepare("SELECT node_id FROM seat_delivery_guards WHERE desired=1").all() as Array<{ node_id: string }>) {
          this.policies.holdPending(row.node_id, "typing_guard_enabled");
        }
      }
    })();
  }

  preference(nodeId: string): GuardPreference {
    const row = this.db.prepare("SELECT desired, effective FROM seat_delivery_guards WHERE node_id = ?")
      .get(nodeId) as { desired: number; effective: number } | undefined;
    return { nodeId, desired: !!row?.desired, effective: !!row?.effective, pending: row !== undefined && row.desired !== row.effective };
  }

  maybeTarget(name: string): GuardTarget | null { return this.resolve(name); }

  target(name: string): GuardTarget {
    const target = this.resolve(name);
    if (!target) throw new DeliveryGuardError("guard_target_unknown", `Cannot establish managed input target ${name}; no input written.`);
    return target;
  }

  private same(a: GuardTarget, b: GuardTarget): boolean {
    return a.nodeId === b.nodeId && a.session === b.session && a.occupant === b.occupant && a.pane === b.pane;
  }

  private async serial<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(nodeId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = before.then(() => done);
    this.tails.set(nodeId, tail);
    await before;
    try { return await fn(); }
    finally { release(); if (this.tails.get(nodeId) === tail) this.tails.delete(nodeId); }
  }

  async set(nodeId: string, enabled: boolean, actor: string, reason: string, timeoutMs = 2000): Promise<GuardPreference> {
    if (!actor.trim() || !reason.trim()) throw new DeliveryGuardError("guard_reason_required", "Actor and reason are required.");
    const at = new Date().toISOString();
    const change = this.db.transaction(() => {
      const old = this.preference(nodeId);
      this.db.prepare(`INSERT INTO seat_delivery_guards(node_id, desired, effective, actor, reason, changed_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET
        desired=excluded.desired, actor=excluded.actor, reason=excluded.reason, changed_at=excluded.changed_at`)
        .run(nodeId, Number(enabled), Number(old.effective), actor, reason, at);
      return this.db.prepare(`INSERT INTO seat_delivery_guard_changes(node_id, desired, previous_desired, previous_effective, actor, reason, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nodeId, Number(enabled), Number(old.desired), Number(old.effective), actor, reason, at).lastInsertRowid;
    })();
    const activation = this.serial(nodeId, async () => {
      this.db.transaction(() => {
        // Later requests are serialized too. Apply each accepted transition, in order.
        this.db.prepare("UPDATE seat_delivery_guards SET effective = ? WHERE node_id = ?").run(Number(enabled), nodeId);
        if (enabled) this.policies.holdPending(nodeId, "typing_guard_enabled");
        this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE id = ?")
          .run(new Date().toISOString(), change);
      })();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([activation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.preference(nodeId);
    } finally { if (timer) clearTimeout(timer); }
  }

  async setPolicy(nodeId: string, value: unknown, actor: string, reason: string, timeoutMs = 2000) {
    const desired = this.policies.request(nodeId, value, actor, reason, new Date().toISOString());
    const activation = this.serial(nodeId, async () => {
      this.policies.activate(nodeId, desired, new Date().toISOString());
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([activation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.policies.get(nodeId);
    } finally { if (timer) clearTimeout(timer); }
  }

  operationPolicy(name: string): VersionedDeliveryPolicy {
    const target = this.target(name);
    return this.scope.getStore()?.get(target.nodeId)?.policy ?? this.policies.get(target.nodeId).effective;
  }

  /** fn must include lifecycle preflight, effects and last write. Retention callbacks
   * execute under this same lease, before any pane capture/paste/submit branch. */
  async operation<T>(name: string, fn: () => Promise<T>, held?: (target: GuardTarget) => Promise<T>): Promise<T> {
    const bound = this.target(name);
    const inherited = this.scope.getStore()?.get(bound.nodeId);
    if (inherited?.active && inherited.target.nodeId === bound.nodeId) {
      this.assertCurrent(name, inherited);
      return fn();
    }
    return this.serial(bound.nodeId, async () => {
      const current = this.target(name);
      if (!this.same(bound, current)) throw new DeliveryGuardError("guard_target_changed", "Input target changed while waiting; no input written.");
      const pref = this.preference(bound.nodeId);
      const policy = this.policies.get(bound.nodeId);
      if (pref.effective || pref.desired || policy.desired.mode === "inbox-only" || policy.effective.mode === "inbox-only") {
        if (held) return held(bound);
        throw new DeliveryGuardError("typing_guard_enabled", "Automatic input is paused for this seat. Disable its typing guard or inbox-only policy explicitly before this writing operation.");
      }
      const lease: Lease = { target: bound, active: true, origin: "automatic", humanEpoch: this.humanEpochs.get(bound.nodeId) ?? 0,
        policy: policy.desired.mode === "draft-aware" ? policy.desired : policy.effective };
      try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
      finally { lease.active = false; }
    });
  }

  ownsLifecycle(nodeId: string): boolean {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) return false;
    this.assertCurrent(nodeId, lease);
    return true;
  }

  /** Multi-seat restore takes leases in stable order before any rig mutation.
   * Nested per-seat launch joins these leases; it must not reacquire them. */
  async lifecycle<T>(nodeIds: string[], fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(nodeIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const id = ids[index]; if (!id) return fn();
      if (this.ownsLifecycle(id)) return acquire(index + 1);
      return this.operation(id, async () => {
        const lease = this.scope.getStore()!.get(id)!;
        if (lease.policy?.mode === "draft-aware") {
          // Only a positively absent input may receive fresh startup/resume writes.
          // An active protected seat requires an explicit policy change first.
          const absent = !lease.target.pane || await this.inputAbsent?.(lease.target) === true;
          this.assertCurrent(id, lease);
          if (!absent) throw new DeliveryGuardError("draft_aware_lifecycle", "This active seat uses draft-aware delivery. Select automatic delivery before a writing lifecycle operation; held messages are not replayed.");
          lease.freshLifecycle = true;
        }
        lease.lifecycle = true;
        return acquire(index + 1);
      });
    };
    return acquire(0);
  }

  /** Called only after an intentional lifecycle binding change, under its lease.
   * Ordinary sends cannot adopt a replacement occupant or recycled pane. */
  rebindLifecycle(nodeId: string): void {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) throw new DeliveryGuardError("guard_lease_required", "Binding changes require the complete lifecycle lease.");
    lease.target = this.target(nodeId);
  }

  private assertCurrent(name: string, lease: Lease): void {
    if (!lease.active || !this.same(lease.target, this.target(name))) {
      throw new DeliveryGuardError("guard_target_changed", "Input target/occupant changed; no input written.");
    }
  }

  /** Synchronous final-effect check: no await between this and issuing the write. */
  checkInput(name: string): void {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (!lease) throw new DeliveryGuardError("guard_lease_required", "Input requires an active operation lease.");
    this.assertCurrent(name, lease);
    if (lease.origin === "automatic" && !lease.freshLifecycle && lease.policy?.mode === "draft-aware"
      && lease.humanEpoch !== (this.humanEpochs.get(target.nodeId) ?? 0)) {
      throw new DeliveryGuardError("draft_input_changed", "Human input arrived during this delivery. No further automatic input was written.");
    }
  }

  needsInputCheck(name: string): boolean {
    const target = this.maybeTarget(name);
    if (!target) return false; // Proven private probes have no managed-seat policy.
    const lease = this.scope.getStore()?.get(target.nodeId);
    return !!lease?.active && lease.origin === "automatic" && !lease.freshLifecycle && lease.policy?.mode === "draft-aware";
  }

  /** Called at the paste/key boundary after file and buffer preparation. */
  async beforeInput(name: string, submit = false): Promise<void> {
    if (!this.needsInputCheck(name)) return;
    const target = this.target(name);
    const lease = this.scope.getStore()!.get(target.nodeId)!;
    const snapshot = await this.inspectInput?.(target).catch(() => null) ?? null;
    this.checkInput(name);
    const input = inspectComposerInput(snapshot);
    if (input.state === "unknown") throw new DeliveryGuardError("draft_input_unknown", "The current input cannot be read. Automatic delivery is held.");
    if (submit) {
      const owned = lease.staged && (composerContainsOwnedText(input, lease.staged.text)
        || !!lease.staged.collapsedPaste && input.cursorAtEnd && input.collapsedPaste === lease.staged.collapsedPaste);
      if (!owned) throw new DeliveryGuardError("draft_input_changed", "The input no longer contains only this delivery's staged text. Enter was not sent.");
    } else if (input.state !== "empty") {
      throw new DeliveryGuardError("draft_input_busy", "The seat has an unsubmitted input. Automatic delivery is held.");
    }
  }

  expectStagedInput(name: string, text: string): void {
    if (!this.needsInputCheck(name)) return;
    const target = this.target(name);
    this.scope.getStore()!.get(target.nodeId)!.staged = { text, collapsedPaste: null };
  }

  async notePasted(name: string, text: string): Promise<void> {
    try {
      if (!this.needsInputCheck(name)) return;
      const target = this.target(name);
      const lease = this.scope.getStore()!.get(target.nodeId)!;
      lease.staged = { text, collapsedPaste: null };
      const snapshot = await this.inspectInput?.(target).catch(() => null) ?? null;
      lease.staged.collapsedPaste = ownCollapsedPaste(inspectComposerInput(snapshot), text);
    } catch { /* Observation cannot turn a completed paste into a claimed no-write failure. */ }
  }

  noteSubmitted(name: string): void {
    try {
      const target = this.maybeTarget(name);
      const lease = target && this.scope.getStore()?.get(target.nodeId);
      if (lease) lease.staged = undefined;
    } catch { /* Enter already succeeded. */ }
  }

  /** Reconciliation is a synchronous DB transaction, not a nested input operation.
   * Refuse rather than waiting on a sender that could itself be awaiting this call.
   * Pending activation and explicit human input protect the same occupant boundary. */
  reconcileBinding<T>(expected: GuardTarget, commit: () => T): T {
    if (!this.same(expected, this.target(expected.nodeId))) {
      throw new DeliveryGuardError("guard_target_changed", "Reconciliation target changed during observation; retry with current identity.");
    }
    if (this.tails.has(expected.nodeId) || [...this.humanLeases].some(l => l.active && l.target.nodeId === expected.nodeId)) {
      throw new DeliveryGuardError("guard_operation_in_progress", "Seat operation in progress; reconciliation did not change custody. Retry after it finishes.");
    }
    const pref = this.preference(expected.nodeId);
    const policy = this.policies.get(expected.nodeId);
    if (pref.desired || pref.effective || policy.desired.mode !== "automatic" || policy.effective.mode !== "automatic") {
      throw new DeliveryGuardError("typing_guard_enabled", "Reconciliation cannot replace the occupant while typing protection is enabled.");
    }
    return commit();
  }

  async input<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (lease?.active) { this.assertCurrent(name, lease); return fn(); }
    return this.operation(name, fn);
  }

  /** Internal broker path only; never an option accepted by the send HTTP route. */
  async humanInput<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const humanEpoch = (this.humanEpochs.get(target.nodeId) ?? 0) + 1;
    this.humanEpochs.set(target.nodeId, humanEpoch);
    const lease: Lease = { target, active: true, origin: "human", humanEpoch };
    this.humanLeases.add(lease);
    try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
    finally { lease.active = false; this.humanLeases.delete(lease); }
  }
}

/** Current binding, never a latest historical session-name guess. Unbound seats
 * resolve by node/canonical address for preferences and lifecycle preflight.
 * #174: an archived rig can keep a binding to the same session name as a live
 * seat, so unarchived matches win; archived ones count only when nothing else
 * matches. Exactly one match is still required. */
export function resolveGuardTarget(db: Database.Database, name: string): GuardTarget | null {
  const rows = db.prepare(`SELECT n.id AS nodeId,
      coalesce(b.tmux_session, replace(n.logical_id,'.','-') || '@' || r.name) AS session,
      b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id=n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant,
      r.archived_at AS archivedAt
    FROM nodes n JOIN rigs r ON r.id=n.rig_id LEFT JOIN bindings b ON b.node_id=n.id
    WHERE n.id=? OR b.tmux_session=? OR b.tmux_pane=? OR n.logical_id=?
      OR (b.tmux_session IS NULL AND replace(n.logical_id,'.','-') || '@' || r.name=?)`)
    .all(name, name, name, name, name) as Array<GuardTarget & { archivedAt: string | null }>;
  const unarchived = rows.filter((row) => row.archivedAt === null);
  const pool = unarchived.length > 0 ? unarchived : rows;
  if (pool.length !== 1) return null;
  const { archivedAt: _archivedAt, ...target } = pool[0]!;
  return target;
}
