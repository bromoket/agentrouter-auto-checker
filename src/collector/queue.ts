import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const QUEUE_LIMITS = Object.freeze({
  MAX_RETENTION_MS: 72 * 60 * 60 * 1000,
  MAX_TOTAL_BYTES: 32 * 1024 * 1024,
  MAX_BATCHES: 256,
  MAX_BATCH_BYTES: 262_144,
  MAX_SESSIONS: 128,
  MIN_DRAIN_INTERVAL_MS: 2_000,
  MIN_BACKOFF_MS: 5_000,
  MAX_BACKOFF_MS: 300_000,
  AUTH_BACKOFF_MS: 900_000,
} as const);

export const MAX_RETENTION_MS = QUEUE_LIMITS.MAX_RETENTION_MS;
export const MAX_TOTAL_BYTES = QUEUE_LIMITS.MAX_TOTAL_BYTES;
export const MAX_BATCHES = QUEUE_LIMITS.MAX_BATCHES;
export const MAX_BATCH_BYTES = QUEUE_LIMITS.MAX_BATCH_BYTES;
export const MAX_SESSIONS = QUEUE_LIMITS.MAX_SESSIONS;
export const MIN_DRAIN_INTERVAL_MS = QUEUE_LIMITS.MIN_DRAIN_INTERVAL_MS;
export const MIN_BACKOFF_MS = QUEUE_LIMITS.MIN_BACKOFF_MS;
export const MAX_BACKOFF_MS = QUEUE_LIMITS.MAX_BACKOFF_MS;
export const AUTH_BACKOFF_MS = QUEUE_LIMITS.AUTH_BACKOFF_MS;

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_PRIMARY = "state.json";
const STATE_BACKUP = "state.backup.json";

export function isValidUuidV4(id: string): boolean {
  return typeof id === "string" && UUID_V4_REGEX.test(id);
}

