import Database from "better-sqlite3";
import { Hono } from "hono";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-input.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts } from "../src/domain/session-transport.js";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

function signal() {
  let release!: () => void;
  return { ready: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

function fixture(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal'),('b','rig','sibling','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  const bodies: Record<string, string | null> = { a: "", b: "" };
  const history: Record<string, string> = { a: "", b: "" };
  const writes: string[] = [], submissions: string[] = [];
  const hooks: { load?: () => void | Promise<void>; paste?: () => void | Promise<void>; sleep?: (ms: number) => void | Promise<void> } = {};
  let staged = "";
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("load-buffer")) await hooks.load?.();
    const node = command.includes("%2") ? "b" : "a";
    if (command.includes("paste-buffer")) {
      await hooks.paste?.();
      writes.push(`paste:${node}:${staged}`); bodies[node] = staged;
    }
    if (command.includes("send-keys")) {
      writes.push(`keys:${node}:${command}`);
      if (command.includes("Enter")) {
        submissions.push(bodies[node] ?? ""); history[node] += `${bodies[node]}\n`; bodies[node] = "";
      }
    }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async name => {
    const body = bodies[guard.target(name).nodeId]; return body == null ? null : frame(body);
  });
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async name => {
    const node = guard.target(name).nodeId; return bodies[node] == null ? null : history[node] + frame(bodies[node]!).screen;
  });
  let at = Date.now();
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), outbox = new OutboxHandler(db);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo, sessionRegistry, now: () => new Date(at), sleep: async ms => { await hooks.sleep?.(ms); } });
  const deferred = transport.deferredDelivery!;
  const repo = new QueueRepository(db, new EventBus(db), { transport, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, rigRepo);
    c.set("sessionTransport" as never, transport); c.set("outboxHandler" as never, outbox); await next();
  });
  app.route("/api/seat", seatRoutes); app.route("/api/transport", transportRoutes());
  cleanup.push(async () => { await deferred.stop(); db.close(); });
  return { db, guard, tmux, transport, deferred, outbox, repo, app, bodies, history, writes, submissions, hooks,
    advance: (ms = 4000) => { at += ms; },
    enable: (settings = {}) => guard.setPolicy("a", { mode: "draft-aware", holdSeconds: 12, maxAttempts: 3, ...settings }, "human@test", "keep draft"),
    send: (id: string, text = "incoming message", opts: SendOpts = {}) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: true, ...opts }),
    post: (path: string, body: unknown, actor = "human@test") => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": actor }, body: JSON.stringify(body) }),
  };
}

