import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewaySubsystem } from "../src/domain/gateway/gateway-subsystem.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore, slackMicros } from "../src/domain/gateway/slack/state-store.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(state: "open" | "closed" | "superseded" | "unmapped", history: SlackEvent[] = []) {
  vi.useFakeTimers();
  vi.setSystemTime(1_010_000);
  const home = mkdtempSync(join(tmpdir(), "slack-thread-recovery-"));
  const db = createFullTestDb();
  cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const queueRepo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C1", inboundDestination: "owner@test" }, home);
  vi.stubEnv("SLACK_BOT_TOKEN", "fixture-bot");
  vi.stubEnv("SLACK_APP_TOKEN", "fixture-app");
  new SeenStore(join(home, "state", "slack-inbound-seen.jsonl")).mark("C1:1000.000001", "landed");
  const map = new ThreadSeatMap(db);
  const root = state === "unmapped" ? "1001.000001" : "900.000001";
  if (state !== "unmapped") {
    map.open({ threadTs: root, channel: "C1", human: "human-fixture@external", seat: "asker@test", conversationId: "q-original" });
    if (state === "closed") map.close(root);
    if (state === "superseded") map.open({ threadTs: "950.000001", channel: "C1", human: "human-fixture@external", seat: "asker@test", conversationId: "q-original" });
  }
  const reply: SlackEvent = { type: "message", user: "U1", text: "the reply sent during the gap", ts: "1002.000001", thread_ts: root };
  const calls: URL[] = [];
  const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null };
  const subsystem = new GatewaySubsystem({ home, wire: () => buildSlackGatewayWire({ home, queueRepo, inboundRetryIntervalMs: 100,
    registry: { loadHumanRegistry: () => ({ ok: true, entities: [] }), resolveSlackHandle: () => ({ kind: "registered", address: "human-fixture@external", entityId: "fixture" }) } as never,
    fetchImpl: async url => {
      const u = new URL(url); calls.push(u);
      if (u.pathname.endsWith("apps.connections.open")) return Response.json({ ok: true, url: "wss://fixture" });
      const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
      const messages = u.pathname.endsWith("conversations.history") ? history
        : u.pathname.endsWith("conversations.replies") && u.searchParams.get("ts") === root ? [reply] : [];
      return Response.json({ ok: true, messages: messages.filter(m => slackMicros(m.ts)! > oldest && slackMicros(m.ts)! < latest), has_more: false });
    }, wsFactory: () => ws,
  }) });
  cleanup.unshift(() => subsystem.stop());
  subsystem.start(); subsystem.startServices();
  await vi.advanceTimersByTimeAsync(0);
  ws.onopen?.();
  await vi.advanceTimersByTimeAsync(0);
  return { home, queueRepo, calls, subsystem, ws, reply };
}

it.each(["open", "closed", "superseded"] as const)("recovers an ordinary reply to a %s mapped thread through the real gateway and queue", async state => {
  const f = await fixture(state);
  const rows = f.queueRepo.list({ limit: 100 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ destinationSession: "asker@test", sourceSession: "human-fixture@external" });
  expect(rows[0]!.body).toContain("Recovered after a gap");
  expect(rows[0]!.body).toContain("the reply sent during the gap");
  expect(rows[0]!.body.includes("In reply to: q-original")).toBe(state !== "superseded");
  f.ws.onmessage?.({ data: JSON.stringify({ type: "events_api", envelope_id: "live-duplicate", payload: { event: { ...f.reply, channel: "C1" } } }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.queueRepo.list({ limit: 100 })).toHaveLength(1);
});

it("discovers a human-started root in channel recovery and recovers its ordinary reply", async () => {
  const f = await fixture("unmapped", [{ type: "message", user: "U1", ts: "1001.000001", text: "a new conversation" }]);
  const rows = f.queueRepo.list({ limit: 100 });
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.destinationSession === "owner@test")).toBe(true);
  expect(rows.map(row => row.body).join("\n")).toContain("the reply sent during the gap");
});

it("retains top-level channel recovery while no ordinary reply is due", async () => {
  const f = await fixture("unmapped", [{ type: "message", user: "U1", ts: "1003.000001", text: "a different root" }]);
  expect(f.queueRepo.list({ limit: 100 })).toHaveLength(1);
  expect(f.queueRepo.list({ limit: 100 })[0]!.body).toContain("a different root");
});

it("discovers a live reply's previously unknown root and catches older replies on the periodic pass", async () => {
  const f = await fixture("unmapped");
  expect(f.queueRepo.list({ limit: 100 })).toHaveLength(0);
  let rootsWhenAcknowledged: string[] | undefined;
  f.ws.send = () => {
    rootsWhenAcknowledged = Object.keys(JSON.parse(readFileSync(join(f.home, "state", "slack-thread-coverage.json"), "utf8")).C1.threads);
  };
  f.ws.onmessage?.({ data: JSON.stringify({ type: "events_api", envelope_id: "new-root", payload: {
    event: { ...f.reply, ts: "1003.000001", text: "a newer live reply", channel: "C1" },
  } }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(rootsWhenAcknowledged).toEqual([]); // ACK precedes new durable tracking work.
  expect(f.queueRepo.list({ limit: 100 })).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.queueRepo.list({ limit: 100 })).toHaveLength(2);
  expect(f.queueRepo.list({ limit: 100 }).map(row => row.body).join("\n")).toContain("the reply sent during the gap");
});

it("remembers a bot root from channel history while admitting only the person's reply", async () => {
  const f = await fixture("unmapped", [{ type: "message", bot_id: "B1", ts: "1001.000001", text: "the bot's question" }]);
  const rows = f.queueRepo.list({ limit: 100 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.body).toContain("the reply sent during the gap");
  expect(rows[0]!.sourceSession).toBe("human-fixture@external");
});
