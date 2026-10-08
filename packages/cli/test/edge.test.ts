import { describe, expect, it, vi } from "vitest";
import { DaemonResponseError, type DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(): LifecycleDeps {
  const state: DaemonState = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-10-08T00:00:00Z" };
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function run(client: Partial<DaemonClient>, args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client as DaemonClient };
    await createProgram({ edgeDeps: deps }).parseAsync(["node", "rig", "edge", ...args]);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  const exitCode = process.exitCode;
  process.exitCode = oldExitCode;
  return { out, err, exitCode };
}

const edge = {
  id: "edge-1",
  kind: "delegates_to",
  from: { logicalId: "orch.lead", nodeId: "node-a" },
  to: { logicalId: "dev.qa", nodeId: "node-b" },
};

describe("rig edge", () => {
  it("adds one edge and prints its receipt, the snapshot step and the rollback", async () => {
    const post = vi.fn(async () => ({ status: 201, data: { ok: true, rigId: "rig-1", outcome: "added", edge, rollback: "rig edge remove rig-1 edge-1" } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]);
    expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", { from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.out).toEqual([
      "added    delegates_to orch.lead -> dev.qa  edge edge-1",
      "         restore orders seats from the latest snapshot: run `rig snapshot rig-1` to include this edge",
      "         rollback: rig edge remove rig-1 edge-1",
    ]);
  });

  it("sends plan: true and prints the JSON receipt for a plan", async () => {
    const { id: _id, ...planned } = edge;
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "would_add", edge: planned } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to", "--plan", "--json"]);
    expect(post).toHaveBeenCalledWith("/api/rigs/rig-1/edges", { from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: true });
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: true, outcome: "would_add", edge: planned });
    expect(result.exitCode).toBeUndefined();
  });

  it("reports an edge that is already there as a success that wrote nothing", async () => {
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, rigId: "rig-1", outcome: "present", edge } }));
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to"]);
    expect(result.out).toEqual(["present  delegates_to orch.lead -> dev.qa  edge edge-1 (already there; nothing written)"]);
    expect(result.exitCode).toBeUndefined();
  });

  it("prints a refusal with its code and exits 1", async () => {
    const post = vi.fn(async () => ({ status: 400, data: { ok: false, code: "edge_cycle", message: "a delegates_to edge from dev.qa to orch.lead would make launch order cycle" } }));
    const result = await run({ post } as never, ["add", "rig-1", "dev.qa", "orch.lead", "--kind", "delegates_to"]);
    expect(result.err).toEqual(["edge_cycle: a delegates_to edge from dev.qa to orch.lead would make launch order cycle"]);
    expect(result.exitCode).toBe(1);
  });

  it("names the upgrade when the daemon predates the edge route", async () => {
    const post = vi.fn(async () => { throw new DaemonResponseError(404, "404 Not Found"); });
    const result = await run({ post } as never, ["add", "rig-1", "orch.lead", "dev.qa", "--kind", "delegates_to", "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, code: "edge_route_missing" });
    expect(result.exitCode).toBe(1);
  });

  it("removes exactly one edge by ID, and plans a removal without writing", async () => {
    const del = vi.fn(async (path: string) => ({
      status: 200,
      data: { ok: true, rigId: "rig-1", outcome: path.endsWith("?plan=1") ? "would_remove" : "removed", edge },
    }));
    const planned = await run({ delete: del } as never, ["remove", "rig-1", "edge-1", "--plan"]);
    expect(del).toHaveBeenLastCalledWith("/api/rigs/rig-1/edges/edge-1?plan=1");
    expect(planned.out[0]).toBe("plan     remove delegates_to orch.lead -> dev.qa  edge edge-1 from rig rig-1");
    const removed = await run({ delete: del } as never, ["remove", "rig-1", "edge-1"]);
    expect(del).toHaveBeenLastCalledWith("/api/rigs/rig-1/edges/edge-1");
    expect(removed.out).toEqual(["removed  delegates_to orch.lead -> dev.qa  edge edge-1"]);
    expect(removed.exitCode).toBeUndefined();
  });
});