export function computeSha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export class QueueError extends Error {
  readonly code: string;
  readonly category: string;

  constructor(code: string, category = "queue_error") {
    super(code);
    this.name = "QueueError";
    this.code = code;
    this.category = category;
    this.stack = undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SymlinkError extends QueueError {
  constructor() {
    super("SYMLINK_REJECTED", "security_violation");
    this.name = "SymlinkError";
  }
}

export class BatchSizeError extends QueueError {
  constructor() {
    super("BATCH_TOO_LARGE", "payload_size_error");
    this.name = "BatchSizeError";
  }
}

export class QueueHaltedError extends QueueError {
  constructor() {
    super("QUEUE_HALTED", "conflict_halt");
    this.name = "QueueHaltedError";
  }
}

export interface QueuedBatch {
  readonly batchId: string;
  readonly body: string;
  readonly bodyBytes: Uint8Array;
  readonly contentLength: number;
  readonly bodySha256: string;
  readonly enqueuedAtMs: number;
}

export interface QueuedBatchFilePayload {
  readonly version: 1;
  readonly batchId: string;
  readonly enqueuedAtMs: number;
  readonly bodySha256: string;
  readonly body: string;
}

export interface QueueState {
  readonly version: 1;
  queueDroppedTotal: number;
  isHalted: boolean;
}

interface StoredQueueState extends QueueState {
  readonly generation: number;
  readonly checksum: string;
}

export type UploadDisposition =
  | "accepted"
  | "duplicate"
  | "retry"
  | "auth"
  | "poison"
  | "conflict-halt";

export interface UploadResult {
  disposition: UploadDisposition;
  status?: number;
  category?: string;
  retryAfterSeconds?: number;
  accepted?: number;
  ignoredStale?: number;
}

export type BatchUploader = (batch: QueuedBatch) => Promise<UploadResult>;

export type DrainStepResult =
  | { status: "empty" }
  | { status: "halted" }
  | { status: "in_flight" }
  | { status: "rate_limited"; waitMs: number }
  | { status: "acknowledged"; batchId: string; disposition: "accepted" | "duplicate" }
  | { status: "poison_dropped"; batchId: string; category?: string }
  | { status: "conflict_halted"; batchId: string }
  | { status: "auth_backoff"; batchId: string; backoffMs: number }
  | { status: "retry_backoff"; batchId: string; backoffMs: number; consecutiveRetries: number };

export interface DrainSummary {
  stepsExecuted: number;
  acknowledgedCount: number;
  poisonDroppedCount: number;
  halted: boolean;
  empty: boolean;
}

export interface QueueOptions {
  queueDir: string;
  maxRetentionMs?: number;
  maxTotalBytes?: number;
  maxBatches?: number;
  maxBatchBytes?: number;
  minDrainIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  authBackoffMs?: number;
  jitterFn?: (baseDelayMs: number) => number;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface EnqueueInput {
  batchId?: string;
  body: string | Uint8Array;
  enqueuedAtMs?: number;
}

export interface QueueStats {
  count: number;
  totalBytes: number;
  droppedTotal: number;
  isHalted: boolean;
  oldestEnqueuedAtMs: number | null;
  newestEnqueuedAtMs: number | null;
}

interface BatchFileEntry {
  filename: string;
  fullPath: string;
  enqueuedAtMs: number;
  batchId: string;
  fileSizeBytes: number;
}

function boundedOption(value: number | undefined, fallback: number, hardMaximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new QueueError("INVALID_CONFIG", "configuration_error");
  }
  return Math.min(value, hardMaximum);
}

function defaultFullJitter(baseDelayMs: number): number {
  return Math.floor(Math.random() * (baseDelayMs + 1));
}

function stateChecksum(state: Omit<StoredQueueState, "checksum">): string {
  return computeSha256Hex(
    `1\n${state.generation}\n${state.queueDroppedTotal}\n${state.isHalted ? 1 : 0}\n`
  );
}

function decodeState(raw: string): StoredQueueState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== 1 ||
      !Number.isSafeInteger(candidate.generation) ||
      (candidate.generation as number) < 0 ||
      !Number.isSafeInteger(candidate.queueDroppedTotal) ||
      (candidate.queueDroppedTotal as number) < 0 ||
      typeof candidate.isHalted !== "boolean" ||
      typeof candidate.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.checksum)
    ) {
      return null;
    }
    const withoutChecksum = {
      version: 1 as const,
      generation: candidate.generation as number,
      queueDroppedTotal: candidate.queueDroppedTotal as number,
      isHalted: candidate.isHalted,
    };
    const expected = Buffer.from(stateChecksum(withoutChecksum), "hex");
    const actual = Buffer.from(candidate.checksum, "hex");
    if (!timingSafeEqual(expected, actual)) return null;
    return { ...withoutChecksum, checksum: candidate.checksum };
  } catch {
    return null;
  }
}

export class CollectorQueue {
  readonly queueDir: string;
  readonly maxRetentionMs: number;
  readonly maxTotalBytes: number;
  readonly maxBatches: number;
  readonly maxBatchBytes: number;
  readonly minDrainIntervalMs: number;
  readonly minBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly authBackoffMs: number;

  private readonly jitterFn: (baseDelayMs: number) => number;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private state: QueueState = { version: 1, queueDroppedTotal: 0, isHalted: false };
  private stateGeneration = 0;
  private inFlight = false;
  private consecutiveRetries = 0;
  private nextDrainAllowedAt = 0;