describe("durable draft-aware delivery through the real transport", () => {
  it("retries the same message until its draft clears, without duplicate paste, Enter or outbox rows", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "unfinished human request";
    expect(await f.send("one")).toMatchObject({ outcome: "retained", sent: false, outboxIds: ["one"], delivery: { state: "waiting", attempts: 1 } });
    expect(await f.send("one")).toMatchObject({ delivery: { attempts: 1 } });
    f.advance(); await f.deferred.drain();
    expect(f.deferred.lookup("one")).toMatchObject({ state: "waiting", attempts: 2 });
    expect(f.writes).toEqual([]);
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.deferred.readback("one")).toMatchObject({ ok: true, sent: true, verified: true, delivery: { state: "complete", attempts: 3 } });
    expect(f.submissions).toEqual(["incoming message"]);
    expect(f.outbox.getById("one")).toMatchObject({ body: "incoming message", deliveryState: "delivered" });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 1 });
    await f.guard.setPolicy("a", { mode: "automatic" }, "human@test", "normal delivery");
    expect(await f.send("one")).toMatchObject({ delivery: { state: "complete", attempts: 3 } });
    expect(f.submissions).toHaveLength(1);
    expect(await f.send("one", "different message")).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
    expect(await f.send("one", "incoming message", { actorSession: "other@test" })).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
  });

  it.each(["draft", "unknown", "expired"])("retains at the hold bound without typing a final warning (%s)", async condition => {
    const f = fixture(); await f.enable(); f.bodies.a = condition === "unknown" ? null : "human draft";
    await f.send("bounded");
    if (condition === "expired") { f.advance(12000); await f.deferred.drain(); }
    else { f.advance(); await f.deferred.drain(); f.advance(); await f.deferred.drain(); }
    expect(f.deferred.lookup("bounded")).toMatchObject({ state: "held", reason: "hold_limit_reached", attempts: condition === "expired" ? 1 : 3, nextAttemptAt: null });
    f.bodies.a = ""; f.advance(60000); await f.deferred.drain();
    expect(f.writes).toEqual([]);
    expect(f.outbox.getById("bounded")).toMatchObject({ deliveryState: "retained", deliveredAt: null });
  });

  it("recovers a waiting request from persisted SQLite with the original deadline and ID", async () => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("restart");
    const before = first.deferred.lookup("restart");
    const resumed = fixture(first.db.serialize()); resumed.deferred.recover(); resumed.advance(5000);
    await resumed.deferred.drain();
    expect(resumed.deferred.lookup("restart")).toMatchObject({ id: "restart", deadlineAt: before!.deadlineAt, state: "complete", attempts: 2 });
    expect(resumed.submissions).toEqual(["incoming message"]);
  });

  it("never replays an attempt interrupted between its durable claim and its write result", async () => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("crash");
    first.db.exec("UPDATE seat_deferred_messages SET state='sending'; UPDATE outbox_entries SET delivery_state='sending';");
    const resumed = fixture(first.db.serialize()); resumed.deferred.recover(); resumed.advance(5000);
    await resumed.deferred.drain();
    expect(resumed.deferred.readback("crash")).toMatchObject({ ok: false, reason: "delivery_indeterminate", delivery: { state: "indeterminate", reason: "interrupted_write" } });
    expect(resumed.outbox.getById("crash")!.deliveryState).toBe("indeterminate"); expect(resumed.writes).toEqual([]);
  });

  it("serializes concurrent drains and gives in-flight readback without a second input", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; await f.send("racing");
    f.bodies.a = ""; f.advance(); const entered = signal(), release = signal();
    f.hooks.load = async () => { entered.release(); await release.ready; };
    const a = f.deferred.drain(), b = f.deferred.drain(); await entered.ready;
    expect(await f.send("racing")).toMatchObject({ ok: false, reason: "delivery_in_progress", delivery: { attempts: 2 } });
    release.release(); await Promise.all([a, b]);
    expect(f.submissions).toHaveLength(1); expect(f.deferred.lookup("racing")!.attempts).toBe(2);
  });

  it("shutdown waits for an initial send already writing", async () => {
    const f = fixture(); await f.enable(); const entered = signal(), release = signal();
    f.hooks.paste = async () => { entered.release(); await release.ready; };
    const sending = f.send("shutdown"); await entered.ready;
    let stopped = false; const stopping = f.deferred.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release.release(); await Promise.all([sending, stopping]);
    expect(f.deferred.lookup("shutdown")!.state).toBe("complete"); expect(f.submissions).toHaveLength(1);
  });

  it.each(["retired", "policy", "manual", "recipient", "body"])("stops an old request after %s changes", async change => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; await f.send("old");
    if (change === "retired") f.outbox.retire("old", "human@test", "read elsewhere");
    if (change === "policy") {
      await f.guard.setPolicy("a", { mode: "automatic" }, "human@test", "new mode"); await f.enable();
    }
    if (change === "manual") { await f.guard.set("a", true, "human@test", "pause"); await f.guard.set("a", false, "human@test", "new sends"); }
    if (change === "recipient") f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('new','a',2,'new-generation','fresh');");
    if (change === "body") f.db.exec("UPDATE outbox_entries SET body='replacement content' WHERE outbox_id='old';");
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.deferred.lookup("old")!.state).toBe("held"); expect(f.writes).toEqual([]);
  });

  it("leaves late human input visible and never retries an already-pasted message", async () => {
    const f = fixture(); await f.enable();
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
    const result = await f.send("late");
    expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
    expect(f.bodies.a).toBe("incoming message plus a human draft");
    f.advance(); await f.deferred.drain(); expect(f.writes).toHaveLength(1); expect(f.submissions).toEqual([]);
  });

  it("does not retry an unknown native paste result or claim no write", async () => {
    const f = fixture(); await f.enable(); f.hooks.paste = () => { throw new Error("lost native result after dispatch"); };
    expect(await f.send("unknown-write")).toMatchObject({ ok: false, delivery: { state: "indeterminate" } });
    expect(f.deferred.readback("unknown-write")!.sent).toBeUndefined();
    f.advance(); await f.deferred.drain(); expect(f.deferred.lookup("unknown-write")!.attempts).toBe(1);
  });

  it("never serializes a live prerequisite for later replay", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; const beforeWrite = vi.fn();
    expect(await f.send("live", "message", { beforeWrite })).toMatchObject({ outcome: "retained", delivery: { state: "held", reason: "live_prerequisite_unavailable" } });
    const calls = beforeWrite.mock.calls.length;
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(beforeWrite).toHaveBeenCalledTimes(calls); expect(f.writes).toEqual([]);
  });

  it("a failed final ledger update cannot report no input or authorize replay", async () => {
    const f = fixture(); await f.enable();
    const finalize = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementationOnce(() => { throw new Error("transient ledger failure"); });
    try {
      const result = await f.send("ledger-failure");
      expect(result).toMatchObject({ ok: false, reason: "delivery_indeterminate", delivery: { state: "indeterminate" } });
      expect(result.sent).toBeUndefined(); expect(f.submissions).toEqual(["incoming message"]);
      f.advance(); await f.deferred.drain(); expect(f.submissions).toHaveLength(1);
    } finally { finalize.mockRestore(); }
  });
});

