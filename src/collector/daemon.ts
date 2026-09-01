import { randomUUID } from "node:crypto";
import { REGISTERED_COLLECTOR_ENDPOINT, uploadQueuedBatch, type CollectorKeyLoader, type CollectorUploadOptions } from "./client";
import type { RuntimeCollectorConfig } from "./config";
import { MAX_SESSIONS, SESSION_BATCH_SCHEMA_ID, isCollectorModelIdentifierV1, validateDecodedSessionBatchV1, type CollectionErrorCategory, type SessionBatchV1, type SessionV1 } from "./protocol";
import { CollectorQueue, type DrainStepResult } from "./queue";
import { collectOmpSessionPage, OmpDatabaseOpenError, OmpInvalidDataError, OmpQueryExecutionError, OmpSchemaValidationError, type OmpSessionPageResult } from "./session-adapter";
import type { OmpSessionSummaryInput } from "../observatory/types";

export type RuntimeCollectorLogCategory = "cycle_ok" | "cycle_skipped" | "collection_failed" | "queue_halted" | "upload_deferred";
export type RuntimeCollectorCycleStatus = "disabled" | "completed" | "collection_error" | "halted";

export interface RuntimeCollectorCycleResult {
  status: RuntimeCollectorCycleStatus;
  queuedBatches: number;
  queuedSessions: number;
  drain: DrainStepResult | null;
}

export type SessionIdentityKeyLoader = (credentialId: string, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>;
export type RuntimeCollectorTimerHandle = NodeJS.Timeout | number;
export interface RuntimeCollectorDaemonOptions {
  config: RuntimeCollectorConfig;
  loadKey: CollectorKeyLoader;
  loadSessionIdentityKey: SessionIdentityKeyLoader;
  jitter?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => RuntimeCollectorTimerHandle;
  clearScheduledTimeout?: (handle: RuntimeCollectorTimerHandle) => void;
  queueFactory?: (queueDir: string) => CollectorQueue;
  upload?: typeof uploadQueuedBatch;
  clock?: () => number;
  logCategory?: (category: RuntimeCollectorLogCategory) => void;
}

export class RuntimeCollectorDaemonError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("COLLECTOR_DAEMON_FAILED");
    this.name = "RuntimeCollectorDaemonError";
    this.code = code;
    this.stack = undefined;
  }
}

