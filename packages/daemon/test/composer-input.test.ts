import { describe, expect, it } from "vitest";
import { composerContainsOwnedText, inspectComposerInput, ownCollapsedPaste, type ComposerSnapshot } from "../src/domain/composer-input.js";

function claude(body: string, cursor?: { x: number; y: number }, width = 80): ComposerSnapshot {
  const rows = body.split("\n");
  const last = rows.at(-1)!;
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + last.length, y: 1 + rows.length, width, height: 24, ...cursor }, inMode: false };
}

describe("cursor-bound composer input", () => {
  it("distinguishes an empty input from a draft even while a work status is visible", () => {
    const empty = claude(""); empty.screen = empty.screen.replace("Ready", "✻ Working… (2s · esc to interrupt)");
    expect(inspectComposerInput(empty).state).toBe("empty");
    expect(inspectComposerInput(claude("a half-written request")).state).toBe("text");
    expect(inspectComposerInput(claude("", { x: 5, y: 2 })).state).toBe("text");
    expect(inspectComposerInput(claude("\n")).state).toBe("text");
    expect(inspectComposerInput(claude("\n", { x: 2, y: 2 })).state).toBe("text");
    expect(inspectComposerInput(claude("   ", { x: 2, y: 2 })).state).toBe("text");
  });

  it.each(["›", "»"])("recognizes the empty Codex placeholder with marker %s only at the input cursor", marker => {
    const s: ComposerSnapshot = { screen: `Working\n${marker} Ask Codex to do anything\n\ngpt-5 · 90% context left\n`, cursor: { x: 2, y: 1, width: 80, height: 24 }, inMode: false };
    expect(inspectComposerInput(s).state).toBe("empty");
    expect(inspectComposerInput({ ...s, cursor: { ...s.cursor, x: 12 } }).state).toBe("text");
  });

  it("does not infer an empty input from history, a selector, copy mode or an incomplete capture", () => {
    expect(inspectComposerInput(null).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), inMode: true }).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), cursor: { x: 0, y: 0, width: 80, height: 24 } }).state).toBe("unknown");
    expect(inspectComposerInput(claude("1. Approve this command")).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), screen: "❯\n" }).state).toBe("unknown");
  });

  it("requires the complete owned text and preserves significant spaces", () => {
    const input = inspectComposerInput(claude("Run two commands\nthen report."));
    expect(composerContainsOwnedText(input, "Run two commands\nthen report.")).toBe(true);
    expect(composerContainsOwnedText(input, "Run twocommands\nthen report.")).toBe(false);
    expect(composerContainsOwnedText(input, "Run two commands")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("owned plus a human draft")), "owned")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("owned", { x: 8, y: 2 })), "owned")).toBe(false);
  });

  it("accepts supported hard and word wrapping without deleting arbitrary whitespace", () => {
    const hard = inspectComposerInput(claude("abcdefgh\nijkl", undefined, 10));
    expect(composerContainsOwnedText(hard, "abcdefghijkl")).toBe(true);
    const words = inspectComposerInput(claude("one two\nthree", undefined, 10));
    expect(composerContainsOwnedText(words, "one two three")).toBe(true);
    expect(composerContainsOwnedText(words, "one  two three")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("one\ntwo")), "one two")).toBe(false);
  });

  it("matches Unicode cell widths and treats an opaque paste as separately owned evidence", () => {
    const input = inspectComposerInput(claude("你好世界\nagain", { x: 7, y: 3 }, 10));
    expect(composerContainsOwnedText(input, "你好世界again")).toBe(true);
    const opaque = inspectComposerInput(claude("[Pasted text #4 +2 lines]"));
    expect(ownCollapsedPaste(opaque, "one\ntwo\nthree")).toBe("[Pasted text #4 +2 lines]");
    expect(ownCollapsedPaste(opaque, "one\ntwo")).toBeNull();
    expect(composerContainsOwnedText(opaque, "one\ntwo\nthree")).toBe(false);
    expect(ownCollapsedPaste(inspectComposerInput(claude("[Pasted text #4 +2 lines] foreign")), "one\ntwo\nthree")).toBeNull();
  });
});
