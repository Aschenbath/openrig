import { afterEach, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { InboundRouter, type InboundDeps, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { ThreadRecovery } from "../src/domain/gateway/slack/thread-recovery.js";
import { ThreadRecoveryStore } from "../src/domain/gateway/slack/thread-recovery-store.js";
import { SeenStore, DeadLetterStore, slackMicros, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const event = (ts: string, root = "900.1", extra: Partial<SlackEvent> = {}): SlackEvent =>
  ({ type: "message", user: "U1", channel: "C1", thread_ts: root, ts, text: `reply ${ts}`, ...extra });

function fixture(roots = ["900.1"]) {
  const files = new Map<string, string>();
  const fsops: StateFsOps = {
    readFileSync: p => { if (!files.has(p)) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return files.get(p)!; },
    writeFileSync: (p, d) => { files.set(p, d); }, appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); }, mkdirp: () => {},
  };
  const db = createFullTestDb(); cleanup.push(() => db.close());
  let down = false;
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => !down });
  const dead = new DeadLetterStore<SlackEvent>("/s/dead", fsops);
  const deps: InboundDeps = { queue: makeQueuePorts(repo), seen: new SeenStore("/s/seen", fsops), deadLetter: dead,
    destination: "owner@test", resolveSender: user => user === "U1"
      ? { admitted: true, source: "human-fixture@external" } : { admitted: false, teaching: "register" } };
  const router = new InboundRouter(deps);
  const store = new ThreadRecoveryStore("/s/threads", fsops);
  const history: SlackEvent[] = [];
  const queries: URL[] = [];
  let now = 1_000_000, pageSize = 25;
  let respond: ((url: URL) => Response | Promise<Response>) | undefined;
  const normal = (u: URL) => {
    const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
    const matches = history.filter(e => e.thread_ts === u.searchParams.get("ts") && slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest)
      .sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
    const messages = matches.slice(0, Math.min(pageSize, Number(u.searchParams.get("limit"))));
    return Response.json({ ok: true, messages, has_more: matches.length > messages.length });
  };
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = new URL(url); queries.push(u);
    expect(u.pathname).toBe("/api/conversations.replies");
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    return respond ? respond(u) : normal(u);
  };
  const recovery = (token: string | null = "fixture", channel: string | null = "C1", floor = "1000.000000") => {
    const r = new ThreadRecovery({ token, channel, stateDir: "/s", store, router, mappedRoots: () => roots, fetchImpl, now: () => now });
    r.initialize(floor); cleanup.unshift(() => r.stop()); return r;
  };
  return { files, fsops, db, repo, dead, deps, router, store, history, queries, normal, roots, recovery,
    time: (t: number) => { now = t; }, page: (n: number) => { pageSize = n; },
    respond: (fn?: typeof respond) => { respond = fn; }, down: (v: boolean) => { down = v; } };
}

it("resumes oldest-first short pages after restart without a newer live message skipping the gap", async () => {
  const f = fixture(); f.page(2); const r = f.recovery(); f.time(1_020_000);
  for (let i = 1; i <= 13; i++) f.history.push(event(`${1000 + i}.000001`));
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(8);
  expect(r.status()).toMatchObject({ state: "incomplete", pendingThreads: 1, coveredThrough: "1000.000000" });
  f.history.push(event("1050.000001")); await f.router.route(f.history.at(-1)!);
  r.stop(); f.time(1_070_000); const next = f.recovery("fixture", "C1", "1060.000000"); await next.run();
  expect(f.queries[4]!.searchParams.get("oldest")).toBe("1008.000001");
  expect(f.queries[4]!.searchParams.get("latest")).toBe("1015.000000");
  expect(f.repo.list({ limit: 100 })).toHaveLength(14);
  expect(next.status().coverageStart).toBe("1000.000000");
});

