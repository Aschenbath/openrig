import path from "node:path";
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { slackMicros, slackTimestamp } from "./state-store.js";
import { ThreadRecoveryStore, type ThreadCoverage, type ThreadRecoveryCoverage } from "./thread-recovery-store.js";

interface ThreadRecoveryOptions {
  channel: string | null;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  /** Durable mapped roots, including closed and superseded conversations. */
  mappedRoots: () => string[];
  fetchImpl?: FetchImpl;
  store?: ThreadRecoveryStore;
  now?: () => number;
}

/** Recover ordinary replies without letting live traffic or channel scans skip an older gap. */
export class ThreadRecovery {
  private readonly store: ThreadRecoveryStore;
  private readonly now: () => number;
  private coverage?: ThreadRecoveryCoverage;
  private pass?: Promise<void>;
  private stopped = false;
  private state = "not-started";
  private reason: string | undefined;
  private lastScanAt: string | undefined;
  private scanUpper: string | undefined;
  private accepted = 0;
  private deadLettered = 0;

  constructor(private readonly opts: ThreadRecoveryOptions) {
    this.store = opts.store ?? new ThreadRecoveryStore(path.join(opts.stateDir, "slack-thread-coverage.json"));
    this.now = opts.now ?? Date.now;
  }

  /** Called before the socket or the first channel scan, using its last durable boundary. */
  initialize(floor: string | undefined): void {
    if (!this.opts.channel) { this.state = "unavailable"; this.reason = "channel-not-configured"; return; }
    if (!floor) { this.state = "unavailable"; this.reason = "channel-coverage-unavailable"; return; }
    try {
      this.coverage = this.store.initialize(this.opts.channel, floor);
      this.state = this.opts.token ? "pending" : "unavailable";
      this.reason = this.opts.token ? undefined : "bot-token-unresolved";
      this.discoverMappedRoots();
    } catch { this.state = "unavailable"; this.reason = "checkpoint-unreadable-or-unwritable"; }
  }

  /** Remember roots seen live or in available channel history, including human-started threads.
   * No message body or sender is stored, and an observation never advances existing progress. */
  observe(ev: SlackEvent): void {
    if (this.stopped || ev.type !== "message" || ev.channel !== this.opts.channel || slackMicros(ev.ts) === null) return;
    if (ev.subtype && !["file_share", "thread_broadcast", "bot_message"].includes(ev.subtype)) return;
    const root = ev.thread_ts ?? ev.ts!;
    if (slackMicros(root) === null || slackMicros(root)! > slackMicros(ev.ts)!) return;
    try { this.track(root); }
    catch (error) { this.state = "incomplete"; this.reason = "thread-tracking-failed"; throw error; }
  }

  status() {
    const values = Object.values(this.coverage?.threads ?? {});
    const through = values.reduce<string | undefined>((oldest, value) => oldest === undefined || slackMicros(value.coveredThrough)! < slackMicros(oldest)!
      ? value.coveredThrough : oldest, undefined);
    const retries = [this.coverage?.nextRetryAt, ...values.map(v => v.nextRetryAt)].filter((v): v is number => v !== undefined);
    const pending = values.filter(v => v.pending || (this.scanUpper && slackMicros(v.coveredThrough)! < slackMicros(this.scanUpper)!)).length;
    return { state: this.state === "scanned" && pending ? "pending" : this.state, reason: this.reason, channel: this.opts.channel, lastScanAt: this.lastScanAt,
      coverageStart: this.coverage?.coverageStart, coveredThrough: through,
      trackedThreads: values.length, pendingThreads: pending,
      failedThreads: values.filter(v => v.reason).length,
      nextRetryAt: retries.length ? retries.reduce((a, b) => Math.min(a, b)) : undefined,
      acceptedThisProcess: this.accepted, deadLetteredThisProcess: this.deadLettered,
      limits: ["default-channel mapped roots and roots observed since adoption; older unseen threads unknown",
        "four reply pages / 100 entries / 15 seconds admission per pass; threads take turns; no global chronological ordering",
        ...(values.some(v => v.historyLimited) ? ["Slack plan limit excludes older thread history"] : [])] };
  }

