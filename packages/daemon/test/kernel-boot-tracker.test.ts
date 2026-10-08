// V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
//
// KernelBootTracker unit tests. Tracker is the observable state surface
// for the background kernel-boot; getStatus() projects from the tracker's
// own state machine + the sessions table for agents[]. The bootstrap
// promise is fire-and-forget; tests synthesize promises directly so the
// orchestration aspects (probe / variant pick) are out of scope here.

import { describe, expect, it, vi } from "vitest";
import { KernelBootTracker } from "../src/domain/kernel-boot-tracker.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

// A session row as the registry returns it. Each defaults to its own node (named after the session) unless
// nodeId says otherwise; rows are created in array order.
interface FakeSession {
  sessionName: string;
  runtime?: string;
  startupStatus: string;
  nodeId?: string;
}

const nodeOf = (s: FakeSession) => s.nodeId ?? s.sessionName;

function makeRigRepo(
  rigs: Array<{ id: string; name: string; archived?: boolean }>,
  sessionsByRig: Record<string, FakeSession[]> = {},
): RigRepository {
  return {
    listRigs: () => rigs,
    findRigsByName: (name: string) => rigs.filter((r) => r.name === name),
    findUnarchivedRigsByName: (name: string) => rigs.filter((r) => r.name === name && !r.archived),
    // The runtime lives on the node row: the first session row of each node supplies it here.
    getRig: (rigId: string) => ({
      rig: rigs.find((r) => r.id === rigId),
      nodes: [...new Map((sessionsByRig[rigId] ?? []).map((s) => [nodeOf(s), { id: nodeOf(s), runtime: s.runtime ?? null }])).values()],
      edges: [],
    }),
  } as unknown as RigRepository;
}

function makeSessionRegistry(sessionsByRig: Record<string, FakeSession[]>): SessionRegistry {
  return {
    getSessionsForRig: (rigId: string) => (sessionsByRig[rigId] ?? []).map((s, i) => ({
      ...s,
      nodeId: nodeOf(s),
      id: `session-${String(i).padStart(3, "0")}`,
      createdAt: `2026-10-08T00:00:${String(i).padStart(2, "0")}Z`,
    })),
  } as unknown as SessionRegistry;
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ type: string }> } {
  const emitted: Array<{ type: string }> = [];
  const bus = {
    emit: (event: { type: string }) => {
      emitted.push(event);
      return event;
    },
  } as unknown as EventBus;
  return { bus, emitted };
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe("KernelBootTracker — initial state", () => {
  it("defaults to skipped with empty agents until set otherwise", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("skipped");
    expect(status.agents).toEqual([]);
    expect(status.firstUnreadySince).toBeNull();
    expect(status.variant).toBeNull();
    tracker.stop();
  });

  it("setSkipped records the reason in detail", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    tracker.setSkipped("OPENRIG_NO_KERNEL=1");
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("skipped");
    expect(status.detail).toBe("OPENRIG_NO_KERNEL=1");
  });

  it("setAuthBlocked / setSpecMissing transition to the matching state with detail", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    tracker.setAuthBlocked("Error: ...");
    expect(tracker.getStatus().kernelState).toBe("auth_blocked");
    expect(tracker.getStatus().detail).toBe("Error: ...");

    tracker.setSpecMissing("/fake/path");
    expect(tracker.getStatus().kernelState).toBe("spec_missing");
    expect(tracker.getStatus().detail).toBe("/fake/path");
  });
});

describe("KernelBootTracker — agent readiness aggregation", () => {
  it("getStatus aggregates ready when every kernel agent reaches startup_status=ready", async () => {
    const rigId = "rig-kernel-1";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "ready" },
          { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "ready" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("ready");
    expect(status.agents).toHaveLength(3);
    expect(status.firstUnreadySince).toBeNull();
    tracker.stop();
  });

  it("getStatus aggregates partial_ready when some agents are ready and others are pending", async () => {
    const rigId = "rig-kernel-2";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "pending" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("partial_ready");
    tracker.stop();
  });

  it("getStatus stays booting while ALL agents are pending after bootstrap completes", async () => {
    const rigId = "rig-kernel-3";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "pending" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("booting");
    tracker.stop();
  });

  it("propagates startup_status from sessions table into agents[]", async () => {
    const rigId = "rig-kernel-4";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "failed" },
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "attention_required" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    const agents = tracker.getStatus().agents;
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.sessionName === "operator-agent@kernel")?.startupStatus).toBe("failed");
    expect(agents.find((a) => a.sessionName === "advisor-lead@kernel")?.startupStatus).toBe("attention_required");
    tracker.stop();
  });
});

describe("KernelBootTracker — bootstrap result transitions", () => {
  it("onBootstrapComplete with errors transitions to bootstrap_failed", async () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "failed", stages: [], errors: ["preflight: tmux missing"], warnings: [],
    } as never));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toContain("tmux missing");
    tracker.stop();
  });

  it("onBootstrapError (promise rejection) transitions to bootstrap_failed with thrown message", async () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.reject(new Error("network blip")));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("network blip");
    tracker.stop();
  });
});