it("gives another thread a turn while a busy thread is still paginating", async () => {
  const f = fixture(["900.1", "950.1"]); f.page(1); const r = f.recovery(); f.time(1_020_000);
  for (let i = 1; i <= 10; i++) f.history.push(event(`${1000 + i}.1`));
  f.history.push(event("1001.2", "950.1")); await r.run();
  expect(f.queries.slice(0, 2).map(u => u.searchParams.get("ts"))).toEqual(["900.1", "950.1"]);
  expect(f.repo.list({ limit: 100 }).some(row => row.body.includes("reply 1001.2"))).toBe(true);
  expect(r.status().pendingThreads).toBe(1);
});

it("retains round-robin position across restart when more than four roots need scanning", async () => {
  const f = fixture(["900.1", "901.1", "902.1", "903.1", "904.1"]); const r = f.recovery(); f.time(1_020_000);
  await r.run(); expect(f.queries).toHaveLength(4); expect(r.status().pendingThreads).toBe(1); r.stop(); f.time(1_030_000);
  await f.recovery().run(); expect(f.queries[4]!.searchParams.get("ts")).toBe("904.1");
});

it("persists method-wide Retry-After across reconnects and restart without querying a different thread", async () => {
  const f = fixture(["900.1", "950.1"]); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: false }, { status: 429, headers: { "retry-after": "600" } }));
  await r.run(); expect(f.queries).toHaveLength(1);
  expect(r.status()).toMatchObject({ state: "backoff", reason: "rate-limited", nextRetryAt: 1_610_000 });
  r.stop(); const next = f.recovery(); await next.run(); f.time(1_609_999); await next.run(); expect(f.queries).toHaveLength(1);
  f.respond(); f.time(1_610_000); f.history.push(event("1001.1"), event("1002.1", "950.1")); await next.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(2); expect(next.status().reason).toBeUndefined();
});

it.each(["missing_scope", "not_allowed_token_type", "invalid_auth", "token_revoked"])("exposes %s without claiming thread coverage or stopping live inbound", async error => {
  const f = fixture(["900.1", "950.1"]); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: false, error })); await r.run();
  expect(r.status()).toMatchObject({ state: "backoff", reason: error, coveredThrough: "1000.000000" });
  expect(f.queries).toHaveLength(1);
  await f.router.route(event("1002.1")); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
});

it.each([0, 503])("retries a transient replies failure %i after five seconds while other roots continue", async status => {
  const f = fixture(["900.1", "950.1"]); const r = f.recovery(); f.time(1_010_000);
  f.history.push(event("1001.1"), event("1002.1", "950.1"));
  f.respond(u => {
    if (u.searchParams.get("ts") !== "900.1") return f.normal(u);
    if (!status) throw new Error("offline");
    return Response.json({ ok: false }, { status });
  });
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  expect(r.status().nextRetryAt).toBe(1_015_000);
  const failedCalls = f.queries.filter(u => u.searchParams.get("ts") === "900.1").length;
  f.time(1_014_999); await r.run();
  expect(f.queries.filter(u => u.searchParams.get("ts") === "900.1")).toHaveLength(failedCalls);
  f.time(1_015_000); f.respond(); await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

it("keeps an inaccessible or deleted thread visible without starving the next thread", async () => {
  const f = fixture(["900.1", "950.1"]); const r = f.recovery(); f.time(1_010_000); f.history.push(event("1001.1", "950.1"));
  f.respond(u => u.searchParams.get("ts") === "900.1" ? Response.json({ ok: false, error: "thread_not_found" }) : f.normal(u));
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  expect(r.status()).toMatchObject({ state: "backoff", reason: "thread_not_found", failedThreads: 1, coveredThrough: "1000.000000" });
});

it.each([
  { messages: [], has_more: true },
  { messages: [{ ts: "900.1" }], has_more: true },
  { messages: [event("1001.1")] },
  { messages: [event("999.1")], has_more: false },
  { messages: [event("1005.000000")], has_more: false },
  { messages: [{ text: "missing timestamp" }], has_more: false },
  { messages: [event("1001.1", "another-thread")], has_more: false },
  { messages: [event("1001.1", "900.1", { channel: "C2" })], has_more: false },
  { messages: [event("1001.1")], response_metadata: { next_cursor: 123 } },
  { messages: [event("1002.1"), event("1001.1")], has_more: true },
])("retains the interval on malformed or nonprogressing replies: %j", async page => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000); f.respond(() => Response.json({ ok: true, ...page }));
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(0);
  expect(r.status()).toMatchObject({ state: "backoff", coveredThrough: "1000.000000", pendingThreads: 1 });
});

