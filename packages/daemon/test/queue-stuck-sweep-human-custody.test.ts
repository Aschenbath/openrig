import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { findingDedupTag, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";

describe("#514 custody findings for a human decision", () => {
  const owner: HumanFragment = {
    entityId: "owner", class: "human", displayName: "Owner", address: "owner@external",
    connectorBindings: [{ kind: "slack", connectorRef: "slack:test", secretsRef: "vault:test", role: "primary" }],
    prefs: { deliveryClass: "A" },
  };
  let db: Database.Database;
  let repo: QueueRepository;
  let sent: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    sent = [];
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [owner] }),
      transport: { send: async (destination) => { sent.push(destination); return { ok: true, verified: true }; } },
    });
  });
  afterEach(() => { db.close(); });

  async function ask(destinationSession = "owner@external", sourceSession = "asker@r") {
    return repo.create({ sourceSession, destinationSession, body: "Approve the proposed change?",
      summary: "Approve the change", evidenceRef: "https://example.test/change", nudge: false });
  }

  async function close(qitemId: string, actorSession = "closer@r") {
    await repo.update({ qitemId, actorSession, state: "done", closureReason: "handed_off_to", closureTarget: "next@r" });
  }

  async function sweep() {
    const result = await runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, isRegisteredHost: () => false, log: () => {} });
    expect(result.outcome, result.error).not.toBe("failed");
    return result;
  }

  function findings(qitemId: string) {
    return repo.list({ limit: 100 }).filter((row) => row.tags?.includes(findingDedupTag("dangling-closure", qitemId)));
  }

  function archive(qitemId: string) {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(old, qitemId);
    expect(archiveAgedTerminalTransitions(db, { nowIso: new Date().toISOString() }).archivedQitems).toBe(1);
    expect(db.prepare("SELECT 1 FROM queue_transitions WHERE qitem_id = ?").get(qitemId)).toBeUndefined();
  }

  it.each(["owner@external", "human@host", "human-reviewer@kernel", "owner@kernel"])(
    "sends %s custody verification to the closing agent, without another human notification",
    async (destination) => {
      const row = await ask(destination);
      await close(row.qitemId);
      // Neither an agent's later annotation nor gateway bookkeeping owns this closure.
      await repo.update({ qitemId: row.qitemId, actorSession: "annotator@r", transitionNote: "Checking the audit trail" });
      await repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
        transitionNote: "slack-owner-notification-posted notification_key=fixture level=NOTICE message_ts=1.2" });

      await sweep();
      expect(findings(row.qitemId)).toHaveLength(1);
      const [finding] = findings(row.qitemId);
      expect(finding).toMatchObject({ sourceSession: "asker@r", destinationSession: "closer@r", state: "pending",
        evidenceRef: `rig queue show ${row.qitemId}` });
      expect(finding!.summary).toContain("successor-verification-required");
      expect(finding!.body).toContain("rig queue list --destination next@r");
      expect(finding!.tags).toContain(STUCK_SWEEP_FINDING_TAG);
      expect(repo.transitionLog.latestOwnerNotificationForQitem(finding!.qitemId)).toBeNull();
      expect(sent).toEqual(["closer@r"]);
    },
  );

  it("retains the closing agent after retention archives the closure and newer notes arrive", async () => {
    const row = await ask();
    await close(row.qitemId);
    archive(row.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "annotator@r", transitionNote: "Reviewing the old closure" });

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("closer@r");
  });

  it.each([false, true])("uses the new closure after a deliberate reopen (old history archived: %s)", async (archived) => {
    const row = await ask();
    await close(row.qitemId, "old-closer@r");
    if (archived) archive(row.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "repairer@r", state: "pending", reopen: true,
      transitionNote: "Recheck the handoff" });
    await close(row.qitemId, "new-closer@r");

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("new-closer@r");
  });

  it.each(["owner@external", "human@host", "owner@kernel", "watchdog@system", "queue@system", "daemon@kernel"])(
    "falls back to the asking agent when the closure actor is %s",
    async (actor) => {
      const row = await ask();
      await close(row.qitemId, actor);
      await sweep();
      expect(findings(row.qitemId)).toHaveLength(1);
      expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
      expect(sent).toEqual(["asker@r"]);
    },
  );

  it("falls back to the asking agent when a historical closure has no transition record", async () => {
    const row = await ask();
    // Pre-log history can carry custody fields without an attributable closure.
    db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'handed_off_to', closure_target = 'next@r' WHERE qitem_id = ?")
      .run(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
  });

  it.each([
    { sourceAdmitted: true, destination: "asker@r" },
    { sourceAdmitted: false, destination: "owner@external" },
  ])("keeps the sweep running with an unadmitted closer (source admitted: $sourceAdmitted)", async ({ sourceAdmitted, destination }) => {
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: (session) => session === owner.address || (sourceAdmitted && session === "asker@r"),
      loadHumanRegistry: () => ({ ok: true, entities: [owner] }),
      transport: { send: async (session) => { sent.push(session); return { ok: true, verified: true }; } },
    });
    const row = await ask();
    await close(row.qitemId, "closer@remote-rig");

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe(destination);
    expect(sent).not.toContain("closer@remote-rig");
  });

  it("routes a superseded human item to the agent that canceled it", async () => {
    const row = await ask();
    await repo.update({ qitemId: row.qitemId, actorSession: "closer@r", state: "canceled",
      closureReason: "superseded", closureTarget: "qitem-missing-replacement" });
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("closer@r");
  });

  it("does not assign an earlier agent's closure to a later human cancellation", async () => {
    const row = await ask();
    await close(row.qitemId, "old-closer@r");
    await repo.update({ qitemId: row.qitemId, actorSession: "repairer@r", state: "pending", reopen: true,
      transitionNote: "Recheck the handoff" });
    // A plain cancel retains the row's old custody fields, but is a new terminal transition.
    await repo.update({ qitemId: row.qitemId, actorSession: "owner@external", state: "canceled" });
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
  });

  it("keeps the established destination when neither the closer nor the source is an agent", async () => {
    const row = await ask("owner@external", "human@host");
    await close(row.qitemId, "owner@kernel");
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("owner@external");
  });

  it("keeps an agent destination's existing custody route", async () => {
    const row = await ask("worker@r");
    await close(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("worker@r");
  });

  it("deduplicates the agent's finding and closes it when a linked successor repairs custody", async () => {
    const row = await ask();
    await close(row.qitemId);
    const original = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    const [finding] = findings(row.qitemId);
    expect(finding!.destinationSession).toBe("closer@r");
    const transitions = repo.transitionLog.listForQitem(finding!.qitemId);

    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "refreshed" }));
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(repo.transitionLog.listForQitem(finding!.qitemId)).toEqual(transitions);
    expect(sent).toEqual(["closer@r"]);

    await repo.create({ sourceSession: "closer@r", destinationSession: "next@r", body: "Continue approved work",
      chainOfRecord: [row.qitemId], nudge: false });
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "closed" }));
    expect(repo.getById(finding!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId)).toEqual(original);
  });
});