  constructor(options: QueueOptions) {
    if (!options.queueDir || typeof options.queueDir !== "string") {
      throw new QueueError("INVALID_CONFIG", "configuration_error");
    }
    this.queueDir = path.resolve(options.queueDir);
    this.maxRetentionMs = boundedOption(
      options.maxRetentionMs,
      QUEUE_LIMITS.MAX_RETENTION_MS,
      QUEUE_LIMITS.MAX_RETENTION_MS
    );
    this.maxTotalBytes = boundedOption(
      options.maxTotalBytes,
      QUEUE_LIMITS.MAX_TOTAL_BYTES,
      QUEUE_LIMITS.MAX_TOTAL_BYTES
    );
    this.maxBatches = boundedOption(
      options.maxBatches,
      QUEUE_LIMITS.MAX_BATCHES,
      QUEUE_LIMITS.MAX_BATCHES
    );
    this.maxBatchBytes = boundedOption(
      options.maxBatchBytes,
      QUEUE_LIMITS.MAX_BATCH_BYTES,
      QUEUE_LIMITS.MAX_BATCH_BYTES
    );
    this.minDrainIntervalMs = Math.max(
      boundedOption(
        options.minDrainIntervalMs,
        QUEUE_LIMITS.MIN_DRAIN_INTERVAL_MS,
        QUEUE_LIMITS.MIN_DRAIN_INTERVAL_MS
      ),
      QUEUE_LIMITS.MIN_DRAIN_INTERVAL_MS
    );
    this.minBackoffMs = Math.max(
      boundedOption(
        options.minBackoffMs,
        QUEUE_LIMITS.MIN_BACKOFF_MS,
        QUEUE_LIMITS.MIN_BACKOFF_MS
      ),
      QUEUE_LIMITS.MIN_BACKOFF_MS
    );
    this.maxBackoffMs = boundedOption(
      options.maxBackoffMs,
      QUEUE_LIMITS.MAX_BACKOFF_MS,
      QUEUE_LIMITS.MAX_BACKOFF_MS
    );
    this.authBackoffMs = Math.max(
      boundedOption(
        options.authBackoffMs,
        QUEUE_LIMITS.AUTH_BACKOFF_MS,
        QUEUE_LIMITS.AUTH_BACKOFF_MS
      ),
      QUEUE_LIMITS.AUTH_BACKOFF_MS
    );
    if (this.maxBackoffMs < this.minBackoffMs) {
      throw new QueueError("INVALID_CONFIG", "configuration_error");
    }
    this.jitterFn = options.jitterFn ?? defaultFullJitter;
    this.clock = options.clock ?? Date.now;
    this.sleepFn =
      options.sleepFn ??
      ((ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });

    this.ensureQueueDir();
    this.cleanupCrashArtifacts();
    this.loadState();
    Object.defineProperties(this, {
      queueDir: { writable: false },
      maxRetentionMs: { writable: false },
      maxTotalBytes: { writable: false },
      maxBatches: { writable: false },
      maxBatchBytes: { writable: false },
      minDrainIntervalMs: { writable: false },
      minBackoffMs: { writable: false },
      maxBackoffMs: { writable: false },
      authBackoffMs: { writable: false },
    });
  }

  async init(): Promise<void> {
    this.ensureQueueDir();
    this.cleanupCrashArtifacts();
    this.loadState();
  }

  private fsFailure(code: string): QueueError {
    return new QueueError(code, "filesystem_error");
  }

  private checkSymlink(targetPath: string): void {
    try {
      if (fs.lstatSync(targetPath).isSymbolicLink()) throw new SymlinkError();
    } catch (error) {
      if (error instanceof QueueError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw this.fsFailure("QUEUE_STAT_FAILED");
      }
    }
  }