it("skips a parent outside the time window and honors cursor-only continuation using reply timestamps", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(u => {
    const first = u.searchParams.get("oldest") === "999.999999";
    return Response.json({ ok: true, messages: [{ ts: "900.1", type: "message", user: "U1", text: "parent" }, event(first ? "1001.1" : "1002.1")],
      response_metadata: { next_cursor: first ? "next-page" : "" } });
  });
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
  expect(f.queries[1]!.searchParams.get("oldest")).toBe("1001.1");
  expect(f.repo.list({ limit: 100 }).every(row => !row.body.includes("parent"))).toBe(true);
});

it("discovers live roots without advancing their checkpoints and excludes other channels and edits", async () => {
  const f = fixture([]); const r = f.recovery();
  r.observe(event("1001.1")); r.observe(event("1100.1"));
  r.observe(event("1001.2", "950.1", { channel: "C2" }));
  r.observe(event("1001.3", "960.1", { subtype: "message_changed" }));
  r.observe(event("1001.4", "2000.1"));
  expect(r.status()).toMatchObject({ trackedThreads: 1, coveredThrough: "1000.000000" });
  f.time(1_010_000); f.history.push(event("1001.1")); await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  r.stop(); expect(f.recovery().status().trackedThreads).toBe(1);
});

it("keeps a root discovered during an in-flight page when that page commits", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.respond(u => u.searchParams.get("ts") === "900.1" ? new Promise(resolve => { entered(); release = () => resolve(f.normal(u)); }) : f.normal(u));
  const pass = r.run(); await started;
  r.observe(event("1002.1", "1001.1")); f.history.push(event("1002.1", "1001.1")); release(); await pass;
  expect(r.status().trackedThreads).toBe(2); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  r.stop(); expect(f.recovery().status().trackedThreads).toBe(2);
});

it("retains a page while its live duplicate is in flight, then recovers its failed owner's dead letter", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  let release!: () => void;
  f.deps.files = { transfer: () => new Promise(resolve => { release = () => resolve({ stored: [], failed: [] }); }) };
  const ev = event("1001.1", "900.1", { files: [{}] }); f.history.push(ev);
  const live = f.router.route(ev); await r.run();
  expect(r.status()).toMatchObject({ reason: "landing-in-progress", coveredThrough: "1000.000000" });
  f.down(true); release(); await live; expect(f.dead.readAll()).toHaveLength(1);
  f.deps.files = undefined; f.down(false); f.time(1_015_000); await r.run(); await f.router.retryDeadLetters();
  expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(f.dead.readAll()).toHaveLength(0);
});

it("advances after durable dead-letter custody while preserving the original thread for retry", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000); f.down(true); f.history.push(event("1001.1"));
  await r.run(); expect(r.status()).toMatchObject({ deadLetteredThisProcess: 1, coveredThrough: "1005.000000" });
  expect(f.dead.readAll()[0]!.ev).toMatchObject({ thread_ts: "900.1", recoveredAfterGap: true });
  f.down(false); await f.router.retryDeadLetters(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
});