describe("supported seat and queue integration", () => {
  it("exposes policy, audit identity, held-message progress and retirement through HTTP", async () => {
    const f = fixture(); f.bodies.a = "draft";
    const policy = await f.post("/api/seat/set-delivery-policy/worker@test", { mode: "draft-aware", holdSeconds: 12, maxAttempts: 3, actor: "spoof", reason: "draft" });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ desired: { mode: "draft-aware" }, effective: { mode: "draft-aware" }, pending: false });
    expect(f.db.prepare("SELECT actor FROM seat_delivery_policies").get()).toEqual({ actor: "human@test" });
    const response = await f.post("/api/transport/send", { session: "worker@test", text: "http message", deliveryId: "http", actorSession: "spoof", verify: true });
    expect(await response.json()).toMatchObject({ outcome: "retained", outboxIds: ["http"], delivery: { state: "waiting" } });
    const page = await (await f.app.request("/api/seat/held-messages/worker@test")).json();
    expect(page.items[0]).toMatchObject({ senderSession: "human@test", body: "http message", delivery: { attempts: 1, maxAttempts: 3 } });
    expect(f.db.prepare("SELECT identity_provenance FROM outbox_entries").get()).toEqual({ identity_provenance: "transport:v1" });
    expect(await (await f.app.request("/api/seat/delivery-policy/worker@test")).json()).toMatchObject({ deliveries: [{ id: "http", state: "waiting" }] });
    expect((await f.post("/api/seat/retire-held-message/sibling@test/http", { reason: "read" })).status).toBe(404);
    expect((await f.post("/api/seat/retire-held-message/worker@test/http", { reason: "read" })).status).toBe(200);
    expect(await (await f.app.request("/api/seat/held-messages/worker@test?id=http")).json()).toMatchObject({ entry: { deliveryState: "retired" }, delivery: { state: "held", reason: "message_retired" } });
    f.bodies.a = ""; f.advance(); await f.deferred.drain(); expect(f.writes).toEqual([]);
  });

  it("returns a successful HTTP delivery once, preserving its single original audit row", async () => {
    const f = fixture(); await f.enable();
    const send = () => f.post("/api/transport/send", { session: "worker@test", text: "http success", deliveryId: "http-success", verify: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true, outboxIds: ["http-success"] });
    expect(await (await send()).json()).toMatchObject({ delivery: { state: "complete", attempts: 1 } });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 1 }); expect(f.submissions).toEqual(["http success"]);
  });

  it("broadcast keeps one record per recipient when draft-aware delivery succeeds", async () => {
    const f = fixture(); await f.enable();
    const result = await f.post("/api/transport/broadcast", { sessions: ["worker@test", "sibling@test"], text: "broadcast message", verify: true });
    expect(await result.json()).toMatchObject({ sent: 2, failed: 0 });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
    expect(f.submissions).toEqual(["broadcast message", "broadcast message"]);
  });

  it("validates policy settings and ignores any body-supplied sender identity", async () => {
    const f = fixture();
    for (const body of [{ mode: "typo", reason: "draft" }, { mode: "draft-aware", maxAttempts: 0, reason: "draft" }, { mode: "inbox-only" }]) {
      expect((await f.post("/api/seat/set-delivery-policy/worker@test", body)).status).toBe(400);
    }
    expect((await f.post("/api/seat/set-delivery-policy/worker@test", { mode: "inbox-only", reason: "draft", actor: "spoof" }, "")).status).toBe(400);
    expect(f.guard.policies.get("a").effective.mode).toBe("automatic");
  });

  it("inbox-only retains indefinitely while the sibling still receives automatic messages", async () => {
    const f = fixture(); await f.guard.setPolicy("a", { mode: "inbox-only" }, "human@test", "manual terminal");
    expect(await f.send("inbox")).toMatchObject({ outcome: "retained", reason: "inbox_only" });
    expect(await f.transport.send("sibling@test", "sibling message", { verify: true })).toMatchObject({ ok: true });
    f.advance(60000); await f.deferred.drain();
    expect(f.submissions).toEqual(["sibling message"]); expect(f.deferred.lookup("inbox")).toBeNull();
    await f.enable(); expect(await f.send("inbox")).toMatchObject({ outcome: "retained" }); expect(f.submissions).toHaveLength(1);
  });

  it("the real queue wake retries after draft clearance and records the delayed outcome", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const id = `wake-intent-${item.qitemId}`;
    expect(f.deferred.lookup(id)).toMatchObject({ state: "waiting", attempts: 1 });
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.outbox.getById(id)!.deliveryState).toBe("delivered");
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("verified");
    expect(f.submissions).toHaveLength(1); expect(f.repo.getById(item.qitemId)!.state).toBe("pending");
  });

  it.each(["before-retry", "before-paste"])("rechecks queue closure %s without sending a stale wake", async timing => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    const id = `wake-intent-${item.qitemId}`;
    await vi.waitFor(() => expect(f.deferred.lookup(id)?.state).toBe("waiting"));
    const close = () => f.repo.update({ qitemId: item.qitemId, actorSession: "worker@test", state: "done", closureReason: "no-follow-on", transitionNote: "completed outside terminal" });
    if (timing === "before-retry") close(); else f.hooks.load = () => { close(); };
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.deferred.lookup(id)!.state).toBe("held"); expect(f.writes).toEqual([]);
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
  });

  it("rejects an obsolete blocker-resume epoch even if the same item is pending again", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "resume work", nudge: false });
    const log = new QueueTransitionLog(f.db);
    const transition = f.repo.listTransitions(item.qitemId).at(-1)!;
    const id = `wake-intent-blocker-${transition.transitionId}`;
    f.outbox.record({ outboxId: id, senderSession: "sender@test", destinationSession: "worker@test", body: "old resume", auditPointer: item.qitemId });
    await f.transport.send("worker@test", "old resume", { committedOutboxIds: [id], actorSession: "sender@test", queueWake: true });
    log.append({ qitemId: item.qitemId, state: "blocked", actorSession: "worker@test" });
    log.append({ qitemId: item.qitemId, state: "pending", actorSession: "worker@test" });
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.deferred.lookup(id)).toMatchObject({ state: "held", reason: "wake_no_longer_applicable" }); expect(f.writes).toEqual([]);
  });

  it("coalesced wakes keep every original ID/body and expose the same progress through each member", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: `work ${i}`, nudge: false });
      f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
      const id = `wake-intent-${item.qitemId}`; ids.push(id);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify(["queue:return:common"]), id);
    }
    const original = ids.map(id => f.outbox.getById(id)!.body);
    await f.repo.drainPendingWakeIntents();
    expect(f.deferred.lookup(ids[1]!)).toEqual(f.deferred.lookup(ids[0]!));
    expect(f.db.prepare("SELECT count(*) n FROM seat_deferred_messages").get()).toEqual({ n: 1 });
    f.bodies.a = ""; f.advance(); await f.deferred.drain();
    expect(f.submissions).toHaveLength(1);
    ids.forEach((id, i) => expect(f.outbox.getById(id)).toMatchObject({ body: original[i], deliveryState: "delivered" }));
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
  });
});
