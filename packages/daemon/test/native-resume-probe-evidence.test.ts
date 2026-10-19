import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { resumeProbeEvidence } from "../src/domain/native-resume-probe-evidence.js";

const pane = { id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true };
const assess = (paneContent: string) => assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent });

describe("bounded resume probe evidence (#1480)", () => {
  it.each(["Not logged in", "Login expired", "OAuth token revoked"])("records the fixed %s refusal and its row kind", async prefix => {
    for (const [marker, row] of [["●", "response"], ["⏺", "response"], ["  ⎿", "result"]] as const) {
      const message = `${prefix} · Please run /login`;
      const content = `❯ fixture-secret-do-not-store\r\n${marker} ${message}\r\n\r\n❯\r\n`;
      const probe = assess(content);
      expect(probe).toMatchObject({ status: "failed", code: "login_required", loginRefusal: { message, row } });
      const evidence = await resumeProbeEvidence(probe, content, { listPanes: async () => [pane] }, "%1");
      expect(evidence).toEqual({ status: "failed", code: "login_required", loginRefusal: { message, row }, capture: {
        lines: 5, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), columns: 80, rows: 24,
      } });
      expect(JSON.stringify(evidence)).not.toContain("fixture-secret-do-not-store");
      expect(evidence).not.toHaveProperty("detail");
    }
  });

  it.each([
    "❯ Not logged in · Please run /login\n● working\n\n❯",
    "● Not logged in · Please run /login\n\n❯ next\n● working\n\n❯",
    "● Not logged in · Please run /login with fixture-secret-do-not-store\n\n❯",
    "  ● Not logged in · Please run /login\n\n❯",
  ])("does not assign a refusal to quoted, stale or non-exact text: %s", content => {
    expect(assess(content).code).not.toBe("login_required");
    expect(assess(content)).not.toHaveProperty("loginRefusal");
  });

  it("hashes the exact captured bytes, including CRLF and trailing lines", async () => {
    const get = (content: string) => resumeProbeEvidence(assess(content), content, { listPanes: async () => [] }, "%1");
    expect((await get("a\r\nb\n")).capture.sha256).not.toBe((await get("a\nb\n")).capture.sha256);
    expect((await get("")).capture).toMatchObject({ lines: 0, bytes: 0, columns: null, rows: null });
  });

  it("keeps the original result if geometry fails, is ambiguous, or belongs to another pane", async () => {
    const content = "● Login expired · Please run /login";
    const probe = assess(content);
    for (const listPanes of [
      vi.fn(async () => { throw new Error("fixture-secret-do-not-store"); }),
      vi.fn(async () => [{ ...pane, id: "%2" }]),
      vi.fn(async () => [{ ...pane, width: NaN, height: -1 }]),
    ]) {
      expect(await resumeProbeEvidence(probe, content, { listPanes }, "%1")).toMatchObject({
        status: "failed", code: "login_required", capture: { columns: null, rows: null },
      });
    }
    expect((await resumeProbeEvidence(probe, content, { listPanes: async () => [pane, { ...pane, id: "%2" }] }, "seat")).capture)
      .toMatchObject({ columns: null, rows: null });
  });
});
