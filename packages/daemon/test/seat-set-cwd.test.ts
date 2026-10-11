import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";

describe("changing an existing seat's launch directory", () => {
  let db: Database.Database;
  let root: string;
  let oldCwd: string;
  let newCwd: string;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let tmux: TmuxAdapter;
  let adapter: ClaudeCodeAdapter;
  let service: SeatLifecycleService;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-seat-cwd-")));
    oldCwd = path.join(root, "shared");
    newCwd = path.join(root, "seat workspace");
    fs.mkdirSync(oldCwd);
    fs.writeFileSync(path.join(oldCwd, "CLAUDE.md"), "Shared directory instructions\n");
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmux = {
      sendText: vi.fn(async () => { throw new Error("set-cwd must not type"); }),
      sendKeys: vi.fn(async () => { throw new Error("set-cwd must not submit"); }),
      killSession: vi.fn(async () => { throw new Error("set-cwd must not stop a process"); }),
      createSession: vi.fn(async () => { throw new Error("set-cwd must not launch a process"); }),
    } as unknown as TmuxAdapter;
    adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: {
        readFile: file => fs.readFileSync(file, "utf8"),
        writeFile: (file, content) => fs.writeFileSync(file, content),
        exists: fs.existsSync,
        mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
        copyFile: fs.copyFileSync,
        homedir: path.join(root, "native-home"),
      },
    });
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { "claude-code": adapter } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(rigName = "project", logicalId = "planning.lead") {
    const rig = rigRepo.findRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", cwd: oldCwd, model: "fixture-model" });
    const sessionName = `${logicalId.replaceAll(".", "-")}@${rigName}`;
    const session = registry.registerSession(node.id, sessionName);
    registry.updateStatus(session.id, "running");
    registry.updateResumeToken(session.id, "claude_session_id", `saved-${node.id}`, "hook");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    const sources = path.join(root, node.id);
    fs.mkdirSync(sources);
    fs.writeFileSync(path.join(sources, "workspace.md"), "# Workspace guidance\nKeep work within the selected project.\n");
    fs.writeFileSync(path.join(sources, "startup.md"), "# Startup checks\nRead the durable queue before taking work.\n");
    fs.writeFileSync(path.join(sources, "greeting.txt"), "An interactive startup message");
    const files: ResolvedStartupFile[] = ["startup.md", "greeting.txt"].map(name => ({
      path: name, absolutePath: path.join(sources, name), ownerRoot: sources,
      deliveryHint: name.endsWith(".md") ? "guidance_merge" : "send_text",
      required: true, appliesOn: ["fresh_start", "restore"],
    }));
    db.prepare(`INSERT INTO node_startup_context
      (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime)
      VALUES (?, ?, ?, ?, ?)`).run(node.id, JSON.stringify([{
        category: "guidance", effectiveId: "workspace-guidance", sourceSpec: "agent.yaml", mergeStrategy: "managed_block",
        sourcePath: "workspace.md", resourcePath: "workspace.md", absolutePath: path.join(sources, "workspace.md"),
      }]), JSON.stringify(files), JSON.stringify([{
        type: "send_text", value: "Interactive action", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: false,
      }]), "claude-code");
    return { rig, node, sessionName, files };
  }

  function savedCwd(nodeId: string) {
    return (db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(nodeId) as { cwd: string }).cwd;
  }

  function custody() {
    return Object.fromEntries(["sessions", "bindings", "occupant_tenures", "queue_items", "queue_transitions", "node_startup_context"]
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  }

  function cwdEvents() {
    return (db.prepare("SELECT payload FROM events WHERE type = 'node.cwd_changed' ORDER BY seq").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload));
  }

  function signal() {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return { ready, release };
  }

  function guard() {
    migrate(db, [outboxEntriesSchema, seatDeliveryGuardSchema]);
    return tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  }

  it("prepares real startup files and changes only the addressed seat's launch cwd, preserving live custody", async () => {
    const seat = seed();
    const sibling = seed("project", "reviewer");
    const queue = new QueueRepository(db, eventBus, { validateRig: () => true });
    await queue.create({ sourceSession: sibling.sessionName, destinationSession: seat.sessionName, body: "Retained task" } as never);
    const before = custody();
    fs.mkdirSync(newCwd);
    fs.writeFileSync(path.join(newCwd, "CLAUDE.md"), "# Local notes\nKeep these notes.\n");

    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate project planning", operator: "operator@project" });

    expect(result).toMatchObject({ ok: true, from: oldCwd, to: newCwd, changed: true, effect: "next_launch" });
    expect(savedCwd(seat.node.id)).toBe(newCwd);
    expect(savedCwd(sibling.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    const prepared = fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8");
    expect(prepared).toContain("Keep these notes.");
    expect(prepared).toContain("Keep work within the selected project.");
    expect(prepared).toContain("Read the durable queue before taking work.");
    expect(prepared).not.toContain("An interactive startup message");
    expect(fs.readFileSync(path.join(oldCwd, "CLAUDE.md"), "utf8")).toBe("Shared directory instructions\n");
    for (const operation of [tmux.sendText, tmux.sendKeys, tmux.killSession, tmux.createSession]) expect(operation).not.toHaveBeenCalled();
    expect(cwdEvents()).toEqual([expect.objectContaining({ nodeId: seat.node.id, rigId: seat.rig.id,
      from: oldCwd, to: newCwd, reason: "isolate project planning", operator: "operator@project" })]);
  });

  it("creates a missing destination and makes repeat preparation idempotent without another cwd event", async () => {
    const seat = seed();
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect((await service.setCwd(input)).ok).toBe(true);
    const content = fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8");
    expect(await service.setCwd(input)).toMatchObject({ ok: true, changed: false, to: newCwd });
    expect(fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8").trimEnd()).toBe(content.trimEnd());
    expect(cwdEvents()).toHaveLength(1);
  });

  it("retains the old cwd and history when a required startup file cannot be prepared", async () => {
    const seat = seed();
    fs.unlinkSync(seat.files[0]!.absolutePath);
    const before = custody();
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" });
    expect(result).toMatchObject({ ok: false, code: "cwd_preparation_failed" });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    expect(cwdEvents()).toEqual([]);
    expect(fs.readFileSync(path.join(oldCwd, "CLAUDE.md"), "utf8")).toBe("Shared directory instructions\n");
  });

  it("stores a symlink destination's real directory and treats that directory as the same selection", async () => {
    const seat = seed();
    fs.mkdirSync(newCwd);
    const alias = path.join(root, "workspace-link");
    fs.symlinkSync(newCwd, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: alias, reason: "isolate workspace" }))
      .toMatchObject({ ok: true, to: fs.realpathSync(newCwd), changed: true });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "same workspace" }))
      .toMatchObject({ ok: true, changed: false });
    expect(cwdEvents()).toHaveLength(1);
  });

  it("rolls back the cwd if persisting its audit event fails", async () => {
    const seat = seed();
    vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" });
    expect(result).toMatchObject({ ok: false, code: "cwd_persistence_failed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
    expect(fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8")).toContain("Startup checks");
  });

  it.each(["", "relative/workspace", path.parse(process.cwd()).root])("rejects an invalid destination %j before preparing files", async cwd => {
    const seat = seed();
    const project = vi.spyOn(adapter, "project");
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd, reason: "prepare workspace" });
    expect(result.ok).toBe(false);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(project).not.toHaveBeenCalled();
    expect(cwdEvents()).toEqual([]);
  });

  it("refuses an ambiguous logical id before creating the destination", async () => {
    seed("first");
    seed("second");
    expect(await service.setCwd({ seatRef: "planning.lead", cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "seat_ambiguous" });
    expect(fs.existsSync(newCwd)).toBe(false);
  });

  it("honors the selected Claude managed-block file and resolves auto files without typing", async () => {
    const seat = seed();
    rigRepo.setRigClaudeManagedBlockFile(seat.rig.id, "CLAUDE.local.md");
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?")
      .run(JSON.stringify([
        ...seat.files.map(file => ({ ...file, deliveryHint: "auto" })),
        { ...seat.files[0], path: "restore-only.md", absolutePath: path.join(root, "missing.md"), appliesOn: ["restore"] },
      ]), seat.node.id);

    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    const content = fs.readFileSync(path.join(newCwd, "CLAUDE.local.md"), "utf8");
    expect(content).toContain("Read the durable queue");
    expect(content).not.toContain("interactive startup message");
    expect(fs.existsSync(path.join(newCwd, "CLAUDE.md"))).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("prepares Codex startup guidance through its real adapter", async () => {
    const seat = seed();
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.node.id);
    db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    const codex = new CodexRuntimeAdapter({ tmux, fsOps: {
      readFile: file => fs.readFileSync(file, "utf8"), writeFile: (file, content) => fs.writeFileSync(file, content),
      exists: fs.existsSync, mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
      homedir: path.join(root, "native-home"),
    } });
    const codexService = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { codex } });
    expect(await codexService.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    const content = fs.readFileSync(path.join(newCwd, "AGENTS.md"), "utf8");
    expect(content).toContain("Keep work within the selected project.");
    expect(content).toContain("Read the durable queue");
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("prepares a guarded seat without an input lease or changing its protection", async () => {
    const seat = seed();
    const protection = guard();
    await protection.set(seat.node.id, true, "operator", "typing a draft");
    const preference = protection.preference(seat.node.id);
    const project = adapter.project.bind(adapter);
    vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      expect(() => protection.checkInput(seat.node.id)).toThrow(/lease/);
      return project(...args);
    });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare later launch" })).toMatchObject({ ok: true });
    expect(protection.preference(seat.node.id)).toEqual(preference);
    expect(new SeatStatusService({ rigRepo }).getStatus(seat.sessionName)).toMatchObject({
      ok: true, status: { launch_cwd: newCwd, current_occupant: seat.sessionName },
    });
  });

  it("waits for a lifecycle operation and keeps a later launch behind preparation and commit", async () => {
    const seat = seed();
    const protection = guard();
    const lifecycleEntered = signal();
    const finishLifecycle = signal();
    const preparationEntered = signal();
    const finishPreparation = signal();
    const project = adapter.project.bind(adapter);
    const projection = vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      preparationEntered.release();
      await finishPreparation.ready;
      return project(...args);
    });
    const earlier = protection.lifecycle([seat.node.id], async () => {
      lifecycleEntered.release();
      await finishLifecycle.ready;
    });
    await Promise.race([lifecycleEntered.ready, earlier]);
    const changing = service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "next launch" });
    let launchCwd: string | undefined;
    const later = protection.lifecycle([seat.node.id], async () => { launchCwd = savedCwd(seat.node.id); });
    try {
      await Promise.resolve();
      expect(projection).not.toHaveBeenCalled();
      finishLifecycle.release();
      await preparationEntered.ready;
      expect(launchCwd).toBeUndefined();
      expect(savedCwd(seat.node.id)).toBe(oldCwd);
    } finally {
      finishLifecycle.release();
      finishPreparation.release();
      await earlier;
      await later;
    }
    expect(await changing).toMatchObject({ ok: true });
    expect(launchCwd).toBe(newCwd);
  });

  it.each(["cwd", "runtime", "startup"])("does not commit over a concurrent %s change", async field => {
    const seat = seed();
    const project = adapter.project.bind(adapter);
    const otherCwd = path.join(root, "other-workspace");
    vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      const result = await project(...args);
      if (field === "cwd") db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(otherCwd, seat.node.id);
      if (field === "runtime") db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.node.id);
      if (field === "startup") db.prepare("UPDATE node_startup_context SET startup_actions_json = '[]' WHERE node_id = ?").run(seat.node.id);
      return result;
    });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_configuration_changed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(field === "cwd" ? otherCwd : oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it.each(["missing", "malformed", "runtime"])("refuses %s startup context before preparation", async kind => {
    const seat = seed();
    if (kind === "missing") db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.node.id);
    if (kind === "malformed") db.prepare("UPDATE node_startup_context SET resolved_files_json = 'not-json' WHERE node_id = ?").run(seat.node.id);
    if (kind === "runtime") db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    const code = kind === "runtime" ? "startup_context_runtime_mismatch" : `startup_context_${kind}`;
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" })).toMatchObject({ ok: false, code });
    expect(fs.existsSync(newCwd)).toBe(false);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it("reports projection failure, retains the old selection and releases the configuration lock", async () => {
    const seat = seed();
    guard();
    const project = vi.spyOn(adapter, "project").mockResolvedValueOnce({
      projected: [], skipped: [], failed: [{ effectiveId: "workspace-guidance", error: "source unavailable" }],
    });
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect(await service.setCwd(input)).toMatchObject({ ok: false, code: "cwd_preparation_failed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
    project.mockRestore();
    expect(await service.setCwd(input)).toMatchObject({ ok: true });
  });

  it("rejects a file destination without changing its contents", async () => {
    const seat = seed();
    fs.writeFileSync(newCwd, "existing file");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "invalid_cwd" });
    expect(fs.readFileSync(newCwd, "utf8")).toBe("existing file");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });
});
