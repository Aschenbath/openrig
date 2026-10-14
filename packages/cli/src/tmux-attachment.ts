import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface TmuxAttachment {
  session: string;
  serverArgs: string[];
  readOnly?: boolean;
}

/** The daemon supplies server options as data; clients never parse a shell command. */
export function readTmuxServerArgs(value: unknown): string[] {
  if (value === undefined) return []; // Compatibility with a daemon predating server metadata.
  if (!Array.isArray(value) || (value.length !== 0 && (value.length !== 2
    || (value[0] !== "-S" && value[0] !== "-L")
    || typeof value[1] !== "string" || !value[1] || value[1].includes("\0")))) {
    throw new Error("The daemon returned invalid tmux server options.");
  }
  return [...value] as string[];
}

/** Offline operations use the last effective server, even with the daemon stopped. */
export function readRecordedTmuxServerArgs(home: string): string[] {
  let record: { version?: unknown; home?: unknown; mode?: unknown; socketPath?: unknown } | null;
  try { record = JSON.parse(readFileSync(path.join(home, "tmux-server.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // Pre-selection daemon.
    throw new Error(`Cannot read the tmux server record: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record || record.version !== 1 || record.home !== realpathSync(home)
    || (record.mode !== "inherit" && record.mode !== "isolated")
    || typeof record.socketPath !== "string" || !path.isAbsolute(record.socketPath)) {
    throw new Error("Invalid tmux server record; inspect it before destroying this instance's sessions.");
  }
  return readTmuxServerArgs(["-S", record.socketPath]);
}

export function assertLocalTmux(baseUrl: string | undefined): void {
  if (baseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname)) {
    throw new Error("Terminal attachment uses local tmux. Run this command on the selected daemon's machine.");
  }
}

/** Attach only; creating or retargeting somebody else's tmux client is not part of this operation. */
export function attachTmux(target: TmuxAttachment): Promise<number> {
  const server = readTmuxServerArgs(target.serverArgs);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn("tmux", [...server, "attach-session", ...(target.readOnly ? ["-r"] : []), "-t", `=${target.session}`],
      { stdio: "inherit", env, windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}
