import { createHash } from "node:crypto";
import path from "node:path";
import { formatHumanAnswers, type RecordHumanAnswerResult } from "../../human-questions.js";
import type { InboundQueuePort } from "../slack/queue-access.js";
import { MatrixClient, MatrixTokenError, abortableSleep, type MatrixEvent } from "./matrix-api.js";
import { JsonStore } from "./state-store.js";
import { ThreadSeatMap } from "./thread-seat-map.js";
import { routeMessage } from "./thread-routing.js";
import { reactionAnswer } from "./reactions.js";

interface SyncState { since?: string; seen: string[]; lastSync?: string }
export interface InboundStatus { state: "not-started" | "connecting" | "connected" | "backoff" | "failed" | "stopped"; lastSync?: string; error?: string; reconnects: number }
export class MatrixInbound {
  private readonly store: JsonStore<SyncState>;
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private observation: InboundStatus = { state: "not-started", reconnects: 0 };
  constructor(private readonly opts: {
    home: string; client: MatrixClient; map: ThreadSeatMap; queue: InboundQueuePort;
    destination: string; resolveSender: (sender: string, roomId: string) => string | null;
    prepareRooms?: (signal: AbortSignal) => Promise<void>;
    recordHumanAnswer?: (input: { qitemId: string; actorSession: string; questionId: string; optionId: string }) => RecordHumanAnswerResult;
    resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
    sleep?: typeof abortableSleep; timeoutMs?: number; log?: (message: string) => void;
  }) {
    this.store = new JsonStore(path.join(opts.home, "state", "matrix-sync.json"), { seen: [] });
  }
  status(): InboundStatus { return { ...this.observation, lastSync: this.store.read().lastSync }; }
  start(): void { if (!this.running) this.running = this.run(); }
  async stop(): Promise<void> { this.controller.abort(); await this.running; this.observation.state = "stopped"; }
  private async run(): Promise<void> {
    let failures = 0;
    let bot: string | undefined;
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        if (!bot) {
          this.observation.state = "connecting";
          bot = (await this.opts.client.whoami(signal)).user_id;
          await this.opts.prepareRooms?.(signal);
        }
        await this.syncOnce(bot, signal);
        failures = 0;
        this.observation.state = "connected";
        this.observation.error = undefined;
      } catch (error) {
        if (signal.aborted) break;
        this.observation.error = (error as Error).message;
        if (error instanceof MatrixTokenError) { this.observation.state = "failed"; return; }
        this.observation.state = "backoff";
        this.observation.reconnects++;
        this.opts.log?.(`matrix sync failed; retrying: ${(error as Error).message}`);
        try { await (this.opts.sleep ?? abortableSleep)(Math.min(30000, 1000 * 2 ** failures++), signal); }
        catch { break; }
        // Retry setup failures too; prepareRooms must be idempotent.
        bot = undefined;
      }
    }
  }
  async syncOnce(botUserId: string, signal?: AbortSignal): Promise<void> {
    const state = this.store.read();
    const page = await this.opts.client.sync({ since: state.since, timeoutMs: this.opts.timeoutMs ?? 30000, signal });
    for (const [roomId, room] of Object.entries(page.rooms?.join ?? {})) {
      // The first sync establishes a floor instead of replaying room history.
      // A limited incremental timeline is a visible gap: keep the old token
      // until the operator can repair it; silently advancing would lose events.
      if (state.since && room.timeline?.limited) throw new Error(`Matrix timeline gap in ${roomId}; retained since token; history backfill is not supported in this MVP`);
      if (!state.since) continue;
      for (const event of room.timeline?.events ?? []) {
        if (signal?.aborted) throw signal.reason;
        if (!event.event_id || this.store.read().seen.includes(event.event_id)) continue;
        await this.ingest(roomId, event, botUserId);
        // Mark each landed event before committing the page token. On a partial
        // failure the same page retries and deterministic queue IDs absorb crashes.
        const current = this.store.read();
        this.store.write({ ...current, seen: [...current.seen, event.event_id].slice(-10000) });
      }
    }
    this.store.write({ ...this.store.read(), since: page.next_batch, lastSync: new Date().toISOString() });
  }
  private async ingest(roomId: string, event: MatrixEvent, botUserId: string): Promise<void> {
    if (event.sender === botUserId || !event.sender || !event.content) return;
    if (event.type !== "m.room.message" && event.type !== "m.reaction") return;
    const human = this.opts.resolveSender(event.sender, roomId);
    if (!human) { this.opts.log?.("matrix inbound refused: sender has no registered binding in this room"); return; }
    const id = (prefix: string, key: string) => `qitem-matrix-${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
    if (event.type === "m.reaction") {
      const choice = reactionAnswer(this.opts.map, roomId, event, human);
      if (!choice) return;
      const result = this.opts.recordHumanAnswer?.({ qitemId: choice.qitemId, actorSession: human, questionId: choice.questionId, optionId: choice.optionId });
      if (!result || result.status !== "recorded" || !result.complete) return;
      const lines = formatHumanAnswers(result.questions, result.answers);
      await this.opts.queue.createQitem({
        qitemId: id("answers", choice.qitemId), source: human, destination: choice.seat,
        summary: `Human via Matrix: answered ${result.questions.length} question(s)`, body: lines.join("\n"),
        tags: ["matrix", "inbound", "human-answer"], inReplyTo: choice.qitemId,
      });
      await this.opts.resolveHumanReply?.({ qitemId: choice.qitemId, actorSession: human, decision: lines.join("; ") });
      return;
    }
    const relation = event.content["m.relates_to"];
    if (relation?.rel_type === "m.replace" || !["m.text", "m.notice", "m.emote"].includes(event.content.msgtype ?? "") || !event.content.body?.trim()) return;
    const route = routeMessage(this.opts.map, roomId, event, this.opts.destination);
    if (route.human && route.human !== human) return;
    await this.opts.queue.createQitem({
      qitemId: id("inbound", event.event_id), source: human, destination: route.destination,
      summary: `Human via Matrix: ${event.content.body.slice(0, 90)}`, body: event.content.body,
      tags: route.tags, ...(route.conversationId ? { inReplyTo: route.conversationId } : {}),
    });
    if (route.conversationId) await this.opts.resolveHumanReply?.({ qitemId: route.conversationId, actorSession: human, decision: event.content.body });
  }
}
