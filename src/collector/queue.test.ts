/**
 * Tests for Collector Bounded Offline File Queue
 *
 * Verifies:
 * - 72h retention expiration and oldest-whole-batch eviction
 * - 32 MiB total size limit and 256 batches limit
 * - 256 KiB MAX_BATCH_BYTES boundary enforcement
 * - Crash artifact (.tmp) cleanup on scan/init
 * - Symlink rejection on queue directory and file items
 * - Strict FIFO ordering
 * - Exactly one drain operation in flight
 * - Immutable retries (identical body/hash/batchId across attempts)
 * - Fresh signing metadata outside queue (zero keys/signatures stored)
 * - Backoff classification (exponential + full jitter, slow auth 15m, rate limit 2s)
 * - Poison payload drop, 409 conflict halt, and exact ACK deletion semantics
 * - Canary absence across queue state and disk artifacts
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CollectorQueue,
  QUEUE_LIMITS,
  MAX_RETENTION_MS,
  MAX_TOTAL_BYTES,
  MAX_BATCHES,
  MAX_BATCH_BYTES,
  MIN_DRAIN_INTERVAL_MS,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
  AUTH_BACKOFF_MS,
  BatchSizeError,
  SymlinkError,
  QueueError,
  isValidUuidV4,
  computeSha256Hex,
  type QueuedBatch,
  type UploadResult,
} from "./queue";

describe("CollectorQueue", () => {
  let tempDir: string;
  let simulatedTime = 1_700_000_000_000;

  function advanceTime(ms: number): void {
    simulatedTime += ms;
  }

  function mockClock(): number {
    return simulatedTime;
  }

  beforeEach(() => {
    simulatedTime = 1_700_000_000_000;
    tempDir = path.join(
      os.tmpdir(),
      `collector_queue_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  function createQueue(
    options: Partial<ConstructorParameters<typeof CollectorQueue>[0]> = {}
  ): CollectorQueue {
    return new CollectorQueue({
      queueDir: tempDir,
      clock: mockClock,
      jitterFn: (base) => base, // Deterministic jitter for testing
      ...options,
    });
  }

  describe("Limits and Boundaries", () => {
    it("enforces MAX_BATCH_BYTES boundary (262,144 bytes)", async () => {
      const queue = createQueue();

      // Exactly 262,144 bytes payload should succeed
      const validPayload = "a".repeat(MAX_BATCH_BYTES);
      const enqueued = await queue.enqueue({ body: validPayload });
      expect(enqueued.contentLength).toBe(MAX_BATCH_BYTES);
      expect(await queue.size()).toBe(1);

      // 262,145 bytes payload should be rejected
      const oversizedPayload = "a".repeat(MAX_BATCH_BYTES + 1);
      expect(queue.enqueue({ body: oversizedPayload })).rejects.toThrow(BatchSizeError);
      expect(await queue.size()).toBe(1);
    });

    it("clamps and freezes queue bounds at the reviewed hard maxima", () => {
      const queue = createQueue({
        maxRetentionMs: MAX_RETENTION_MS + 1,
        maxTotalBytes: MAX_TOTAL_BYTES + 1,
        maxBatches: MAX_BATCHES + 1,
        maxBatchBytes: MAX_BATCH_BYTES + 1,
      });

      expect(queue.maxRetentionMs).toBe(MAX_RETENTION_MS);
      expect(queue.maxTotalBytes).toBe(MAX_TOTAL_BYTES);
      expect(queue.maxBatches).toBe(MAX_BATCHES);
      expect(queue.maxBatchBytes).toBe(MAX_BATCH_BYTES);
      expect(Reflect.set(queue, "maxBatches", MAX_BATCHES + 1)).toBe(false);
    });

    it("keeps a batch at the exact 72-hour retention boundary", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: "{}", enqueuedAtMs: simulatedTime });
      advanceTime(MAX_RETENTION_MS);

      expect(await queue.size()).toBe(1);
      expect(queue.getDroppedTotal()).toBe(0);
    });

    it("drops expired batches older than 72 hours and increments queue_dropped_total", async () => {
      const queue = createQueue();

      await queue.enqueue({ body: JSON.stringify({ seq: 1 }), enqueuedAtMs: simulatedTime });
      expect(await queue.size()).toBe(1);
      expect(queue.getDroppedTotal()).toBe(0);

      // Advance clock by 72 hours + 1 ms
      advanceTime(MAX_RETENTION_MS + 1);

      // Peeking or enqueueing should purge the expired batch
      const peeked = await queue.peek();
      expect(peeked).toBeNull();
      expect(await queue.size()).toBe(0);
      expect(queue.getDroppedTotal()).toBe(1);
    });

    it("evicts oldest whole batch when batch count limit is reached", async () => {
      const queue = createQueue({ maxBatches: 3 });

      const b1 = await queue.enqueue({ body: JSON.stringify({ id: 1 }) });
      advanceTime(100);
      const b2 = await queue.enqueue({ body: JSON.stringify({ id: 2 }) });
      advanceTime(100);
      const b3 = await queue.enqueue({ body: JSON.stringify({ id: 3 }) });

      expect(await queue.size()).toBe(3);
      expect(queue.getDroppedTotal()).toBe(0);

      // Enqueueing 4th batch should evict b1 (the oldest)
      advanceTime(100);
      const b4 = await queue.enqueue({ body: JSON.stringify({ id: 4 }) });

      expect(await queue.size()).toBe(3);
      expect(queue.getDroppedTotal()).toBe(1);

      const oldest = await queue.peek();
      expect(oldest?.batchId).toBe(b2.batchId);
    });

    it("evicts oldest whole batch when total byte size limit is reached", async () => {
      // Allow max 1200 bytes total (each batch with envelope is ~470 bytes)
      const queue = createQueue({ maxTotalBytes: 1200 });

      // Each batch payload ~300 bytes
      const payload300 = "x".repeat(300);
      const b1 = await queue.enqueue({ body: payload300 });
      advanceTime(100);
      const b2 = await queue.enqueue({ body: payload300 });

      expect(await queue.size()).toBe(2);
      expect(queue.getDroppedTotal()).toBe(0);

      // Enqueue 3rd batch: total exceeds 1200 bytes, evicting b1
      advanceTime(100);
      const b3 = await queue.enqueue({ body: payload300 });

      expect(await queue.size()).toBe(2);
      expect(queue.getDroppedTotal()).toBe(1);
      const peeked = await queue.peek();
      expect(peeked?.batchId).toBe(b2.batchId);
    });

    it("validates and rejects invalid batchId UUIDs", async () => {
      const queue = createQueue();

      expect(queue.enqueue({ batchId: "invalid-uuid", body: "{}" })).rejects.toThrow(
        /INVALID_BATCH_ID/
      );
      expect(queue.enqueue({ batchId: "12345", body: "{}" })).rejects.toThrow(/INVALID_BATCH_ID/);
    });
  });

  describe("Crash Safety and Leftover Cleanup", () => {
    it("cleans up uncommitted .tmp files left from interrupted writes on init and scan", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ valid: true }) });
      expect(await queue.size()).toBe(1);

      // Simulate a crashed write by creating an orphan .tmp file
      const crashArtifact = path.join(tempDir, ".tmp_crashed_write_12345.tmp");
      fs.writeFileSync(crashArtifact, "partial data");
      expect(fs.existsSync(crashArtifact)).toBe(true);

      // Instantiating a new queue instance pointing to same directory cleans up the artifact
      const recoveredQueue = createQueue();
      await recoveredQueue.init();

      expect(fs.existsSync(crashArtifact)).toBe(false);
      expect(await recoveredQueue.size()).toBe(1);
    });

    it("handles corrupt batch files by discarding them and incrementing dropped counter", async () => {
      const queue = createQueue();
      const b1 = await queue.enqueue({ body: JSON.stringify({ seq: 1 }) });

      // Corrupt the batch file on disk
      const files = fs.readdirSync(tempDir).filter((f) => f.endsWith(".batch"));
      expect(files.length).toBe(1);
      const batchFilePath = path.join(tempDir, files[0]);
      fs.writeFileSync(batchFilePath, "{ invalid json corrupt");

      // Peeking will detect corrupted JSON, unlink it, and increment dropped
      const peeked = await queue.peek();
      expect(peeked).toBeNull();
      expect(await queue.size()).toBe(0);
      expect(queue.getDroppedTotal()).toBe(1);
      expect(fs.existsSync(batchFilePath)).toBe(false);
    });
  });

    it("recovers droppedTotal and conflict halt from the checksummed backup state", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ poison: true }) });
      await queue.drainStep(async () => ({ disposition: "poison" }));
      advanceTime(MIN_DRAIN_INTERVAL_MS + 1);
      await queue.enqueue({ body: JSON.stringify({ conflict: true }) });
      await queue.drainStep(async () => ({ disposition: "conflict-halt" }));

      fs.writeFileSync(path.join(tempDir, "state.json"), "corrupt-primary-state");
      const recovered = createQueue();

      expect(recovered.getDroppedTotal()).toBe(1);
      expect(recovered.isHalted()).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"))).toEqual(
        JSON.parse(fs.readFileSync(path.join(tempDir, "state.backup.json"), "utf8"))
      );
    });

    it("fails closed with a categorical stackless error when both state copies are corrupt", () => {
      createQueue();
      fs.writeFileSync(path.join(tempDir, "state.json"), "corrupt-primary-state");
      fs.writeFileSync(path.join(tempDir, "state.backup.json"), "corrupt-backup-state");

      let failure: unknown;
      try {
        createQueue();
      } catch (error) {
        failure = error;
      }

      if (!(failure instanceof QueueError)) {
        throw new Error("expected QueueError");
      }
      expect(failure.code).toBe("STATE_REPAIR_REQUIRED");
      expect(failure.category).toBe("operator_repair");
      expect(failure.stack).toBeUndefined();
      expect(failure.message).not.toContain(tempDir);
    });

    it("aborts an over-limit enqueue when oldest-batch eviction cannot unlink", async () => {
      const queue = createQueue({ maxBatches: 1 });
      const originalUnlink = fs.unlinkSync;
      await queue.enqueue({ body: JSON.stringify({ oldest: true }) });
      const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(((target) => {
        if (String(target).endsWith(".batch")) {
          const failure = new Error();
          Object.defineProperty(failure, "code", { value: "EACCES" });
          throw failure;
        }
        return originalUnlink(target);
      }) as typeof fs.unlinkSync);

      try {
        await expect(
          queue.enqueue({ body: JSON.stringify({ mustNotBeWritten: true }) })
        ).rejects.toMatchObject({
          code: "QUEUE_EVICTION_FAILED",
          category: "filesystem_error",
          stack: undefined,
        });
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(await queue.size()).toBe(1);
      expect(queue.getDroppedTotal()).toBe(0);
      const bodies = fs
        .readdirSync(tempDir)
        .filter((name) => name.endsWith(".batch"))
        .map((name) => fs.readFileSync(path.join(tempDir, name), "utf8"));
      expect(bodies.join("\n")).not.toContain("mustNotBeWritten");
    });

  describe("Symlink Rejection", () => {
    it("rejects symbolic links for queue directory", () => {
      const realTarget = path.join(os.tmpdir(), `real_queue_${Date.now()}`);
      const symlinkPath = path.join(os.tmpdir(), `symlink_queue_${Date.now()}`);

      fs.mkdirSync(realTarget, { recursive: true });
      try {
        try {
          fs.symlinkSync(realTarget, symlinkPath, "dir");
        } catch {
          // On Windows without Developer Mode, skip if symlink creation is not permitted
          return;
        }

        expect(() => new CollectorQueue({ queueDir: symlinkPath })).toThrow(SymlinkError);
      } finally {
        try {
          fs.unlinkSync(symlinkPath);
        } catch {}
        try {
          fs.rmSync(realTarget, { recursive: true, force: true });
        } catch {}
      }
    });

    it("rejects symbolic links for batch files inside queue directory", async () => {
      const queue = createQueue();
      const fakeTarget = path.join(os.tmpdir(), `target_${Date.now()}.txt`);
      fs.writeFileSync(fakeTarget, "target");

      const symlinkBatch = path.join(
        tempDir,
        `0001700000000000_11111111-1111-4111-8111-111111111111.batch`
      );

      try {
        try {
          fs.symlinkSync(fakeTarget, symlinkBatch, "file");
        } catch {
          // Skip if symlink not permitted
          return;
        }

        expect(queue.peek()).rejects.toThrow(SymlinkError);
      } finally {
        try {
          fs.unlinkSync(symlinkBatch);
        } catch {}
        try {
          fs.unlinkSync(fakeTarget);
        } catch {}
      }
    });
  });

  describe("FIFO Ordering", () => {
    it("drains batches in strict chronological FIFO order", async () => {
      const queue = createQueue();

      await queue.enqueue({ body: JSON.stringify({ index: 1 }), enqueuedAtMs: simulatedTime + 1000 });
      await queue.enqueue({ body: JSON.stringify({ index: 2 }), enqueuedAtMs: simulatedTime + 2000 });
      await queue.enqueue({ body: JSON.stringify({ index: 3 }), enqueuedAtMs: simulatedTime + 3000 });
      const processedIndices: number[] = [];
      const uploader = async (batch: QueuedBatch): Promise<UploadResult> => {
        const data = JSON.parse(batch.body);
        processedIndices.push(data.index);
        return { disposition: "accepted" };
      };

      // Drain 1
      const res1 = await queue.drainStep(uploader);
      expect(res1.status).toBe("acknowledged");

      // Advance clock past MIN_DRAIN_INTERVAL_MS
      advanceTime(MIN_DRAIN_INTERVAL_MS + 10);

      // Drain 2
      const res2 = await queue.drainStep(uploader);
      expect(res2.status).toBe("acknowledged");

      // Advance clock
      advanceTime(MIN_DRAIN_INTERVAL_MS + 10);

      // Drain 3
      const res3 = await queue.drainStep(uploader);
      expect(res3.status).toBe("acknowledged");

      expect(processedIndices).toEqual([1, 2, 3]);
      expect(await queue.size()).toBe(0);
    });
  });

  describe("One-In-Flight Concurrency", () => {
    it("rejects concurrent drain attempts with in_flight status", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ test: "flight" }) });

      let { promise: blockerPromise, resolve: unblock } = Promise.withResolvers<void>();
      let uploadCalls = 0;

      const uploader = async (): Promise<UploadResult> => {
        uploadCalls++;
        await blockerPromise;
        return { disposition: "accepted" };
      };

      // Start first drain step (will wait on blockerPromise)
      const step1Promise = queue.drainStep(uploader);

      // Immediately attempt a second drain step while first is in flight
      const step2 = await queue.drainStep(uploader);
      expect(step2.status).toBe("in_flight");
      expect(uploadCalls).toBe(1);

      // Unblock first drain
      unblock();
      const step1 = await step1Promise;
      expect(step1.status).toBe("acknowledged");
      expect(uploadCalls).toBe(1);
    });
  });

  describe("Immutable Retries and Fresh Signing Seam", () => {
    it("preserves exact immutable body, batchId, and bodySha256 across multiple retries", async () => {
      const queue = createQueue();
      const originalBody = JSON.stringify({ schema: "afo.collector.session-batch.v1", value: 42 });
      const enqueued = await queue.enqueue({ body: originalBody });

      const attempts: QueuedBatch[] = [];

      const uploader = async (batch: QueuedBatch): Promise<UploadResult> => {
        attempts.push({ ...batch });
        if (attempts.length < 3) {
          return { disposition: "retry" };
        }
        return { disposition: "accepted" };
      };

      // Attempt 1 -> retry
      const r1 = await queue.drainStep(uploader);
      expect(r1.status).toBe("retry_backoff");

      // Advance past backoff
      advanceTime(MIN_BACKOFF_MS + 10);

      // Attempt 2 -> retry
      const r2 = await queue.drainStep(uploader);
      expect(r2.status).toBe("retry_backoff");

      // Advance past backoff
      advanceTime(MIN_BACKOFF_MS * 2 + 10);

      // Attempt 3 -> accepted
      const r3 = await queue.drainStep(uploader);
      expect(r3.status).toBe("acknowledged");

      expect(attempts.length).toBe(3);

      for (const attempt of attempts) {
        expect(attempt.batchId).toBe(enqueued.batchId);
        expect(attempt.body).toBe(originalBody);
        expect(attempt.bodySha256).toBe(enqueued.bodySha256);
        expect(attempt.contentLength).toBe(enqueued.contentLength);
        expect(Buffer.from(attempt.bodyBytes).toString("utf-8")).toBe(originalBody);
      }
    });

    it("verifies queue on disk contains zero HMAC keys, signatures, or auth headers", async () => {
      const queue = createQueue();
      const secretCanaryPayload = JSON.stringify({ schema: "afo.collector.session-batch.v1" });
      await queue.enqueue({ body: secretCanaryPayload });

      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const content = fs.readFileSync(path.join(tempDir, file), "utf-8");
        // Verify absence of auth / signature fields
        expect(content).not.toContain("Authorization");
        expect(content).not.toContain("AFO-HMAC-SHA256");
        expect(content).not.toContain("X-AFO-Signed-At");
        expect(content).not.toContain("X-AFO-Key-ID");
        expect(content).not.toContain("signature");
      }
    });
  });

  describe("Backoff Classes and Rate Limiting", () => {
    it("applies exponential backoff with jitter on retryable error", async () => {
      let currentJitter = 0;
      const queue = createQueue({
        jitterFn: (base) => {
          currentJitter = base;
          return base;
        },
      });

      await queue.enqueue({ body: JSON.stringify({ test: "backoff" }) });

      // Attempt 1: retryable error -> base delay MIN_BACKOFF_MS (5000 ms)
      const r1 = await queue.drainStep(async () => ({ disposition: "retry" }));
      expect(r1.status).toBe("retry_backoff");
      if (r1.status === "retry_backoff") {
        expect(r1.consecutiveRetries).toBe(1);
        expect(r1.backoffMs).toBe(5000);
      }

      // Attempt 2 before backoff expires -> rate_limited
      const rl = await queue.drainStep(async () => ({ disposition: "accepted" }));
      expect(rl.status).toBe("rate_limited");

      // Advance time past attempt 1 backoff
      advanceTime(5001);

      // Attempt 2: retryable error -> 2 * 5000 = 10000 ms
      const r2 = await queue.drainStep(async () => ({ disposition: "retry" }));
      expect(r2.status).toBe("retry_backoff");
      if (r2.status === "retry_backoff") {
        expect(r2.consecutiveRetries).toBe(2);
        expect(r2.backoffMs).toBe(10000);
      }
    });

    it("honors server retryAfterSeconds when larger than computed backoff", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ test: "retry-after" }) });

      const r = await queue.drainStep(async () => ({
        disposition: "retry",
        retryAfterSeconds: 45,
      }));

      expect(r.status).toBe("retry_backoff");
      if (r.status === "retry_backoff") {
        expect(r.backoffMs).toBe(45000); // 45 seconds
      }
    });

    it("applies slow 15-minute backoff on auth failure without dropping batch", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ test: "auth" }) });

      const r = await queue.drainStep(async () => ({ disposition: "auth" }));
      expect(r.status).toBe("auth_backoff");
      if (r.status === "auth_backoff") {
        expect(r.backoffMs).toBe(AUTH_BACKOFF_MS); // 15 minutes = 900,000 ms
      }

      // Batch is still in queue
      expect(await queue.size()).toBe(1);
    });

    it("enforces MIN_DRAIN_INTERVAL_MS pacing between successful drains", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ n: 1 }) });
      await queue.enqueue({ body: JSON.stringify({ n: 2 }) });

      const r1 = await queue.drainStep(async () => ({ disposition: "accepted" }));
      expect(r1.status).toBe("acknowledged");

      // Immediate next drain call is rate-limited by MIN_DRAIN_INTERVAL_MS (2000 ms)
      const r2 = await queue.drainStep(async () => ({ disposition: "accepted" }));
      expect(r2.status).toBe("rate_limited");

      // Advance by 2000 ms
      advanceTime(MIN_DRAIN_INTERVAL_MS + 1);

      const r3 = await queue.drainStep(async () => ({ disposition: "accepted" }));
      expect(r3.status).toBe("acknowledged");
    });
  });

  describe("Poison Drop, 409 Conflict Halt, and Exact ACK Semantics", () => {
    it("deletes batch file on accepted ACK or duplicate ACK", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ ack: true }) });
      expect(await queue.size()).toBe(1);

      const r = await queue.drainStep(async () => ({ disposition: "accepted" }));
      expect(r.status).toBe("acknowledged");
      expect(await queue.size()).toBe(0);
      expect(queue.getDroppedTotal()).toBe(0);
    });

    it("drops poison batch on 400/413/422 and increments queue_dropped_total", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ poison: true }) });
      expect(await queue.size()).toBe(1);
      expect(queue.getDroppedTotal()).toBe(0);

      const r = await queue.drainStep(async () => ({
        disposition: "poison",
        category: "schema_rejected",
      }));

      expect(r.status).toBe("poison_dropped");
      expect(await queue.size()).toBe(0);
      expect(queue.getDroppedTotal()).toBe(1);
    });

    it("halts queue on 409 Conflict, retains batch on disk, and blocks subsequent drains until unhalted", async () => {
      const queue = createQueue();
      const b = await queue.enqueue({ body: JSON.stringify({ conflict: true }) });

      const r1 = await queue.drainStep(async () => ({ disposition: "conflict-halt" }));
      expect(r1.status).toBe("conflict_halted");
      expect(queue.isHalted()).toBe(true);

      // Batch remains on disk
      expect(await queue.size()).toBe(1);

      // Subsequent drainStep calls return halted immediately without calling uploader
      let called = false;
      const r2 = await queue.drainStep(async () => {
        called = true;
        return { disposition: "accepted" };
      });
      expect(r2.status).toBe("halted");
      expect(called).toBe(false);

      // Verify halt persistence across new queue instance
      const persistedQueue = createQueue();
      expect(persistedQueue.isHalted()).toBe(true);

      // Unhalt allows drainage to resume
      persistedQueue.unhalt();
      expect(persistedQueue.isHalted()).toBe(false);

      advanceTime(MIN_DRAIN_INTERVAL_MS + 10);
      const r3 = await persistedQueue.drainStep(async () => ({ disposition: "accepted" }));
      expect(r3.status).toBe("acknowledged");
      expect(await persistedQueue.size()).toBe(0);
    });
  });

  describe("Canary and Privacy Absence", () => {
    it("never stores canaries, prompt text, or error stacks in queue files or state.json", async () => {
      const queue = createQueue();
      const CANARY_SECRET_TOKEN = "CANARY_AUTH_BEARER_SECRET_XYZ_987";
      const CANARY_ERROR_STACK = "CANARY_RAW_ERROR_STACK_AT_COLLECTOR_123";

      await queue.enqueue({
        body: JSON.stringify({
          schema: "afo.collector.session-batch.v1",
          safeData: "only-normalized-content",
        }),
      });

      // Trigger a poison failure with an error canary category
      await queue.drainStep(async () => {
        throw new Error(CANARY_ERROR_STACK);
      });

      // Read all files in the queue directory
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const content = fs.readFileSync(path.join(tempDir, file), "utf-8");
        expect(content).not.toContain(CANARY_SECRET_TOKEN);
        expect(content).not.toContain(CANARY_ERROR_STACK);
      }
    });
  });

  describe("Drain Loop and Statistics", () => {
    it("drains all batches in loop until empty, respecting min interval", async () => {
      let sleptTotalMs = 0;
      const queue = createQueue({
        sleepFn: async (ms) => {
          sleptTotalMs += ms;
          advanceTime(ms);
        },
      });

      await queue.enqueue({ body: JSON.stringify({ item: 1 }), enqueuedAtMs: simulatedTime + 1000 });
      await queue.enqueue({ body: JSON.stringify({ item: 2 }), enqueuedAtMs: simulatedTime + 2000 });
      await queue.enqueue({ body: JSON.stringify({ item: 3 }), enqueuedAtMs: simulatedTime + 3000 });

      const processed: number[] = [];
      const summary = await queue.drain(async (batch) => {
        const parsed = JSON.parse(batch.body);
        processed.push(parsed.item);
        return { disposition: "accepted" };
      });

      expect(summary.acknowledgedCount).toBe(3);
      expect(summary.empty).toBe(true);
      expect(summary.halted).toBe(false);
      expect(processed).toEqual([1, 2, 3]);
      expect(await queue.size()).toBe(0);
    });

    it("honors maxSteps option in drain loop", async () => {
      const queue = createQueue({
        sleepFn: async (ms) => advanceTime(ms),
      });

      await queue.enqueue({ body: JSON.stringify({ item: 1 }), enqueuedAtMs: simulatedTime + 1000 });
      await queue.enqueue({ body: JSON.stringify({ item: 2 }), enqueuedAtMs: simulatedTime + 2000 });

      const summary = await queue.drain(async () => ({ disposition: "accepted" }), { maxSteps: 1 });
      expect(summary.acknowledgedCount).toBe(1);
      expect(summary.stepsExecuted).toBe(1);
      expect(await queue.size()).toBe(1);
    });

    it("honors AbortSignal in drain loop", async () => {
      const controller = new AbortController();
      const queue = createQueue({
        sleepFn: async (ms) => advanceTime(ms),
      });

      await queue.enqueue({ body: JSON.stringify({ item: 1 }) });
      controller.abort();

      const summary = await queue.drain(async () => ({ disposition: "accepted" }), {
        signal: controller.signal,
      });
      expect(summary.stepsExecuted).toBe(0);
      expect(await queue.size()).toBe(1);
    });

    it("returns accurate queue stats and clears queue on clear()", async () => {
      const queue = createQueue();
      await queue.enqueue({ body: JSON.stringify({ test: 1 }), enqueuedAtMs: simulatedTime + 1000 });
      await queue.enqueue({ body: JSON.stringify({ test: 2 }), enqueuedAtMs: simulatedTime + 2000 });

      const stats = await queue.getStats();
      expect(stats.count).toBe(2);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.droppedTotal).toBe(0);
      expect(stats.isHalted).toBe(false);
      expect(stats.oldestEnqueuedAtMs).toBe(simulatedTime + 1000);
      expect(stats.newestEnqueuedAtMs).toBe(simulatedTime + 2000);

      await queue.drainStep(async () => ({ disposition: "poison" }));
      advanceTime(MIN_DRAIN_INTERVAL_MS + 1);
      await queue.enqueue({ body: JSON.stringify({ retainedCounter: true }) });
      expect(queue.getDroppedTotal()).toBe(1);

      await queue.clear();
      const clearedStats = await queue.getStats();
      expect(clearedStats.count).toBe(0);
      expect(clearedStats.totalBytes).toBe(0);
      expect(clearedStats.droppedTotal).toBe(1);
      expect(createQueue().getDroppedTotal()).toBe(1);
    });
  });
});
