import path from "node:path";
import { nodeStateFs, slackMicros, type StateFsOps } from "./state-store.js";

export interface ThreadCoverage {
  coveredThrough: string;
  /** Replies are returned oldest first. Only a fully landed page advances nextOldest. */
  pending?: { upper: string; nextOldest: string };
  nextRetryAt?: number;
  reason?: string;
  historyLimited?: boolean;
}

export interface ThreadRecoveryCoverage {
  /** Fixed on adoption, before channel recovery or newer live events can advance. */
  coverageStart: string;
  threads: Record<string, ThreadCoverage>;
  /** Round-robin position, including partial and failed threads. */
  afterThread?: string;
  /** conversations.replies rate limits and authentication failures apply to all threads. */
  nextRetryAt?: number;
  reason?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validRetry = (value: unknown): boolean => value === undefined ||
  (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** Atomic per-channel thread checkpoints. Unreadable or malformed state is never reseeded. */
export class ThreadRecoveryStore {
  constructor(private readonly file: string, private readonly fsops: StateFsOps = nodeStateFs) {}

  private read(): Record<string, ThreadRecoveryCoverage> {
    let raw: string;
    try { raw = this.fsops.readFileSync(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!record(data)) throw new Error("invalid thread coverage store");
    for (const value of Object.values(data)) {
      if (!record(value) || slackMicros(value.coverageStart) === null || !record(value.threads) ||
          !validRetry(value.nextRetryAt) || (value.reason !== undefined && typeof value.reason !== "string") ||
          (value.afterThread !== undefined && (typeof value.afterThread !== "string" || !Object.hasOwn(value.threads, value.afterThread)))) {
        throw new Error("invalid thread coverage checkpoint");
      }
      const start = slackMicros(value.coverageStart)!;
      for (const [root, progress] of Object.entries(value.threads)) {
        const rootMicros = slackMicros(root);
        if (rootMicros === null || !record(progress)) throw new Error("invalid thread root");
        const through = slackMicros(progress.coveredThrough);
        if (through === null || through < start || through < rootMicros || !validRetry(progress.nextRetryAt) ||
            (progress.reason !== undefined && typeof progress.reason !== "string") ||
            (progress.historyLimited !== undefined && typeof progress.historyLimited !== "boolean")) {
          throw new Error("invalid thread progress");
        }
        if (progress.pending !== undefined) {
          if (!record(progress.pending)) throw new Error("invalid thread interval");
          const upper = slackMicros(progress.pending.upper), next = slackMicros(progress.pending.nextOldest);
          if (upper === null || next === null || upper <= through || next < (through > 0n ? through - 1n : 0n) || next >= upper) {
            throw new Error("invalid thread interval");
          }
        }
      }
    }
    return data as unknown as Record<string, ThreadRecoveryCoverage>;
  }

  initialize(channel: string, floor: string): ThreadRecoveryCoverage {
    const data = this.read();
    if (Object.hasOwn(data, channel)) return data[channel]!;
    if (slackMicros(floor) === null) throw new Error("invalid thread recovery floor");
    const coverage: ThreadRecoveryCoverage = { coverageStart: floor, threads: {} };
    this.save(channel, coverage);
    return coverage;
  }

  save(channel: string, coverage: ThreadRecoveryCoverage): void {
    const data = this.read();
    Object.defineProperty(data, channel, { value: coverage, enumerable: true, configurable: true });
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.writeFileSync(`${this.file}.tmp`, JSON.stringify(data) + "\n");
    this.fsops.rename(`${this.file}.tmp`, this.file);
  }
}