  private ensureQueueDir(): void {
    try {
      this.checkSymlink(this.queueDir);
      if (!fs.existsSync(this.queueDir)) {
        fs.mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });
      }
      const stat = fs.statSync(this.queueDir);
      if (!stat.isDirectory()) throw new QueueError("INVALID_QUEUE_DIR", "configuration_error");
      fs.chmodSync(this.queueDir, 0o700);
    } catch (error) {
      if (error instanceof QueueError) throw error;
      throw this.fsFailure("QUEUE_DIRECTORY_FAILED");
    }
  }

  private syncDirectory(directory: string): void {
    let directoryFd: number | null = null;
    try {
      directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryFd);
      fs.closeSync(directoryFd);
    } catch (error) {
      if (directoryFd !== null) {
        try {
          fs.closeSync(directoryFd);
        } catch {}
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform === "win32" &&
        (code === "EACCES" || code === "EPERM" || code === "EISDIR" || code === "EINVAL")
      ) {
        // Win32 does not expose a directory handle suitable for fsync through node:fs.
        // The rename still uses the same-volume atomic filesystem primitive.
        return;
      }
      throw this.fsFailure("QUEUE_DIRECTORY_SYNC_FAILED");
    }
  }

  private writeAtomic(targetPath: string, content: string | Uint8Array): void {
    this.ensureQueueDir();
    this.checkSymlink(targetPath);
    const directory = path.dirname(targetPath);
    const tempPath = path.join(
      directory,
      `.tmp_${randomBytes(16).toString("hex")}.tmp`
    );
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600
      );
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      let offset = 0;
      while (offset < buffer.byteLength) {
        offset += fs.writeSync(fd, buffer, offset, buffer.byteLength - offset, offset);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.chmodSync(tempPath, 0o600);
      fs.renameSync(tempPath, targetPath);
      this.syncDirectory(directory);
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      try {
        fs.unlinkSync(tempPath);
      } catch {}
      if (error instanceof QueueError) throw error;
      throw this.fsFailure("QUEUE_ATOMIC_WRITE_FAILED");
    }
  }

  private removeFile(targetPath: string, errorCode: string): void {
    this.checkSymlink(targetPath);
    try {
      fs.unlinkSync(targetPath);
      this.syncDirectory(path.dirname(targetPath));
    } catch (error) {
      if (error instanceof QueueError) throw error;
      throw this.fsFailure(errorCode);
    }
  }

  private cleanupCrashArtifacts(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.queueDir, { withFileTypes: true });
    } catch {
      throw this.fsFailure("QUEUE_SCAN_FAILED");
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new SymlinkError();
      if (entry.name.startsWith(".tmp_") && entry.name.endsWith(".tmp")) {
        this.removeFile(path.join(this.queueDir, entry.name), "QUEUE_TEMP_CLEANUP_FAILED");
      }
    }
  }

  private statePath(filename: string): string {
    return path.join(this.queueDir, filename);
  }

  private readStateCopy(filename: string): { exists: boolean; state: StoredQueueState | null } {
    const target = this.statePath(filename);
    this.checkSymlink(target);
    try {
      return { exists: true, state: decodeState(fs.readFileSync(target, "utf8")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, state: null };
      throw this.fsFailure("QUEUE_STATE_READ_FAILED");
    }
  }

  private encodeState(state: QueueState, generation: number): string {
    const withoutChecksum = { ...state, generation };
    return JSON.stringify({ ...withoutChecksum, checksum: stateChecksum(withoutChecksum) });
  }

  private loadState(): void {
    const primary = this.readStateCopy(STATE_PRIMARY);
    const backup = this.readStateCopy(STATE_BACKUP);
    if (!primary.exists && !backup.exists) {
      this.state = { version: 1, queueDroppedTotal: 0, isHalted: false };
      this.stateGeneration = 0;
      this.persistState(this.state);
      return;
    }
    const valid = [primary.state, backup.state].filter(
      (candidate): candidate is StoredQueueState => candidate !== null
    );
    if (valid.length === 0) {
      throw new QueueError("STATE_REPAIR_REQUIRED", "operator_repair");
    }
    valid.sort((left, right) => right.generation - left.generation);
    const selected = valid[0];
    const sameGeneration = valid.find(
      (candidate) =>
        candidate !== selected &&
        candidate.generation === selected.generation &&
        candidate.checksum !== selected.checksum
    );
    if (sameGeneration) {
      throw new QueueError("STATE_REPAIR_REQUIRED", "operator_repair");
    }
    this.state = {
      version: 1,
      queueDroppedTotal: selected.queueDroppedTotal,
      isHalted: selected.isHalted,
    };
    this.stateGeneration = selected.generation;
    if (
      !primary.state ||
      !backup.state ||
      primary.state.checksum !== selected.checksum ||
      backup.state.checksum !== selected.checksum
    ) {
      const encoded = this.encodeState(this.state, this.stateGeneration);
      this.writeAtomic(this.statePath(STATE_BACKUP), encoded);
      this.writeAtomic(this.statePath(STATE_PRIMARY), encoded);
    }
  }

  private persistState(next: QueueState): void {
    const generation = this.stateGeneration + 1;
    const encoded = this.encodeState(next, generation);
    this.writeAtomic(this.statePath(STATE_BACKUP), encoded);
    this.state = { ...next };
    this.stateGeneration = generation;
    this.writeAtomic(this.statePath(STATE_PRIMARY), encoded);
  }

  private incrementDropped(count = 1): void {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const next = this.state.queueDroppedTotal + count;
    if (!Number.isSafeInteger(next)) {
      throw new QueueError("DROPPED_COUNTER_EXHAUSTED", "operator_repair");
    }
    this.persistState({ ...this.state, queueDroppedTotal: next });
  }

  private listBatchEntries(): BatchFileEntry[] {
    this.ensureQueueDir();
    let names: string[];
    try {
      names = fs.readdirSync(this.queueDir);
    } catch {
      throw this.fsFailure("QUEUE_SCAN_FAILED");
    }
    const results: BatchFileEntry[] = [];
    for (const name of names) {
      if (name === STATE_PRIMARY || name === STATE_BACKUP) continue;
      const fullPath = path.join(this.queueDir, name);
      this.checkSymlink(fullPath);
      if (name.startsWith(".tmp_") && name.endsWith(".tmp")) {
        this.removeFile(fullPath, "QUEUE_TEMP_CLEANUP_FAILED");
        continue;
      }
      const match = /^(\d{16})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.batch$/.exec(
        name
      );
      if (!match) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw this.fsFailure("QUEUE_ENTRY_INVALID");
        results.push({
          filename: name,
          fullPath,
          enqueuedAtMs: Number.parseInt(match[1], 10),
          batchId: match[2],
          fileSizeBytes: stat.size,
        });
      } catch (error) {
        if (error instanceof QueueError) throw error;
        throw this.fsFailure("QUEUE_STAT_FAILED");
      }
    }
    results.sort(
      (left, right) =>
        left.enqueuedAtMs - right.enqueuedAtMs || left.batchId.localeCompare(right.batchId)
    );
    return results;
  }

  private readBatchFile(filePath: string): QueuedBatch | null {
    this.checkSymlink(filePath);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      throw this.fsFailure("QUEUE_READ_FAILED");
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error();
      const item = parsed as Record<string, unknown>;
      if (
        item.version !== 1 ||
        typeof item.batchId !== "string" ||
        !isValidUuidV4(item.batchId) ||
        !Number.isSafeInteger(item.enqueuedAtMs) ||
        typeof item.bodySha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(item.bodySha256) ||
        typeof item.body !== "string"
      ) {
        throw new Error();
      }
      const bodyBytes = Buffer.from(item.body, "utf8");
      if (
        bodyBytes.byteLength > this.maxBatchBytes ||
        computeSha256Hex(bodyBytes) !== item.bodySha256
      ) {
        throw new Error();
      }
      return Object.freeze({
        batchId: item.batchId,
        body: item.body,
        bodyBytes: new Uint8Array(bodyBytes),
        contentLength: bodyBytes.byteLength,
        bodySha256: item.bodySha256,
        enqueuedAtMs: item.enqueuedAtMs as number,
      });
    } catch {
      this.removeFile(filePath, "QUEUE_CORRUPT_DELETE_FAILED");
      this.incrementDropped();
      return null;
    }
  }

  private purgeExpiredBatches(now: number): void {
    for (const entry of this.listBatchEntries()) {
      if (now - entry.enqueuedAtMs > this.maxRetentionMs) {
        this.removeFile(entry.fullPath, "QUEUE_EVICTION_FAILED");
        this.incrementDropped();
      }
    }
  }

  async enqueue(input: EnqueueInput): Promise<QueuedBatch> {
    let body: string;
    let bodyBytes: Uint8Array;
    try {
      if (typeof input.body === "string") {
        body = input.body;
        bodyBytes = Buffer.from(body, "utf8");
      } else {
        bodyBytes = new Uint8Array(input.body);
        body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
        if (!Buffer.from(body, "utf8").equals(Buffer.from(bodyBytes))) throw new Error();
      }
    } catch {
      throw new QueueError("INVALID_BODY_ENCODING", "payload_error");
    }
    if (bodyBytes.byteLength > this.maxBatchBytes) throw new BatchSizeError();

    const batchId = input.batchId ?? randomUUID();
    if (!isValidUuidV4(batchId)) {
      throw new QueueError("INVALID_BATCH_ID", "payload_error");
    }
    const now = this.clock();
    const enqueuedAtMs = input.enqueuedAtMs ?? now;
    if (!Number.isSafeInteger(enqueuedAtMs) || enqueuedAtMs < 0) {
      throw new QueueError("INVALID_ENQUEUED_AT", "payload_error");
    }
    const bodySha256 = computeSha256Hex(bodyBytes);
    const payload: QueuedBatchFilePayload = {
      version: 1,
      batchId,
      enqueuedAtMs,
      bodySha256,
      body,
    };
    const payloadJson = JSON.stringify(payload);
    const payloadFileSizeBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadFileSizeBytes > this.maxTotalBytes) {
      throw new QueueError("BATCH_EXCEEDS_QUEUE_LIMIT", "capacity_error");
    }

    this.purgeExpiredBatches(now);
    const entries = this.listBatchEntries();
    let currentTotalBytes = entries.reduce((sum, entry) => sum + entry.fileSizeBytes, 0);
    while (
      entries.length + 1 > this.maxBatches ||
      currentTotalBytes + payloadFileSizeBytes > this.maxTotalBytes
    ) {
      const oldest = entries.shift();
      if (!oldest) throw new QueueError("QUEUE_CAPACITY_INVALID", "operator_repair");
      this.removeFile(oldest.fullPath, "QUEUE_EVICTION_FAILED");
      currentTotalBytes -= oldest.fileSizeBytes;
      this.incrementDropped();
    }

    const targetPath = path.join(
      this.queueDir,
      `${enqueuedAtMs.toString().padStart(16, "0")}_${batchId}.batch`
    );
    try {
      if (fs.existsSync(targetPath)) {
        throw new QueueError("DUPLICATE_BATCH_ID", "payload_error");
      }
    } catch (error) {
      if (error instanceof QueueError) throw error;
      throw this.fsFailure("QUEUE_STAT_FAILED");
    }
    this.writeAtomic(targetPath, payloadJson);
    return Object.freeze({
      batchId,
      body,
      bodyBytes: new Uint8Array(bodyBytes),
      contentLength: bodyBytes.byteLength,
      bodySha256,
      enqueuedAtMs,
    });
  }

  async peek(): Promise<QueuedBatch | null> {
    this.purgeExpiredBatches(this.clock());
    for (const entry of this.listBatchEntries()) {
      const batch = this.readBatchFile(entry.fullPath);
      if (batch) return batch;
    }
    return null;
  }

  async size(): Promise<number> {
    this.purgeExpiredBatches(this.clock());
    return this.listBatchEntries().length;
  }

  async totalBytes(): Promise<number> {
    this.purgeExpiredBatches(this.clock());
    return this.listBatchEntries().reduce((sum, entry) => sum + entry.fileSizeBytes, 0);
  }

  getDroppedTotal(): number {
    return this.state.queueDroppedTotal;
  }

  isHalted(): boolean {
    return this.state.isHalted;
  }

  unhalt(): void {
    this.persistState({ ...this.state, isHalted: false });
  }

  resetRetries(): void {
    this.consecutiveRetries = 0;
    this.nextDrainAllowedAt = 0;
  }

  async getStats(): Promise<QueueStats> {
    this.purgeExpiredBatches(this.clock());
    const entries = this.listBatchEntries();
    return {
      count: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.fileSizeBytes, 0),
      droppedTotal: this.state.queueDroppedTotal,
      isHalted: this.state.isHalted,
      oldestEnqueuedAtMs: entries[0]?.enqueuedAtMs ?? null,
      newestEnqueuedAtMs: entries.at(-1)?.enqueuedAtMs ?? null,
    };
  }

  async drainStep(uploader: BatchUploader): Promise<DrainStepResult> {
    if (this.state.isHalted) return { status: "halted" };
    if (this.inFlight) return { status: "in_flight" };
    const now = this.clock();
    if (now < this.nextDrainAllowedAt) {
      return { status: "rate_limited", waitMs: this.nextDrainAllowedAt - now };
    }

    this.inFlight = true;
    try {
      this.purgeExpiredBatches(now);
      let batch: QueuedBatch | null = null;
      let entry: BatchFileEntry | null = null;
      for (const candidate of this.listBatchEntries()) {
        const read = this.readBatchFile(candidate.fullPath);
        if (read) {
          batch = read;
          entry = candidate;
          break;
        }
      }
      if (!batch || !entry) return { status: "empty" };

      let result: UploadResult;
      try {
        result = await uploader(batch);
      } catch {
        result = { disposition: "retry" };
      }
      const completedAt = this.clock();
      switch (result.disposition) {
        case "accepted":
        case "duplicate":
          this.removeFile(entry.fullPath, "QUEUE_ACK_DELETE_FAILED");
          this.consecutiveRetries = 0;
          this.nextDrainAllowedAt = completedAt + this.minDrainIntervalMs;
          return {
            status: "acknowledged",
            batchId: batch.batchId,
            disposition: result.disposition,
          };
        case "poison":
          this.removeFile(entry.fullPath, "QUEUE_POISON_DELETE_FAILED");
          this.incrementDropped();
          this.consecutiveRetries = 0;
          this.nextDrainAllowedAt = completedAt + this.minDrainIntervalMs;
          return {
            status: "poison_dropped",
            batchId: batch.batchId,
            category: result.category,
          };
        case "conflict-halt":
          this.persistState({ ...this.state, isHalted: true });
          return { status: "conflict_halted", batchId: batch.batchId };
        case "auth":
          this.nextDrainAllowedAt = completedAt + this.authBackoffMs;
          return {
            status: "auth_backoff",
            batchId: batch.batchId,
            backoffMs: this.authBackoffMs,
          };
        case "retry":
        default: {
          this.consecutiveRetries++;
          const exponent = Math.min(this.consecutiveRetries - 1, 30);
          const baseDelay = Math.min(
            this.maxBackoffMs,
            this.minBackoffMs * 2 ** exponent
          );
          const suppliedJitter = this.jitterFn(baseDelay);
          const jittered = Number.isFinite(suppliedJitter)
            ? Math.max(0, Math.min(baseDelay, Math.floor(suppliedJitter)))
            : 0;
          let backoffMs = Math.max(this.minBackoffMs, jittered);
          if (Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds! > 0) {
            backoffMs = Math.max(backoffMs, Math.floor(result.retryAfterSeconds! * 1_000));
          }
          backoffMs = Math.min(this.maxBackoffMs, backoffMs);
          this.nextDrainAllowedAt = completedAt + backoffMs;
          return {
            status: "retry_backoff",
            batchId: batch.batchId,
            backoffMs,
            consecutiveRetries: this.consecutiveRetries,
          };
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async drain(
    uploader: BatchUploader,
    options: { maxSteps?: number; signal?: AbortSignal } = {}
  ): Promise<DrainSummary> {
    let stepsExecuted = 0;
    let acknowledgedCount = 0;
    let poisonDroppedCount = 0;
    const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
    while (stepsExecuted < maxSteps && !options.signal?.aborted) {
      const step = await this.drainStep(uploader);
      stepsExecuted++;
      if (step.status === "empty" || step.status === "halted" || step.status === "in_flight") {
        return {
          stepsExecuted,
          acknowledgedCount,
          poisonDroppedCount,
          halted: step.status === "halted",
          empty: step.status === "empty",
        };
      }
      if (step.status === "rate_limited") {
        await this.sleepFn(step.waitMs);
      } else if (step.status === "acknowledged") {
        acknowledgedCount++;
      } else if (step.status === "poison_dropped") {
        poisonDroppedCount++;
      } else if (step.status === "conflict_halted") {
        return {
          stepsExecuted,
          acknowledgedCount,
          poisonDroppedCount,
          halted: true,
          empty: false,
        };
      } else {
        return {
          stepsExecuted,
          acknowledgedCount,
          poisonDroppedCount,
          halted: false,
          empty: false,
        };
      }
    }
    return {
      stepsExecuted,
      acknowledgedCount,
      poisonDroppedCount,
      halted: this.state.isHalted,
      empty: (await this.size()) === 0,
    };
  }

  async clear(): Promise<void> {
    const droppedBeforeClear = this.state.queueDroppedTotal;
    for (const entry of this.listBatchEntries()) {
      this.removeFile(entry.fullPath, "QUEUE_CLEAR_FAILED");
    }
    this.persistState({
      version: 1,
      queueDroppedTotal: droppedBeforeClear,
      isHalted: false,
    });
    this.consecutiveRetries = 0;
    this.nextDrainAllowedAt = 0;
  }
}