describe("KernelBootTracker — degraded timer telemetry", () => {
  it("emits kernel.agent.degraded exactly once when boot stays unready past the timer", async () => {
    const { bus, emitted } = makeEventBus();
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 10,
    });
    // Promise that never resolves keeps tracker in booting state past the timer
    const blocked = new Promise<never>(() => {});
    tracker.startBooting("rig.yaml", blocked as never);
    expect(tracker.getStatus().kernelState).toBe("booting");

    await new Promise((r) => setTimeout(r, 30));
    const degraded = emitted.filter((e) => e.type === "kernel.agent.degraded");
    expect(degraded).toHaveLength(1);
    expect(tracker.getStatus().kernelState).toBe("degraded");

    // Subsequent reads should not re-emit even if checkDegraded ran again
    await new Promise((r) => setTimeout(r, 30));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(1);
    tracker.stop();
  });

  it("does NOT emit degraded when at least one agent is ready before the timer fires", async () => {
    const { bus, emitted } = makeEventBus();
    const rigId = "rig-kernel-fast";
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [{ sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" }],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 50,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("ready");

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(0);
    tracker.stop();
  });

  it("stop() cancels the degraded timer (idempotent)", async () => {
    const { bus, emitted } = makeEventBus();
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 10,
    });
    const blocked = new Promise<never>(() => {});
    tracker.startBooting("rig.yaml", blocked as never);
    tracker.stop();
    tracker.stop(); // idempotent
    await new Promise((r) => setTimeout(r, 30));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(0);
  });
});

describe("KernelBootTracker — sessionRegistry error handling", () => {
  it("getStatus returns empty agents[] when sessionRegistry throws (no 500)", () => {
    const throwingRegistry: SessionRegistry = {
      getSessionsForRig: vi.fn(() => {
        throw new Error("DB connection lost");
      }),
    } as unknown as SessionRegistry;
    const rigId = "rig-kernel-broken";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: throwingRegistry,
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    const status = tracker.getStatus();
    expect(status.agents).toEqual([]);
    expect(status.kernelState).toBe("skipped");
    tracker.stop();
  });
});

describe("KernelBootTracker — recovery after a boot failure (#1042)", () => {
  const failedBoot = () => Promise.resolve({
    runId: "t", status: "failed", stages: [], errors: ["startup gate timed out after 30s"], warnings: [],
  } as never);

  it("reports ready once every kernel seat is ready, keeping the failure as history", async () => {
    const rigId = "rig-kernel-recovered";
    const sessions: FakeSession[] = [
      { sessionName: "operator-agent@kernel", runtime: "claude-code", startupStatus: "ready" },
      { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "attention_required" },
    ];
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({ [rigId]: sessions }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }], { [rigId]: sessions }),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", failedBoot());
    await flush();
    expect(tracker.getStatus()).toMatchObject({ kernelState: "bootstrap_failed", lastBootFailure: null });

    sessions[1]!.startupStatus = "ready"; // the gate was resolved, as with `rig seat continue`
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("ready");
    expect(status.detail).toBeNull();
    expect(status.firstUnreadySince).toBeNull();
    expect(status.lastBootFailure).toMatchObject({ state: "bootstrap_failed", detail: "startup gate timed out after 30s" });
    expect(status.lastBootFailure?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    tracker.stop();
  });

  it("keeps the failure current while any kernel seat is not ready", async () => {
    const rigId = "rig-kernel-still-failed";
    const sessions: FakeSession[] = [
      { sessionName: "operator-agent@kernel", startupStatus: "ready" },
      { sessionName: "queue-worker@kernel", startupStatus: "failed" },
    ];
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({ [rigId]: sessions }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }], { [rigId]: sessions }),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", failedBoot());
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("startup gate timed out after 30s");
    expect(status.lastBootFailure).toBeNull();
    tracker.stop();
  });

  it("reports ready after a degraded boot once every seat is ready", async () => {
    const rigId = "rig-kernel-degraded";
    const sessions: FakeSession[] = [{ sessionName: "operator-agent@kernel", startupStatus: "pending" }];
    let finish!: () => void;
    const boot = new Promise((resolve) => { finish = () => resolve({ runId: "t", status: "ok", stages: [], errors: [], warnings: [] }); });
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({ [rigId]: sessions }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }], { [rigId]: sessions }),
      degradedTimeoutMs: 10,
    });
    tracker.startBooting("rig.yaml", boot as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(tracker.getStatus().kernelState).toBe("degraded");

    finish();
    await flush();
    sessions[0]!.startupStatus = "ready";
    expect(tracker.getStatus()).toMatchObject({ kernelState: "ready", lastBootFailure: { state: "degraded" } });
    tracker.stop();
  });
});

describe("KernelBootTracker — one entry per kernel seat (#1042)", () => {
  it("lists each seat once, from its newest session row, with the node's runtime, and skips archived kernels", async () => {
    const rigId = "rig-kernel-current";
    const sessions: FakeSession[] = [
      { sessionName: "operator-agent@kernel", runtime: "claude-code", startupStatus: "attention_required", nodeId: "node-operator" },
      { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "ready", nodeId: "node-queue" },
      // A relaunch or `rig seat continue` adds a newer session row for the same node.
      { sessionName: "operator-agent@kernel", startupStatus: "ready", nodeId: "node-operator" },
    ];
    const archived: FakeSession[] = [{ sessionName: "operator-agent@kernel", startupStatus: "failed", nodeId: "node-old" }];
    const byRig = { [rigId]: sessions, "rig-kernel-archived": archived };
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry(byRig),
      rigRepo: makeRigRepo([{ id: "rig-kernel-archived", name: "kernel", archived: true }, { id: rigId, name: "kernel" }], byRig),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({ runId: "t", status: "ok", stages: [], errors: [], warnings: [] } as never));
    await flush();
    const status = tracker.getStatus();
    expect(status.agents).toEqual([
      { sessionName: "operator-agent@kernel", runtime: "claude-code", startupStatus: "ready" },
      { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "ready" },
    ]);
    expect(status.kernelState).toBe("ready");
    tracker.stop();
  });
});