  stop(): void { this.stopped = true; this.state = "stopped"; }

  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (this.stopped || !this.coverage || !this.opts.token || !this.opts.channel) return Promise.resolve();
    const pass = this.scan().catch(() => {
      if (!this.stopped) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; }
    });
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  private save(next: ThreadRecoveryCoverage): void {
    if (this.stopped) return;
    this.store.save(this.opts.channel!, next);
    this.coverage = next;
  }

  private track(root: string): void {
    if (!this.coverage) throw new Error("thread coverage unavailable");
    if (Object.hasOwn(this.coverage.threads, root)) return;
    const start = slackMicros(this.coverage.coverageStart)!;
    this.save({ ...this.coverage, threads: { ...this.coverage.threads,
      [root]: { coveredThrough: slackMicros(root)! > start ? root : this.coverage.coverageStart } } });
  }

  private discoverMappedRoots(): void {
    const threads = { ...this.coverage!.threads };
    const start = slackMicros(this.coverage!.coverageStart)!;
    let changed = false;
    for (const root of this.opts.mappedRoots()) {
      const timestamp = slackMicros(root);
      if (timestamp === null || Object.hasOwn(threads, root)) continue;
      threads[root] = { coveredThrough: timestamp > start ? root : this.coverage!.coverageStart };
      changed = true;
    }
    if (changed) this.save({ ...this.coverage!, threads });
  }

  /** Merge with the current inventory: live events may add a root while a page is in flight. */
  private saveThread(root: string, progress: ThreadCoverage): void {
    this.save({ ...this.coverage!, afterThread: root, threads: { ...this.coverage!.threads, [root]: progress } });
  }

  private async scan(): Promise<void> {
    this.discoverMappedRoots();
    if (this.coverage!.nextRetryAt && this.coverage!.nextRetryAt > this.now()) {
      this.state = "backoff"; this.reason = this.coverage!.reason; return;
    }
    const deadline = this.now() + 15_000;
    const upper = slackTimestamp(BigInt(Math.max(0, this.now() - 5000)) * 1000n);
    this.scanUpper = upper;
    this.lastScanAt = new Date(this.now()).toISOString();
    this.state = "scanning"; this.reason = undefined;
    let entries = 0;
    for (let pages = 0; pages < 4 && !this.stopped && this.now() < deadline && entries < 100; pages++) {
      const roots = Object.keys(this.coverage!.threads).sort();
      const after = this.coverage!.afterThread;
      const split = after === undefined ? 0 : roots.findIndex(root => root > after);
      const order = split < 0 ? roots : [...roots.slice(split), ...roots.slice(0, split)];
      const root = order.find(key => {
        const t = this.coverage!.threads[key]!;
        return !(t.nextRetryAt && t.nextRetryAt > this.now()) && (t.pending || slackMicros(t.coveredThrough)! < slackMicros(upper)!);
      });
      if (!root) break;
      let progress = { ...this.coverage!.threads[root]! };
      if (!progress.pending) {
        const lower = slackMicros(progress.coveredThrough)!;
        progress = { ...progress, pending: { upper, nextOldest: slackTimestamp(lower > 0n ? lower - 1n : 0n) } };
        this.saveThread(root, progress);
      }
      const pending = progress.pending!;
      const lower = slackMicros(pending.nextOldest)!, latest = slackMicros(pending.upper)!;
      const limit = Math.min(25, 100 - entries);
      const result = await callWebApi("conversations.replies", this.opts.token!, {
        channel: this.opts.channel, ts: root, oldest: pending.nextOldest, latest: pending.upper, inclusive: false, limit,
      }, this.opts.fetchImpl, Math.min(5000, deadline - this.now()), "get-query");
      if (this.stopped) return;
      if (!result.ok) {
        const known = ["missing_scope", "not_allowed_token_type", "not_in_channel", "channel_not_found", "thread_not_found", "invalid_auth", "token_revoked"];
        const reason = result.status === 429 ? "rate-limited" : known.includes(result.error ?? "") ? result.error! : "replies-api-unavailable";
        const delay = result.retryAfterSeconds ?? (result.status === 0 || result.status >= 500 ? 5 : 300);
        const nextRetryAt = this.now() + delay * 1000;
        this.saveThread(root, { ...progress, reason, nextRetryAt });
        if (result.status === 429 || ["missing_scope", "not_allowed_token_type", "invalid_auth", "token_revoked"].includes(reason)) {
          this.save({ ...this.coverage!, reason, nextRetryAt });
          this.state = "backoff"; this.reason = reason; return;
        }
        continue;
      }
      const messages = result.json.messages;
      const cursor = (result.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (!Array.isArray(messages) || messages.length > limit ||
          (result.json.has_more !== undefined && typeof result.json.has_more !== "boolean") ||
          (result.json.has_more === undefined && cursor === undefined) || (cursor !== undefined && typeof cursor !== "string") ||
          messages.some(m => !m || typeof m !== "object" || slackMicros(m.ts) === null ||
            (m.channel !== undefined && m.channel !== this.opts.channel) ||
            (m.thread_ts !== undefined && m.thread_ts !== root) ||
            (m.ts !== root && (slackMicros(m.ts)! <= lower || slackMicros(m.ts)! >= latest)))) {
        this.saveThread(root, { ...progress, reason: "invalid-replies-page", nextRetryAt: this.now() + 5000 });
        continue;
      }
      // Slack may include the parent even when it precedes oldest. It identifies the
      // thread, not a new inbound message, and cannot establish pagination progress.
      const replies = (messages as SlackEvent[]).filter(m => m.ts !== root);
      if (replies.some((message, index) => index > 0 && slackMicros(message.ts)! <= slackMicros(replies[index - 1]!.ts)!)) {
        this.saveThread(root, { ...progress, reason: "invalid-replies-order", nextRetryAt: this.now() + 5000 });
        continue;
      }
      const more = result.json.has_more === true || (typeof cursor === "string" && cursor.length > 0);
      if (more && replies.length === 0) {
        this.saveThread(root, { ...progress, reason: "replies-page-no-progress", nextRetryAt: this.now() + 5000 });
        continue;
      }
      if (result.json.is_limited === true) progress.historyLimited = true;
      entries += messages.length;
      let inFlight = false;
      for (const message of replies) {
        if (this.stopped) return;
        if (this.now() >= deadline) { this.state = "incomplete"; this.reason = "pass-budget"; return; }
        const ev: SlackEvent = { ...message, channel: this.opts.channel!, thread_ts: root, recoveredAfterGap: true };
        if (!ingestDecision(ev).ingest) continue;
        const landed = await this.opts.router.route(ev, 0, () => !this.stopped);
        if (this.stopped) return;
        if (landed.reason === "inflight" || landed.reason === "inactive") { inFlight = true; break; }
        if (landed.disposition === "accepted") this.accepted++;
        if (landed.disposition === "dead-lettered") this.deadLettered++;
      }
      this.saveThread(root, inFlight
        ? { ...progress, reason: "landing-in-progress", nextRetryAt: this.now() + 5000 }
        : { ...progress, reason: undefined, nextRetryAt: undefined,
          ...(more ? { pending: { upper: pending.upper, nextOldest: replies.at(-1)!.ts! } }
            : { coveredThrough: pending.upper, pending: undefined }) });
      if (this.coverage!.nextRetryAt !== undefined) this.save({ ...this.coverage!, nextRetryAt: undefined, reason: undefined });
    }
    if (this.stopped) return;
    const threads = Object.values(this.coverage!.threads);
    const failed = threads.find(t => t.reason);
    const remaining = threads.some(t => t.pending || slackMicros(t.coveredThrough)! < slackMicros(upper)!);
    this.state = failed ? "backoff" : remaining ? "incomplete" : "scanned";
    this.reason = failed?.reason ?? (remaining ? "pass-budget" : undefined);
  }
}
