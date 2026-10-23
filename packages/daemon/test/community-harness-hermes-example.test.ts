import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

// The documented Hermes example, run against a stand-in `hermes` that records how it was started (no Hermes, no model).
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/hermes");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-example-")); dirs.push(dir);
  const fake = join(dir, "hermes");
  writeFileSync(fake, `#!/bin/sh\necho "$@ HOME=$HERMES_HOME" > "${dir}/started"\n`);
  chmodSync(fake, 0o755);
  const launch = (extra: Record<string, string>) => execFileSync(join(EXAMPLE, "openrig-hermes-launch"), ["--provider", "openrouter"],
    { env: { PATH: process.env["PATH"]!, OPENRIG_HERMES: fake, OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", ...extra }, timeout: 20_000, stdio: "pipe" });
  launch(env);
  return { started: readFileSync(join(dir, "started"), "utf8").trim(), home: join(dir, "home", "state", "hermes", "node-1"), launch };
}

describe("the documented Hermes launcher and preset", () => {
  it("creates the session OpenRig named, in the seat's own Hermes home", () => {
    const { started, home } = run({ OPENRIG_CONVERSATION: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`chat -c openrig-dev-impl-1a2b3c4d --create-if-missing --provider openrouter HOME=${home}`);
  });

  it("reopens the named session on a resume with none of the creation flags, which Hermes refuses there", () => {
    const { started, home } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`chat -c openrig-dev-impl-1a2b3c4d HOME=${home}`);
  });

  it("starts nothing when OpenRig passed no name", () => {
    const { launch } = run({ OPENRIG_CONVERSATION: "x" });
    expect(() => launch({})).toThrow(/passed no conversation name/);
  });

  it("is a preset this OpenRig loads, declaring names_conversation and not resume", () => {
    expect(loadCommunityHarnessPreset("hermes", EXAMPLE)).toMatchObject({ ok: true, preset: { namesConversation: true, launchResult: false, resume: false } });
  });
});