function awaitAbortable<T>(
  source: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  const finish = (): boolean => {
    if (settled) return false;
    settled = true;
    signal.removeEventListener("abort", abort);
    return true;
  };
  const abort = (): void => {
    if (finish()) reject(new RuntimeCollectorDaemonError("cycle_timeout"));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  source.then(
    (value) => {
      if (finish()) resolve(value);
      else onLateValue?.(value);
    },
    (error) => {
      if (finish()) reject(error);
    },
  );
  return promise;
}

function finiteTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toWireSession(summary: OmpSessionSummaryInput): SessionV1 {
  const startedAt = finiteTimestamp(summary.startedAt);
  const lastActiveAt = finiteTimestamp(summary.lastActiveAt);
  if (!startedAt || !lastActiveAt) throw new RuntimeCollectorDaemonError("invalid_session_time");
  const tokens: NonNullable<SessionV1["tokens"]> = {};
  if (summary.inputTokens != null) tokens.input = summary.inputTokens;
  if (summary.outputTokens != null) tokens.output = summary.outputTokens;
  if (summary.cacheReadTokens != null || summary.cacheWriteTokens != null) {
    const cache = (summary.cacheReadTokens ?? 0) + (summary.cacheWriteTokens ?? 0);
    if (!Number.isSafeInteger(cache)) throw new RuntimeCollectorDaemonError("invalid_session_tokens");
    tokens.cache = cache;
  }
  if (summary.reasoningTokens != null) tokens.reasoning = summary.reasoningTokens;

  const session: SessionV1 = {
    session_id: summary.sessionId,
    state: summary.status === "active" ? "active" : "closed",
    started_at_ms: startedAt,
    last_active_at_ms: lastActiveAt,
  };
  const closedAt = finiteTimestamp(summary.closedAt ?? summary.endedAt);
  if (session.state === "closed") {
    if (!closedAt) throw new RuntimeCollectorDaemonError("missing_closed_time");
    session.closed_at_ms = closedAt;
  }
  const wireProvider = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  if (summary.provider && wireProvider.test(summary.provider)) session.provider = summary.provider;
  if (summary.model && isCollectorModelIdentifierV1(summary.model)) session.model = summary.model;
  if (Object.keys(tokens).length > 0) session.tokens = tokens;
  if (summary.costMicros != null && summary.costTrust !== "unknown") {
    session.estimated_cost = { currency: "USD", micros: summary.costMicros };
  }
  if (summary.contextBps != null) session.context_utilization_bps = summary.contextBps;
  return session;
}

function collectionErrorCategory(error: unknown): CollectionErrorCategory {
  if (error instanceof OmpSchemaValidationError) return "unsupported_schema";
  if (error instanceof OmpDatabaseOpenError || error instanceof OmpQueryExecutionError) return "source_unavailable";
  if (error instanceof OmpInvalidDataError) return "internal";
  return "internal";
}

export class RuntimeCollectorDaemon {
  private readonly options: RuntimeCollectorDaemonOptions;
  private readonly clock: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => RuntimeCollectorTimerHandle;
  private readonly clearScheduledTimeout: (handle: RuntimeCollectorTimerHandle) => void;
  private queue: CollectorQueue | null = null;
  private timer: RuntimeCollectorTimerHandle | null = null;
  private activeCycle: AbortController | null = null;
  private cycleInFlight = false;
  private started = false;

  constructor(options: RuntimeCollectorDaemonOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => Date.now());
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? ((handle) => clearTimeout(handle));
    if (options.config.endpointUrl !== REGISTERED_COLLECTOR_ENDPOINT) {
      throw new RuntimeCollectorDaemonError("invalid_endpoint");
    }
  }

  async runOnce(): Promise<RuntimeCollectorCycleResult> {
    const { config } = this.options;
    if (!config.enabled) {
      this.options.logCategory?.("cycle_skipped");
      return { status: "disabled", queuedBatches: 0, queuedSessions: 0, drain: null };
    }
    if (this.cycleInFlight) {
      this.options.logCategory?.("cycle_skipped");
      return { status: "completed", queuedBatches: 0, queuedSessions: 0, drain: null };
    }

    this.cycleInFlight = true;
    const cycle = new AbortController();
    this.activeCycle = cycle;
    const deadline = this.scheduleTimeout(() => cycle.abort(), config.cycleTimeoutMs);
    let identityKey: Buffer | null = null;
    let loadedIdentityKey: Uint8Array | null = null;
    try {
      const queue = await this.getQueue(cycle.signal);
      const stats = await awaitAbortable(queue.getStats(), cycle.signal);
      if (stats.isHalted) {
        this.options.logCategory?.("queue_halted");
        return { status: "halted", queuedBatches: 0, queuedSessions: 0, drain: { status: "halted" } };
      }

      loadedIdentityKey = await awaitAbortable(
        Promise.resolve(this.options.loadSessionIdentityKey(config.sessionIdentityKeyId!, cycle.signal)),
        cycle.signal,
        (lateKey) => lateKey.fill(0),
      );
      if (!(loadedIdentityKey instanceof Uint8Array) || loadedIdentityKey.byteLength !== 32) {
        throw new RuntimeCollectorDaemonError("invalid_identity_key");
      }
      identityKey = Buffer.from(loadedIdentityKey);
      loadedIdentityKey.fill(0);
      loadedIdentityKey = null;
      cycle.signal.throwIfAborted();

      let cursor: string | null = null;
      let queuedBatches = 0;
      let queuedSessions = 0;
      let collectionFailure: CollectionErrorCategory | null = null;
      do {
        cycle.signal.throwIfAborted();
        let page: OmpSessionPageResult;
        try {
          page = collectOmpSessionPage({
            dbPath: config.ompStatsDbPath!,
            hmacKey: identityKey,
            hostId: config.hostId!,
            writerVersion: config.writerVersion,
            allowedProviders: config.allowedProviders,
            allowedModels: config.allowedModels,
            sessionLimit: Math.min(config.sessionLimit, MAX_SESSIONS),
            maxMessagesPerSession: config.maxMessagesPerSession,
            cursor,
            now: this.clock,
          });
        } catch (error) {
          collectionFailure = collectionErrorCategory(error);
          break;
        }
        const available = page.summaries.filter(
          (summary) => summary.status !== "unknown",
        );
        if (available.length !== page.summaries.length) collectionFailure = "internal";
        if (available.length > 0) {
          cycle.signal.throwIfAborted();
          await this.enqueueBatch(queue, available, null, cycle.signal);
          queuedBatches++;
          queuedSessions += available.length;
        }
        cursor = page.nextCursor;
      } while (cursor);

      if (collectionFailure) {
        cycle.signal.throwIfAborted();
        await this.enqueueBatch(queue, [], collectionFailure, cycle.signal);
        queuedBatches++;
        this.options.logCategory?.("collection_failed");
      }

      const uploadOptions: CollectorUploadOptions = {
        endpointUrl: config.endpointUrl,
        hostId: config.hostId!,
        keyId: config.keyId!,
        loadKey: (identity, uploadSignal) => {
          const combined = AbortSignal.any([uploadSignal, cycle.signal]);
          return awaitAbortable(
            Promise.resolve(this.options.loadKey(identity, combined)),
            combined,
            (lateKey) => lateKey.fill(0),
          );
        },
      };
      const upload = this.options.upload ?? uploadQueuedBatch;
      const drain = await awaitAbortable(
        queue.drainStep((batch) => upload(uploadOptions, batch)),
        cycle.signal,
      );
      cycle.signal.throwIfAborted();
      if (drain.status === "conflict_halted" || drain.status === "halted") {
        this.options.logCategory?.("queue_halted");
        return { status: "halted", queuedBatches, queuedSessions, drain };
      }
      if (["auth_backoff", "retry_backoff", "rate_limited"].includes(drain.status)) {
        this.options.logCategory?.("upload_deferred");
      } else {
        this.options.logCategory?.("cycle_ok");
      }
      return { status: collectionFailure ? "collection_error" : "completed", queuedBatches, queuedSessions, drain };
    } catch (error) {
      if (cycle.signal.aborted) throw new RuntimeCollectorDaemonError("cycle_timeout");
      throw error;
    } finally {
      this.clearScheduledTimeout(deadline);
      cycle.abort();
      identityKey?.fill(0);
      loadedIdentityKey?.fill(0);
      this.activeCycle = null;
      this.cycleInFlight = false;
    }
  }

  start(): void {
    if (!this.options.config.enabled || this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    this.activeCycle?.abort();
    if (this.timer) this.clearScheduledTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.started || this.timer) return;
    // Recursive scheduling prevents overlap; jitter is strictly bounded to ±10%.
    const candidate = this.options.jitter?.() ?? Math.random();
    const sample = Number.isFinite(candidate) ? Math.min(1, Math.max(0, candidate)) : 0.5;
    const delay = Math.max(1, Math.round(this.options.config.intervalMs * (0.9 + sample * 0.2)));
    this.timer = this.scheduleTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch(() => this.options.logCategory?.("collection_failed"))
        .finally(() => this.scheduleNext());
    }, delay);
  }

  private async getQueue(signal: AbortSignal): Promise<CollectorQueue> {
    if (!this.queue) {
      const factory = this.options.queueFactory ?? ((queueDir: string) => new CollectorQueue({ queueDir }));
      this.queue = factory(this.options.config.queueDir!);
      await awaitAbortable(this.queue.init(), signal);
    }
    return this.queue;
  }

  private async enqueueBatch(
    queue: CollectorQueue,
    summaries: OmpSessionSummaryInput[],
    errorCategory: CollectionErrorCategory | null,
    signal: AbortSignal,
  ): Promise<void> {
    const stats = await awaitAbortable(queue.getStats(), signal);
    const collectedAt = this.clock();
    const batch: SessionBatchV1 = {
      schema: SESSION_BATCH_SCHEMA_ID,
      batch_id: randomUUID(),
      collected_at_ms: collectedAt,
      collector_version: this.options.config.collectorVersion,
      omp_version: this.options.config.writerVersion,
      collection_status: errorCategory ? "error" : "ok",
      queue_dropped_total: stats.droppedTotal,
      sessions: summaries.map(toWireSession),
    };
    if (errorCategory) batch.error_category = errorCategory;
    const validated = validateDecodedSessionBatchV1(batch, collectedAt);
    await awaitAbortable(
      queue.enqueue({ batchId: validated.batch_id, body: JSON.stringify(validated), enqueuedAtMs: collectedAt }),
      signal,
    );
  }
}
