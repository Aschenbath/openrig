import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = "/fixture/cold-start";
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function fixture(options: { model?: string; profileModel?: string; policy?: string; runtime?: "pi" | "codex" } = {}) {
  const db = createFullTestDb();
  closers.push(() => db.close());
  const tmux = mockTmuxAdapter();
  tmux.deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
  tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const adapter: RuntimeAdapter = {
    runtime: options.runtime ?? "pi", listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 3, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async binding => {
      expect(db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(binding.nodeId)).toBeTruthy();
      return { ok: true };
    }),
  };
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: `name: worker\nversion: '1.0.0'\nprofiles:\n  default:\n    preferences:\n      effort: high\n${options.profileModel ? `      model: ${options.profileModel}\n` : ""}startup:\n  files:\n    - path: role.md\n      delivery_hint: send_text\n      required: true\n`,
    [`${root}/agent/role.md`]: "The selected role.",
    [`${root}/rig.md`]: "Rig guidance.", [`${root}/pod.md`]: "Pod guidance.",
  };
  const setup = createTestApp(db, { tmux, adapters: { [options.runtime ?? "pi"]: adapter }, podInstantiatorFsOps: {
    exists: path => path in files,
    readFile: path => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]!; },
  } });
  const yaml = `version: '0.2'\nname: cold-start\n${options.policy ? `permission_policy: ${options.policy}\n` : ""}startup:\n  files:\n    - path: rig.md\n      delivery_hint: send_text\npods:\n  - id: dev\n    label: Development\n    startup:\n      files:\n        - path: pod.md\n          delivery_hint: send_text\n    members:\n      - id: worker\n        agent_ref: local:agent\n        profile: default\n        runtime: pi\n        cwd: ${root}\n${options.model ? `        model: ${options.model}\n` : ""}      - id: sibling\n        agent_ref: builtin:terminal\n        profile: none\n        runtime: terminal\n        cwd: ${root}\n    edges:\n      - from: worker\n        to: sibling\n        kind: collaborates_with\n`;
  const source = options.runtime ? yaml.replace("runtime: pi", `runtime: ${options.runtime}`) : yaml;
  const materialized = await setup.podInstantiator.materialize(source, root);
  expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
  if (!materialized.ok) throw new Error("fixture did not materialize");
  const rigId = materialized.result.rigId;
  const node = setup.rigRepo.getRig(rigId)!.nodes.find(n => n.logicalId === "dev.worker")!;
  const request = (plan = true, fingerprint?: string, spec = source, rigRoot = root) => setup.app.request(`/api/rigs/${rigId}/nodes/${node.logicalId}/launch/first-start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rigSpecYaml: spec, rigRoot, plan, fingerprint }),
  });
  const plan = async () => {
    const response = await request();
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, planOnly: true });
    return body.plan;
  };
  return { ...setup, db, tmux, adapter, files, yaml: source, rigId, node, request, plan };
}

describe("explicit cold single-member first start", () => {
  it("plans without writes, then starts only the original node with full inherited guidance", async () => {
    const f = await fixture({ model: "provider/model", policy: "builtin:yolo" });
    const before = f.rigRepo.getRig(f.rigId)!;
    expect(f.sessionRegistry.getSessionsForRig(f.rigId)).toEqual([]);
    const ordinary = await f.app.request(`/api/rigs/${f.rigId}/nodes/${f.node.logicalId}/launch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(await ordinary.json()).toMatchObject({ ok: false, code: "no_usable_snapshot" });
    const changes = f.db.prepare("SELECT total_changes() AS n").get();
    const plan = await f.plan();
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(f.adapter.project).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ nodeId: f.node.id, model: { value: "provider/model", source: "member" }, effort: { value: "high", source: "profile" }, permissions: { rigRef: "builtin:yolo", launchPosture: "full_bypass" }, nonTargetEffects: "unchanged" });
    const response = await f.request(false, plan.fingerprint);
    expect(await response.json()).toMatchObject({ ok: true, status: "launched", plan });
    expect(response.status).toBe(201);
    const after = f.rigRepo.getRig(f.rigId)!;
    expect(after.rig).toEqual(before.rig);
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes.map(n => n.id)).toEqual(before.nodes.map(n => n.id));
    expect(after.nodes.filter(n => n.id !== f.node.id)).toEqual(before.nodes.filter(n => n.id !== f.node.id));
    expect(f.sessionRegistry.getSessionsForRig(f.rigId)).toHaveLength(1);
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0]).toMatchObject({ nodeId: f.node.id, model: "provider/model", effort: "high", launchPosture: "full_bypass" });
    const delivered = vi.mocked(f.adapter.deliverStartup).mock.calls.flatMap(call => call[0]);
    for (const path of ["agent/role.md", "rig.md", "pod.md"]) expect(delivered).toContainEqual(expect.objectContaining({ absolutePath: `${root}/${path}` }));
    expect(f.tmux.killSession).not.toHaveBeenCalled();
    // A lost reply never permits a second execution with the same plan.
    expect((await f.request(false, plan.fingerprint)).status).toBe(409);
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  });

  it.each(["present", "unknown"])("refuses %s occupancy without effects", async state => {
    const f = await fixture();
    vi.mocked(f.tmux.probeSession).mockResolvedValue(state === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture" });
    const before = f.db.prepare("SELECT total_changes() AS n").get();
    expect((await f.request()).status).toBe(409);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  });

  it.each(["session", "ready", "failed"])("refuses prior %s history without modifying it", async history => {
    const f = await fixture();
    if (history === "session") f.sessionRegistry.registerSession(f.node.id, "dev-worker@cold-start");
    else if (history === "ready") f.eventBus.emit({ type: "node.startup_ready", rigId: f.rigId, nodeId: f.node.id });
    else f.eventBus.emit({ type: "node.startup_failed", rigId: f.rigId, nodeId: f.node.id, error: "retained failure" });
    const before = f.db.prepare("SELECT total_changes() AS n").get();
    expect((await f.request()).status).toBe(409);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.adapter.project).not.toHaveBeenCalled();
  });

  it.each(["root", "member", "policy", "model"])("requires convergence for a mismatched %s", async kind => {
    const f = await fixture();
    const source = kind === "member" ? f.yaml.replace("local:agent", "local:other") : kind === "policy" ? f.yaml.replace("name: cold-start", "name: cold-start\npermission_policy: builtin:yolo") : kind === "model" ? f.yaml.replace("runtime: pi", "runtime: pi\n        model: other/model") : f.yaml;
    const before = f.db.prepare("SELECT total_changes() AS n").get();
    const response = await f.request(true, undefined, source, kind === "root" ? "/missing" : root);
    expect(response.status).toBe(409);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.adapter.project).not.toHaveBeenCalled();
  });

  it.each(["model", "source", "guidance"])("rejects stale %s plans, including changes during preflight", async kind => {
    const f = await fixture();
    const plan = await f.plan();
    vi.mocked(f.tmux.probeSession).mockImplementation(async () => {
      if (kind === "model") f.rigRepo.setNodeModel(f.node.id, "changed/model");
      if (kind === "source") f.files[`${root}/agent/agent.yaml`] += "\n# changed";
      if (kind === "guidance") f.files[`${root}/pod.md`] += " Changed.";
      return { state: "absent" };
    });
    expect((await f.request(false, plan.fingerprint)).status).toBe(409);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    expect(f.adapter.project).not.toHaveBeenCalled();
  });

  it("serializes two requests for one cold node", async () => {
    const f = await fixture();
    const plan = await f.plan();
    const responses = await Promise.all([f.request(false, plan.fingerprint), f.request(false, plan.fingerprint)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit seat set-model over the source default", async () => {
    const f = await fixture({ model: "source/model" });
    const lifecycle = new SeatLifecycleService({ ...f, tmuxAdapter: f.tmux });
    expect((await lifecycle.setModel({ seatRef: "dev-worker@cold-start", model: "chosen/model", reason: "fixture selection" })).ok).toBe(true);
    const plan = await f.plan();
    expect(plan.model).toMatchObject({ value: "chosen/model", source: "seat set-model" });
    expect((await f.request(false, plan.fingerprint)).status).toBe(201);
    expect(f.rigRepo.getRig(f.rigId)!.nodes.find(n => n.id === f.node.id)!.model).toBe("chosen/model");
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0].model).toBe("chosen/model");
  });

  it.each([undefined, "inherited/model"])("reports requested or unobserved model honestly (%s)", async profileModel => {
    const f = await fixture({ profileModel });
    const plan = await f.plan();
    expect(plan.model.value).toBe(profileModel ?? null);
    expect(plan.model.source).toBe(profileModel ? "profile" : "runtime default");
    if (!profileModel) expect(plan.model.observation).toContain("unobserved");
    expect((await f.request(false, plan.fingerprint)).status).toBe(201);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0].model).toBe(profileModel);
  });

  it("retains failed projection evidence and refuses an automatic fresh retry", async () => {
    const f = await fixture();
    const plan = await f.plan();
    vi.mocked(f.adapter.project).mockResolvedValue({ projected: [], skipped: [], failed: [{ effectiveId: "role", error: "fixture projection failure" }] });
    expect((await f.request(false, plan.fingerprint)).status).toBe(500);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT 1 FROM events WHERE node_id = ? AND type = 'node.startup_failed'").get(f.node.id)).toBeTruthy();
    expect((await f.request(false, plan.fingerprint)).status).toBe(409);
    expect(f.adapter.project).toHaveBeenCalledTimes(1);
  });

  it.each(["context", "delivery"])("keeps normal %s failure evidence without another attempt", async phase => {
    const f = await fixture();
    const plan = await f.plan();
    if (phase === "context") f.db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON node_startup_context BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END");
    else vi.mocked(f.adapter.deliverStartup).mockResolvedValue({ delivered: 0, failed: [{ path: "role.md", error: "fixture delivery failure" }] });
    const response = await f.request(false, plan.fingerprint);
    expect((await response.json()).ok).toBe(false);
    if (phase === "context") expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    else expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT 1 FROM events WHERE node_id = ? AND type = 'node.startup_failed'").get(f.node.id)).toBeTruthy();
    expect((await f.request(false, plan.fingerprint)).status).toBe(409);
  });

  it("reports the existing native permission override and invalidates its changed plan", async () => {
    const f = await fixture({ runtime: "codex", policy: "builtin:yolo" });
    const store = new NativePermissionStore(f.db);
    store.write(f.node.id, { runtime: "codex", mode: "floor" }, "fixture", "explicit selection");
    const before = await f.plan();
    expect(before.permissions).toMatchObject({ launchPosture: "floor", nativeOverride: { mode: "floor" } });
    store.write(f.node.id, { runtime: "codex", mode: "full_bypass" }, "fixture", "changed selection");
    expect((await f.request(false, before.fingerprint)).status).toBe(409);
    const plan = await f.plan();
    expect((await f.request(false, plan.fingerprint)).status).toBe(201);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0].launchPosture).toBe(plan.permissions.launchPosture);
  });

  it("runs the compiled CLI against isolated HTTP/SQLite and prints its plan before native execution", async () => {
    const f = await fixture();
    const directory = mkdtempSync(join(tmpdir(), "cold-launch-cli-"));
    const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const source = join(directory, "rig.yaml");
    writeFileSync(source, f.yaml);
    writeFileSync(join(directory, "daemon.json"), JSON.stringify({ pid: process.pid, port: address.port, db: ":memory:", startedAt: new Date().toISOString() }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENRIG_|RIGGED_|CODEX_HOME$)/.test(key)));
    Object.assign(env, { HOME: directory, XDG_CONFIG_HOME: directory, OPENRIG_HOME: directory });
    const args = [resolve(import.meta.dirname, "../../cli/dist/index.js"), "launch", f.rigId, f.node.logicalId, "--first-start-from", source, "--rig-root", root, "--json"];
    try {
      const preview = await promisify(execFile)(process.execPath, [...args, "--plan"], { env, timeout: 15000 });
      expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, planOnly: true });
      expect(f.adapter.launchHarness).not.toHaveBeenCalled();
      const result = await promisify(execFile)(process.execPath, args, { env, timeout: 15000 });
      const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ ok: true, planOnly: true });
      expect(lines[1]).toMatchObject({ ok: true, planOnly: false, status: "launched", plan: lines[0].plan });
      expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);
});
