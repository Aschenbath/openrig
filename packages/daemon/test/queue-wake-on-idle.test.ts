import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { classifyNudgeFailure, QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import type { AgentActivity } from "../src/domain/types.js";
import { createDaemon } from "../src/startup.js";

type Send = Parameters<QueueRepository["attachTransport"]>[0]["send"];
type SendResult = Awaited<ReturnType<Send>>;
const destination = "worker@busy-retry";
const busyError = "Target was still busy (mid_work_pattern) when the 10000ms wait ended (5 observations). No text was sent.";
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(initial: SendResult = { ok: false, sent: false, reason: "wait_for_idle_timeout", error: busyError }) {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db);
  let result = initial;
  const send = vi.fn<Send>(async () => result);
  const construct = () => {
    const queue = new QueueRepository(db, bus, { transport: { send }, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    queue.attachOutbox(outbox);
    return queue;
  };
  let queue = construct();
  const observe = (state: AgentActivity["state"] | undefined) => Promise.all([
    queue.retryPromptWakesOnClear(destination, state), queue.retryBusyWakesOnIdle(destination, state),
  ]);
  const stage = async (kind: "create" | "handoff" = "create") => {
    const source = await queue.create({ sourceSession: "planner@busy-retry", destinationSession: kind === "create" ? destination : "builder@busy-retry",
      body: "review the finished work", ...(kind === "handoff" ? { nudge: false } : {}) });
    const row = kind === "create" ? source : (await queue.handoff({ qitemId: source.qitemId,
      fromSession: "builder@busy-retry", toSession: destination, body: "review the finished work" })).created;
    await vi.waitFor(() => expect(["failed", "indeterminate", "retained"]).toContain(outbox.getById(WAKE_INTENT_PREFIX + row.qitemId)?.deliveryState));
    return row.qitemId;
  };
  return { db, outbox, send, observe, stage, queue: () => queue,
    outcome: (value: SendResult) => { result = value; }, reconstruct: () => { queue = construct(); },
    wake: (id: string) => outbox.getById(WAKE_INTENT_PREFIX + id)!,
  };
}

it.each(["create", "handoff"] as const)("retries an unsent busy %s wake once on idle with its original envelope", async kind => {
  const f = fixture(); await f.observe("running"); const id = await f.stage(kind);
  expect(f.wake(id).deliveryState).toBe("failed");
  expect(f.queue().getById(id)?.lastNudgeWireResult).toContain(busyError);
  expect(classifyNudgeFailure(f.queue().getById(id)?.lastNudgeWireResult)).toBe("transient");
  const original = f.wake(id);
  f.outcome({ ok: true, verified: true });
  await f.observe("idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1][1]).toContain(original.body);
  expect(f.send.mock.calls[1][1]).toBe(f.send.mock.calls[0][1]);
  expect(f.wake(id).outboxId).toBe(original.outboxId);
  expect(f.wake(id).deliveryState).toBe("delivered");
  expect(f.queue().getById(id)?.state).toBe("pending");
  await Promise.all([f.observe("idle"), f.observe("idle")]);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("also recovers an older definitely-unsent busy receipt when the next observation is idle", async () => {
  const f = fixture({ ok: false, sent: false, error: busyError });
  const id = await f.stage();
  expect(f.wake(id).deliveryState).toBe("failed");
  f.outcome({ ok: true, verified: true });
  await f.observe("idle");
  expect(f.wake(id).deliveryState).toBe("delivered");
});

it.each([
  { ok: false, sent: false, reason: "wait_for_idle_timeout", error: "Busy before input; try again after this turn" },
  { ok: false, sent: false, reason: "wait_for_idle_timeout", error: "Idle prompt not found before the busy wait ended" },
  { ok: false, inputPhase: "not_reached", reason: "wait_for_idle_timeout" },
] satisfies SendResult[])("retains the typed pre-input busy refusal independently of its prose: %j", async outcome => {
  const f = fixture(outcome); const id = await f.stage();
  expect(f.wake(id).deliveryState).toBe("failed");
  expect(classifyNudgeFailure(f.queue().getById(id)?.lastNudgeWireResult)).toBe("transient");
  f.outcome({ ok: true, verified: true }); await f.observe("idle");
  expect(f.wake(id).deliveryState).toBe("delivered");
});

it("requires positive idle, and does not retry a busy failure merely because a permission mark clears to working", async () => {
  const f = fixture({ ok: false, sent: false, error: busyError });
  const id = await f.stage(); f.outcome({ ok: true, verified: true });
  for (const state of ["needs_input", "unknown", undefined, "running"] as const) await f.observe(state);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.wake(id).deliveryState).toBe("failed");
  await f.observe("idle");
  expect(f.wake(id).deliveryState).toBe("delivered");
});

it("bounds idle-triggered retries of the same still-busy wake, including after repository reconstruction", async () => {
  const f = fixture({ ok: false, sent: false, error: busyError });
  const id = await f.stage();
  await f.observe("idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.wake(id).deliveryState).toBe("failed");
  for (let index = 0; index < 3; index++) {
    f.reconstruct();
    await f.observe("running"); await f.observe("idle");
  }
  expect(f.send).toHaveBeenCalledTimes(2);
});

it.each(["claimed", "terminal"] as const)("skips a busy wake whose row became %s", async state => {
  const f = fixture({ ok: false, sent: false, error: busyError });
  const id = await f.stage();
  f.queue().claim({ qitemId: id, destinationSession: destination });
  if (state === "terminal") f.queue().update({ qitemId: id, actorSession: destination, state: "done", closureReason: "no-follow-on" });
  f.outcome({ ok: true, verified: true });
  await f.observe("idle");
  expect(f.send).toHaveBeenCalledOnce();
});

it.each([
  { ok: false, sent: true, reason: "wait_for_idle_timeout", error: busyError },
  { ok: false, sent: false, inputPhase: "attempted", reason: "wait_for_idle_timeout", error: busyError },
  { ok: false, reason: "timeout", error: "render acknowledgement timed out" },
] satisfies SendResult[])("never retries uncertain input as an unsent busy wake: %j", async outcome => {
  const f = fixture(outcome); const id = await f.stage();
  expect(f.wake(id).deliveryState).toBe("indeterminate");
  f.outcome({ ok: true, verified: true }); await f.observe("idle");
  expect(f.send).toHaveBeenCalledOnce();
});

it("does not retry an unknown failed result or a deliberately retained wake on idle", async () => {
  for (const outcome of [
    { ok: false, sent: false, reason: "target_activity_unknown", error: "Target activity could not be determined. No text was sent." },
    { ok: true, outcome: "retained", reason: "typing_guard_enabled" },
  ] satisfies SendResult[]) {
    const f = fixture(outcome); await f.stage();
    f.outcome({ ok: true, verified: true }); await f.observe("idle");
    expect(f.send).toHaveBeenCalledOnce();
  }
});

it("retries each correlated busy member once even when admission separates it before the send", async () => {
  const f = fixture();
  const queue = f.queue();
  const blocker = await queue.create({ sourceSession: destination, destinationSession: "builder@busy-retry", body: "build", nudge: false });
  const waiter = await queue.create({ sourceSession: destination, destinationSession: destination, body: "wait for build", nudge: false });
  queue.update({ qitemId: waiter.qitemId, actorSession: destination, state: "blocked", blockedOn: blocker.qitemId });
  const returned = await queue.handoff({ qitemId: blocker.qitemId, fromSession: "builder@busy-retry", toSession: destination, body: "built" });
  const resultId = WAKE_INTENT_PREFIX + returned.created.qitemId;
  const peerId = (f.db.prepare("SELECT outbox_id FROM outbox_entries WHERE audit_pointer = ?").get(waiter.qitemId) as { outbox_id: string }).outbox_id;
  await vi.waitFor(() => {
    expect(f.outbox.getById(resultId)?.deliveryState).toBe("failed");
    expect(f.outbox.getById(peerId)?.deliveryState).toBe("failed");
  });
  const attempts: string[][] = [];
  f.send.mockImplementation(async (_target, _text, opts) => {
    attempts.push(opts?.recheckMembers
      ? opts.recheckMembers(input => input.source === "openrig", false).outboxIds
      : opts?.committedOutboxIds ?? []);
    return { ok: true, verified: true };
  });
  await f.observe("idle");
  expect(attempts).toEqual([[resultId], [peerId]]);
  expect(f.outbox.getById(resultId)?.deliveryState).toBe("delivered");
  expect(f.outbox.getById(peerId)?.deliveryState).toBe("delivered");
  await f.observe("idle");
  expect(attempts).toHaveLength(2);
});

it.each([
  { runtime: "claude-code", signal: "hook" },
  { runtime: "codex", signal: "hook" },
  { runtime: "claude-code", signal: "pane" },
])("wires $runtime $signal idle into busy-wake recovery through createDaemon", async ({ runtime, signal }) => {
  const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
  process.env.OPENRIG_NO_KERNEL = "1";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toBe("https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz");
    return new Response(null, { status: 404 });
  });
  const captures = JSON.parse(readFileSync(new URL("./fixtures/claude-permission-2.1.300.json", import.meta.url), "utf8"));
  let screen: string = captures.approvedBash;
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    daemon = await createDaemon({ dbPath: ":memory:",
      tmuxExec: async command => command.includes("capture-pane") ? screen : "", cmuxExec: async () => "" });
    const { rigRepo, sessionRegistry, queueRepo, outboxHandler, seatStructuralActivityService, activityHookToken } = daemon.deps;
    const rig = rigRepo.createRig("busy-retry");
    const node = rigRepo.addNode(rig.id, "worker", { runtime });
    const session = sessionRegistry.registerSession(node.id, destination);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: destination });
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const hook = async (hookEvent: string) => {
      const response = await daemon!.app.request("/api/activity/hooks", { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${activityHookToken}` },
        body: JSON.stringify({ runtime, hookEvent, sessionName: destination, nodeId: node.id, generation,
          occurredAt: new Date().toISOString() }) });
      expect(response.status).toBe(200);
    };
    if (signal === "hook") await hook("UserPromptSubmit");
    else await seatStructuralActivityService!.pollSeat(destination, null, runtime);
    let busy = true;
    const send = vi.fn<Send>(async () => busy
      ? { ok: false, sent: false, reason: "wait_for_idle_timeout", error: busyError }
      : { ok: true, verified: true });
    queueRepo!.attachTransport({ send });
    const row = await queueRepo!.create({ sourceSession: "planner@busy-retry", destinationSession: destination, body: "review" });
    const wakeId = WAKE_INTENT_PREFIX + row.qitemId;
    await vi.waitFor(() => expect(outboxHandler!.getById(wakeId)?.deliveryState).toBe("failed"));
    busy = false;
    if (signal === "hook") await hook("Stop");
    else {
      screen = "❯ ";
      await seatStructuralActivityService!.pollSeat(destination, null, runtime);
    }
    await vi.waitFor(() => expect(outboxHandler!.getById(wakeId)?.deliveryState).toBe("delivered"));
    expect(send).toHaveBeenCalledTimes(2);
    await hook("Stop");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    daemon?.eventLoopMonitor.stop();
    daemon?.db.close();
    fetch.mockRestore();
    if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
    else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
  }
}, 10_000);
