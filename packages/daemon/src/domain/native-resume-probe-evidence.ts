import { createHash } from "node:crypto";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { NativeResumeProbeResult } from "./native-resume-probe.js";

/** Bounded metadata from the exact capture assessed by the probe; never its text or detail. */
export interface NativeResumeProbeEvidence {
  status: NativeResumeProbeResult["status"];
  code: string;
  loginRefusal?: NonNullable<NativeResumeProbeResult["loginRefusal"]>;
  capture: {
    lines: number;
    bytes: number;
    sha256: string;
    /** Geometry observed after the capture; null when the pane cannot be identified. */
    columns: number | null;
    rows: number | null;
  };
}

/** Read geometry best-effort, without re-capturing or changing the probe's decision. */
export async function resumeProbeEvidence(
  probe: NativeResumeProbeResult,
  content: string,
  tmux: Pick<TmuxAdapter, "listPanes">,
  target: string,
): Promise<NativeResumeProbeEvidence> {
  let columns: number | null = null;
  let rows: number | null = null;
  const dimension = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value! : null;
  try {
    const panes = await tmux.listPanes(target);
    const pane = /^%\d+$/.test(target) ? panes.find(pane => pane.id === target) : panes.length === 1 ? panes[0] : undefined;
    columns = dimension(pane?.width);
    rows = dimension(pane?.height);
  } catch { /* Diagnostics must not replace the original failure when geometry is unavailable. */ }
  return {
    status: probe.status,
    code: probe.code,
    ...(probe.loginRefusal ? { loginRefusal: probe.loginRefusal } : {}),
    capture: {
      lines: content.length ? content.split(/\r?\n/).length : 0,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      columns,
      rows,
    },
  };
}
