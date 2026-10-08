// OPR.0.3.4.11 — CLI rig launch --seats tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { launchCommand } from "../src/commands/launch.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockClient(responses: Record<string, { status: number; data: unknown }>) {
  return {
    post: vi.fn(async (url: string, body: unknown) => {
      for (const [pattern, resp] of Object.entries(responses)) {
        if (url.includes(pattern)) return resp;
      }
      return { status: 404, data: { ok: false, error: "not found" } };
    }),
    get: vi.fn(async () => ({ status: 200, data: {} })),
  };
}

function makeDeps(clientResponses: Record<string, { status: number; data: unknown }>) {
  const client = mockClient(clientResponses);
  return {
    lifecycleDeps: {
      spawn: vi.fn(),
      fetch: vi.fn(async () => ({ ok: true })),
      kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(),
      removeFile: vi.fn(),
      exists: vi.fn(() => true),
      mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 1),
      isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
    _client: client,
  };
}

describe("rig launch --seats", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    // OPR.0.4.3.28 — non-blocking launch warnings print via console.warn (stderr).
    vi.spyOn(console, "warn").mockImplementation((...args) => { errors.push(args.join(" ")); });
    process.exitCode = undefined;
  });

  it("posts to launch-subset with seats array and holdReason", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [
            { nodeId: "n1", logicalId: "dev.driver", status: "fresh" },
            { nodeId: "n2", logicalId: "dev.guard", status: "fresh" },
          ],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard", "--hold-reason", "codex auth expired"]);

    expect(deps._client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/nodes/launch-subset",
      { seats: ["dev.driver", "dev.guard"], holdReason: "codex auth expired" },
    );
    expect(logs.some((l) => l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("dev.guard"))).toBe(true);
  });

  it("posts an explicit original member retry to the existing single-node route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "first-start-cli-"));
    const fragment = join(directory, "member.yaml");
    writeFileSync(fragment, "member:\n  id: pi\n  runtime: pi\n  agent_ref: local:agent\n  profile: default\n  cwd: /project\n");
    const deps = makeDeps({ "dev.pi/launch": { status: 201, data: { ok: true, nodeId: "same-node", logicalId: "dev.pi", status: "launched" } } });
    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "dev.pi", "--retry-startup-from", fragment, "--rig-root", directory]);
    expect(deps._client.post).toHaveBeenCalledWith("/api/rigs/rig-1/nodes/dev.pi/launch", {
      retryStartupFrom: { member: { id: "pi", runtime: "pi", agent_ref: "local:agent", profile: "default", cwd: "/project" }, rigRoot: directory },
    });
    expect(logs.join("\n")).toContain("Launched node dev.pi");
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["plan", "execute", "lost-response", "unsupported", "changed-plan"])("cold first start: %s, no fallback or automatic retry", async mode => {
    const directory = mkdtempSync(join(tmpdir(), "cold-start-cli-"));
    const source = join(directory, "rig.yaml");
    writeFileSync(source, "version: '0.2'\nname: cold\n");
    const deps = makeDeps({});
    const plan = { ok: true, planOnly: true, plan: { fingerprint: "a".repeat(64), model: { value: null, observation: "runtime default; concrete native model unobserved" } } };
    deps._client.post.mockImplementation(async (_url, body) => {
      const input = body as { plan: boolean; fingerprint?: string };
      if (mode === "unsupported") return { status: 404, data: { ok: false } };
      if (input.plan) return { status: 200, data: plan };
      expect(logs.map(line => JSON.parse(line))).toEqual([plan]);
      expect(input.fingerprint).toBe(plan.plan.fingerprint);
      if (mode === "lost-response") throw new Error("Response unreadable; unknown outcome");
      if (mode === "changed-plan") return { status: 409, data: { ok: false, code: "cold_start_plan_changed" } };
      return { status: 201, data: { ok: true, status: "launched" } };
    });
    try {
      await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "dev.worker", "--first-start-from", source, "--rig-root", directory, "--json", ...(mode === "plan" ? ["--plan"] : [])]);
      expect(deps._client.post).toHaveBeenCalledTimes(mode === "plan" || mode === "unsupported" ? 1 : 2);
      expect(deps._client.post.mock.calls.every(([url]) => url.endsWith("/launch/first-start"))).toBe(true);
      if (["lost-response", "unsupported", "changed-plan"].includes(mode)) expect(process.exitCode).toBe(1);
      else expect(process.exitCode).toBeUndefined();
      if (mode === "lost-response") expect(errors.join("\n")).toContain("outcome unconfirmed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([["--snapshot-id", "s"], ["--seats", "dev.worker"], ["--retry-startup-from", "member.yaml"], ["--hold-reason", "reason"]])("refuses ambiguous cold options %j without a request", async (...extra) => {
    const deps = makeDeps({});
    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "dev.worker", "--first-start-from", "/absent", "--rig-root", "/project", ...extra]);
    expect(deps._client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([["--snapshot-id", "s"], ["--seats", "dev.pi"], ["--plan"], ["--hold-reason", "reason"]])("refuses ambiguous retry options %j before a request", async (...extra) => {
    const deps = makeDeps({});
    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "dev.pi", "--retry-startup-from", "/absent", "--rig-root", "/project", ...extra]);
    expect(deps._client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("keeps retry refusal nonzero and does not claim launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "first-start-cli-"));
    const fragment = join(directory, "member.json");
    writeFileSync(fragment, JSON.stringify({ id: "pi" }));
    const deps = makeDeps({ "dev.pi/launch": { status: 409, data: { ok: false, code: "first_start_retry_refused", message: "Seat is still bound" } } });
    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "dev.pi", "--retry-startup-from", fragment, "--rig-root", directory]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Seat is still bound");
    expect(logs.join("\n")).not.toContain("Launched");
  });

  it("passes --plan through and renders non-target effects without claiming launch", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 200,
        data: {
          ok: true,
          planOnly: true,
          snapshotSelection: { snapshotId: "snap-1", mode: "automatic" },
          nonTargetEffects: {
            mode: "detach_and_hold",
            reason: "operator hold",
            affected: [{ logicalId: "dev.guard", reason: "operator hold" }],
          },
        },
      },
    });

    deps._client.get.mockResolvedValue({ status: 200, data: { version: "0.6.8" } });

    await launchCommand(deps).parseAsync([
      "node", "rig", "rig-1", "--seats", "dev.driver", "--hold-reason", "operator hold", "--plan",
    ]);

    expect(deps._client.get).toHaveBeenCalledWith("/api/health-summary/version");
    expect(deps._client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/nodes/launch-subset",
      { seats: ["dev.driver"], holdReason: "operator hold", plan: true },
    );
    expect(logs.join("\n")).toContain("Plan only; no changes made.");
    expect(logs.join("\n")).toContain("dev.guard: operator hold");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["an older daemon", { status: 200, data: { version: "0.5.8" } }],
    ["a daemon without the version route", { status: 404, data: { error: "not found" } }],
    ["a daemon reporting an unknown version", { status: 200, data: { version: "unknown" } }],
  ])("refuses --plan against %s before sending anything", async (_label, versionAnswer) => {
    const deps = makeDeps({ "launch-subset": { status: 201, data: { ok: true, launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }] } } });
    deps._client.get.mockResolvedValue(versionAnswer);

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--plan", "--json"]);

    expect(deps._client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("0.5.9 or later");
    expect(logs).toEqual([]);
  });

  it("allows --plan on a packaged daemon whose stamp is on /healthz while its version route says unknown", async () => {
    // Packaged 0.5.9 to 0.6.5 answer "unknown" on /api/health-summary/version; /healthz carries the semver.
    const deps = makeDeps({ "launch-subset": { status: 200, data: { ok: true, planOnly: true, nonTargetEffects: { mode: "unchanged", reason: null, affected: [] } } } });
    deps._client.get.mockImplementation(async (path: string) => path === "/healthz"
      ? { status: 200, data: { status: "ok", semver: "0.6.4-rc.1" } }
      : { status: 200, data: { version: "unknown" } });

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--plan"]);

    expect(deps._client.post).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("Plan only; no changes made.");
    expect(process.exitCode).toBeUndefined();
  });

  it("names the version-read failure when it refuses --plan locally", async () => {
    const deps = makeDeps({});
    deps._client.get.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:7433"));

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--plan"]);

    expect(deps._client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("(version read: connect ECONNREFUSED 127.0.0.1:7433)");
  });

  it("warns that the daemon may have acted when a --plan request gets a 409 launch answer", async () => {
    const deps = makeDeps({ "launch-subset": { status: 409, data: { ok: false, launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "attention_required" }] } } });
    deps._client.get.mockResolvedValue({ status: 200, data: { status: "ok", semver: "0.6.8" } });

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--plan"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("did not return a plan");
  });

  it("keeps a plan error's own message when the answer shows no action (unmatched seat)", async () => {
    const deps = makeDeps({ "launch-subset": { status: 404, data: { ok: false, code: "no_matching_nodes", error: "no seats match dev.typo" } } });
    deps._client.get.mockResolvedValue({ status: 200, data: { status: "ok", semver: "0.6.8" } });

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.typo", "--plan"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("no seats match dev.typo");
    expect(errors.join("\n")).not.toContain("may have acted");
  });

  it.each([[["--json"]], [[]]])("exits non-zero when a --plan answer has no planOnly (%j)", async (extra) => {
    // A daemon that reports a new version but launches anyway: the answer must not read as a plan.
    const launched = { ok: true, launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }], held: [], alreadyRunning: [] };
    const deps = makeDeps({ "launch-subset": { status: 201, data: launched } });
    deps._client.get.mockResolvedValue({ status: 200, data: { version: "0.6.8" } });

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver", "--plan", ...extra]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("did not return a plan");
    expect(logs.join("\n")).not.toContain("Launched");
    expect(logs.join("\n")).not.toContain("Plan only");
  });

  it("reports held and failedTargets honestly in human output", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [{ nodeId: "n2", logicalId: "dev.guard", reason: "codex auth expired" }],
          alreadyRunning: [],
          failedTargets: [{ nodeId: "n3", logicalId: "dev.reviewer", reason: "tmux_probe_error" }],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard,dev.reviewer"]);

    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("Held") && l.includes("dev.guard") && l.includes("codex auth expired"))).toBe(true);
    expect(errors.some((l) => l.includes("Failed") && l.includes("dev.reviewer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("FR-7: a --seats awaiting-decision restore is NOT printed as Launched and exits non-zero", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 409,
        data: {
          ok: false,
          launched: [
            { nodeId: "n1", logicalId: "dev.driver", status: "fresh" },
            { nodeId: "n2", logicalId: "dev.guard", status: "awaiting-decision", error: "Original session unresumable: resume requested but runtime continuity could not be verified. Re-run with --fresh dev.guard ..." },
          ],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,dev.guard"]);
    // The running seat is Launched; the awaiting-decision seat is NOT reported as launched.
    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("Launched") && l.includes("dev.guard"))).toBe(false);
    // The awaiting-decision seat is surfaced honestly on stderr + the run exits non-zero.
    expect(errors.some((l) => l.includes("dev.guard") && l.includes("awaiting-decision"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("FR-7: a single-node launch that lands awaiting-decision exits non-zero, not Launched", async () => {
    const deps = makeDeps({
      "dev.driver/launch": {
        status: 409,
        data: { ok: false, logicalId: "dev.driver", code: "awaiting-decision", status: "awaiting-decision", error: "Original session unresumable: resume requested but no token available. Re-run with --fresh dev.driver ..." },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);
    expect(logs.some((l) => l.includes("Launched node"))).toBe(false);
    expect(errors.some((l) => l.includes("--fresh"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it.each([["dev.driver"], ["--seats", "dev.driver"]])("explains a missing snapshot for launch %j", async (...args) => {
    const message = "No usable snapshot for rig rig-1";
    const deps = makeDeps({
      "/api/rigs/rig-1/nodes/": {
        status: 404,
        data: { ok: false, code: "no_usable_snapshot", message },
      },
    });

    await launchCommand(deps).parseAsync(["node", "rig", "rig-1", ...args]);

    expect(errors).toContain(message);
    expect(logs.some((line) => line.includes("Launched"))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("requires nodeRef or --seats", async () => {
    const deps = makeDeps({});
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1"]);

    expect(errors.some((l) => l.includes("--seats"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("single-target already_running prints honest message, not Launched", async () => {
    const deps = makeDeps({
      "/launch": {
        status: 200,
        data: {
          ok: true,
          rigId: "rig-1",
          nodeId: "n1",
          logicalId: "dev.driver",
          code: "already_running",
          alreadyRunning: [{ nodeId: "n1", logicalId: "dev.driver" }],
          launched: [],
          held: [],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);

    expect(logs.some((l) => l.includes("already running"))).toBe(true);
    expect(logs.some((l) => l.includes("Launched"))).toBe(false);
  });

  it("refuses a single-target hold reason because single launch leaves non-targets unchanged", async () => {
    const deps = makeDeps({});

    await launchCommand(deps).parseAsync([
      "node", "rig", "rig-1", "dev.driver", "--hold-reason", "hold everyone else",
    ]);

    expect(deps._client.post).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("single-seat launch never changes non-targets");
    expect(process.exitCode).toBe(1);
  });

  // OPR.0.4.3.28 correction — the liveness_probe_unknown warning is a non-blocking
  // proceed-with-warning: it prints on human output and does NOT set a non-zero exit.
  it("prints liveness warnings in --seats human output with exit 0 (proceed-with-warning)", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
          warnings: ["liveness_probe_unknown: launched 'dev.driver' despite a failed tmux liveness probe — verify no live seat was squatted"],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver"]);
    expect(errors.some((l) => l.includes("Warning") && l.includes("liveness_probe_unknown") && l.includes("dev.driver"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints liveness warnings in single-target human output with exit 0 (proceed-with-warning)", async () => {
    const deps = makeDeps({
      "dev.driver/launch": {
        status: 201,
        data: {
          ok: true,
          rigId: "rig-1",
          nodeId: "n1",
          logicalId: "dev.driver",
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          snapshotSelection: {
            snapshotId: "snap-manual",
            kind: "manual",
            createdAt: "2026-09-04 00:00:00",
            ageMs: 5000,
            mode: "explicit",
            rationale: "operator selected this exact restore-usable snapshot",
            newerUsableAlternative: null,
          },
          warnings: ["liveness_probe_unknown: launched 'dev.driver' despite a failed tmux liveness probe — verify no live seat was squatted"],
        },
      },
    });
    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "dev.driver"]);
    expect(logs.some((l) => l.includes("Launched node") && l.includes("dev.driver"))).toBe(true);
    expect(logs.some((l) => l.includes("snap-manual") && l.includes("manual") && l.includes("explicit"))).toBe(true);
    expect(logs.some((l) => l.includes("operator selected this exact restore-usable snapshot"))).toBe(true);
    expect(errors.some((l) => l.includes("Warning") && l.includes("liveness_probe_unknown"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports unmatchedIds in --seats mode", async () => {
    const deps = makeDeps({
      "launch-subset": {
        status: 201,
        data: {
          ok: true,
          launched: [{ nodeId: "n1", logicalId: "dev.driver", status: "fresh" }],
          held: [],
          alreadyRunning: [],
          failedTargets: [],
          unmatchedIds: ["typo.seat"],
        },
      },
    });

    const cmd = launchCommand(deps);
    await cmd.parseAsync(["node", "rig", "rig-1", "--seats", "dev.driver,typo.seat"]);

    expect(errors.some((l) => l.includes("Unmatched") && l.includes("typo.seat"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