it.each(["seen", "dead", "checkpoint"])("keeps failed %s writes replayable across restart", async failure => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000); f.history.push(event("1001.1"));
  const append = f.fsops.appendFileSync, rename = f.fsops.rename;
  if (failure === "dead") f.down(true);
  f.fsops.appendFileSync = (p, d) => { if (p.endsWith(`/${failure}`)) throw new Error("disk"); append(p, d); };
  let writes = 0;
  f.fsops.rename = (a, b) => { if (failure === "checkpoint" && ++writes === 2) throw new Error("disk"); rename(a, b); };
  await r.run(); expect(r.status().coveredThrough).toBe("1000.000000");
  f.fsops.appendFileSync = append; f.fsops.rename = rename; f.down(false); r.stop();
  const next = f.recovery(); await next.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  expect(next.status().coveredThrough).toBe("1005.000000");
});

it.each(["fetch", "attachment"])("fences a stopped worker during %s I/O, and the next owner resumes", async boundary => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.history.push(event("1001.1", "900.1", boundary === "attachment" ? { files: [{}] } : {}));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  if (boundary === "fetch") f.respond(u => new Promise(resolve => { entered(); release = () => resolve(f.normal(u)); }));
  else f.deps.files = { transfer: () => new Promise(resolve => { entered(); release = () => resolve({ stored: [], failed: [] }); }) };
  const pass = r.run(); expect(r.run()).toBe(pass); await started; r.stop(); release(); await pass;
  expect(f.repo.list({ limit: 100 })).toHaveLength(0); expect(r.status()).toMatchObject({ state: "stopped", coveredThrough: "1000.000000" });
  f.respond(); f.deps.files = undefined; await f.recovery().run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
});

it("yields between entries when attachment work exceeds the pass budget, preserving replay", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.history.push(event("1001.1", "900.1", { files: [{}] }), event("1002.1"));
  f.deps.files = { transfer: async () => { f.time(1_030_000); return { stored: [], failed: [] }; } };
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(r.status().reason).toBe("pass-budget");
  r.stop(); f.deps.files = undefined; await f.recovery().run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

it("retains sender and subtype checks, attachment failures, and exact microsecond interval boundaries", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_006_000);
  f.history.push(event("1000.000000"), event("1000.000001", "900.1", { bot_id: "B1" }),
    event("1000.000002", "900.1", { user: "unknown" }), event("1000.000003", "900.1", { subtype: "message_changed" }),
    event("1000.000004", "900.1", { subtype: "file_share", text: "", files: [{ name: "retained.txt" }] }), event("1001.000000"));
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
  expect(f.repo.list({ limit: 100 }).map(row => row.body).join("\n")).toContain("FILE TRANSFER FAILED: retained.txt");
  f.time(1_007_000); await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(3);
});

it("retains plan limitations after restart and reads status from memory only", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: true, messages: [event("1001.1")], has_more: false, is_limited: true }));
  await r.run(); r.stop(); const next = f.recovery();
  const calls = f.queries.length; f.fsops.readFileSync = () => { throw new Error("must not read"); };
  expect(next.status().limits.join(" ")).toContain("Slack plan limit"); expect(f.queries).toHaveLength(calls);
});

it("reports a newly discovered older root as pending after the previous inventory was scanned", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000); await r.run();
  expect(r.status().state).toBe("scanned");
  r.observe(event("1002.1", "950.1"));
  expect(r.status()).toMatchObject({ state: "pending", trackedThreads: 2, pendingThreads: 1 });
});

it("does not replace corrupt or unreadable thread state or call Slack without credentials", async () => {
  const f = fixture(); f.files.set("/s/threads", "broken"); const r = f.recovery(); await r.run();
  expect(r.status().state).toBe("unavailable"); expect(f.files.get("/s/threads")).toBe("broken"); expect(f.queries).toHaveLength(0);
  f.fsops.readFileSync = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  expect(f.recovery().status().state).toBe("unavailable");
  const g = fixture(); const absent = g.recovery(null); await absent.run(); expect(absent.status().reason).toBe("bot-token-unresolved"); expect(g.queries).toHaveLength(0);
});
