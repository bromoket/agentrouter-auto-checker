import { describe, expect, test } from "bun:test";
import { REGISTERED_COLLECTOR_ENDPOINT } from "./client";
import type { RuntimeCollectorConfig } from "./config";
import { RuntimeCollectorDaemon, RuntimeCollectorDaemonError } from "./daemon";
import type { CollectorQueue } from "./queue";

const BASE_CONFIG: RuntimeCollectorConfig = {
  enabled: true,
  endpointUrl: REGISTERED_COLLECTOR_ENDPOINT,
  hostId: "11111111-1111-4111-8111-111111111111",
  keyId: "22222222-2222-4222-8222-222222222222",
  sessionIdentityKeyId: "33333333-3333-4333-8333-333333333333",
  ompStatsDbPath: "C:/synthetic/omp-stats.db",
  queueDir: "C:/synthetic/queue",
  writerVersion: "18.0.11",
  collectorVersion: "1.0.0",
  intervalMs: 60_000,
  cycleTimeoutMs: 30_000,
  sessionLimit: 100,
  maxMessagesPerSession: 2_000,
  allowedProviders: new Set(["anthropic"]),
  allowedModels: new Set(["claude-3-7-sonnet"]),
};

function fakeQueue(halted: boolean): CollectorQueue {
  return {
    init: async () => {},
    getStats: async () => ({
      count: 0,
      totalBytes: 0,
      droppedTotal: 0,
      isHalted: halted,
      oldestEnqueuedAtMs: null,
      newestEnqueuedAtMs: null,
    }),
  } as unknown as CollectorQueue;
}

describe("runtime collector daemon", () => {
  test("disabled mode creates no queue, loads no key, and performs no upload", async () => {
    let queueCreated = false;
    let keyLoaded = false;
    const daemon = new RuntimeCollectorDaemon({
      config: { ...BASE_CONFIG, enabled: false, hostId: null, keyId: null, sessionIdentityKeyId: null, ompStatsDbPath: null, queueDir: null },
      loadKey: async () => {
        keyLoaded = true;
        return new Uint8Array(32);
      },
      loadSessionIdentityKey: async () => {
        keyLoaded = true;
        return new Uint8Array(32);
      },
      queueFactory: () => {
        queueCreated = true;
        return fakeQueue(false);
      },
    });
    expect(await daemon.runOnce()).toEqual({ status: "disabled", queuedBatches: 0, queuedSessions: 0, drain: null });
    expect(queueCreated).toBe(false);
    expect(keyLoaded).toBe(false);
  });

  test("halts before collection or key access when queue has an auth-conflict halt", async () => {
    let keyLoaded = false;
    const daemon = new RuntimeCollectorDaemon({
      config: BASE_CONFIG,
      loadKey: async () => {
        keyLoaded = true;
        return new Uint8Array(32);
      },
      loadSessionIdentityKey: async () => {
        keyLoaded = true;
        return new Uint8Array(32);
      },
      queueFactory: () => fakeQueue(true),
    });
    const result = await daemon.runOnce();
    expect(result.status).toBe("halted");
    expect(keyLoaded).toBe(false);
  });

  test("requires an owner-private exact 32-byte key before reading the local source", async () => {
    const daemon = new RuntimeCollectorDaemon({
      config: BASE_CONFIG,
      loadKey: async () => new Uint8Array(32),
      loadSessionIdentityKey: async () => new Uint8Array(31),
      queueFactory: () => fakeQueue(false),
    });
    await expect(daemon.runOnce()).rejects.toBeInstanceOf(RuntimeCollectorDaemonError);
  });

  test("hard deadline rejects an abort-ignoring identity loader and zeroes its late key", async () => {
    const lateKey = new Uint8Array(32).fill(7);
    const keyGate = Promise.withResolvers<Uint8Array>();
    const loaderCalled = Promise.withResolvers<void>();
    let deadline: (() => void) | null = null;
    const daemon = new RuntimeCollectorDaemon({
      config: { ...BASE_CONFIG, cycleTimeoutMs: 5 },
      loadKey: async () => new Uint8Array(32),
      loadSessionIdentityKey: () => {
        loaderCalled.resolve();
        return keyGate.promise;
      },
      queueFactory: () => fakeQueue(false),
      scheduleTimeout: (callback) => {
        deadline = callback;
        return 1;
      },
      clearScheduledTimeout: () => {},
    });
    const cycle = daemon.runOnce();
    await loaderCalled.promise;
    deadline!();
    await expect(cycle).rejects.toBeInstanceOf(RuntimeCollectorDaemonError);
    keyGate.resolve(lateKey);
    await Promise.resolve();
    await Promise.resolve();
    expect([...lateKey].every((value) => value === 0)).toBe(true);
  });

  test("rejects every endpoint except the registered HTTPS FQDN", () => {
    expect(() => new RuntimeCollectorDaemon({
      config: { ...BASE_CONFIG, endpointUrl: "https://example.invalid/" as typeof REGISTERED_COLLECTOR_ENDPOINT },
      loadKey: async () => new Uint8Array(32),
      loadSessionIdentityKey: async () => new Uint8Array(32),
    })).toThrow(RuntimeCollectorDaemonError);
  });
});
