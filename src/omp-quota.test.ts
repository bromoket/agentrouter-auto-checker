import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpQuotaConfig } from "./config";
import {
  evaluateFailure,
  evaluateObservation,
  OmpQuotaPoller,
  OmpQuotaStateStore,
  parseOmpUsageResponse,
  parseTimestamp,
  sanitizeOmpError,
  stripAnsi,
} from "./omp-quota";
import type { OmpQuotaObservation, OmpQuotaState, OmpQuotaTransitionEvent, OmpUsageResponse } from "./omp-quota";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function validUsageResponse(overrides: Partial<OmpUsageResponse> = {}): OmpUsageResponse {
  const now = Date.now();
  return {
    generatedAt: now,
    reports: [
      {
        provider: "openai-codex",
        fetchedAt: now,
        limits: [
          {
            id: "openai-codex:primary",
            label: "7 days",
            scope: {
              provider: "openai-codex",
              windowId: "7d",
              shared: true,
            },
            window: {
              id: "7d",
              label: "7 days",
              durationMs: 604_800_000,
              resetsAt: now + 500_000_000,
            },
            amount: {
              used: 15,
              limit: 100,
              remaining: 85,
              usedFraction: 0.15,
              remainingFraction: 0.85,
              unit: "percent",
            },
            status: "ok",
          },
          {
            id: "openai-codex:spark:primary",
            label: "5 hours (Spark)",
            scope: {
              provider: "openai-codex",
              tier: "spark",
              windowId: "5h",
            },
            window: {
              id: "5h",
              resetsAt: now + 10_000_000,
            },
            amount: {
              used: 0,
              limit: 100,
              remaining: 100,
              usedFraction: 0,
              remainingFraction: 1,
            },
          },
        ],
        resetCredits: {
          availableCount: 1,
        },
      },
    ],
    ...overrides,
  };
}

describe("OMP quota parser", () => {
  test("parseTimestamp parses epoch ms, seconds, ISO strings, and numeric strings", () => {
    expect(parseTimestamp(1_788_211_326_025)).toBe(1_788_211_326_025);
    expect(parseTimestamp(1_788_211_326)).toBe(1_788_211_326_000);
    expect(parseTimestamp("1788211326025")).toBe(1_788_211_326_025);
    expect(parseTimestamp("2026-08-31T12:00:00.000Z")).toBe(Date.parse("2026-08-31T12:00:00.000Z"));
    expect(parseTimestamp("")).toBeNaN();
    expect(parseTimestamp(null)).toBeNaN();
    expect(parseTimestamp(undefined)).toBeNaN();
    expect(parseTimestamp("invalid-date")).toBeNaN();
  });

  test("stripAnsi removes terminal escape codes", () => {
    expect(stripAnsi("\u001B[31mError\u001B[0m")).toBe("Error");
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  test("parses a valid weekly report and normalizes fields", () => {
    const raw = validUsageResponse();
    const observation = parseOmpUsageResponse(raw);

    expect(observation.provider).toBe("openai-codex");
    expect(observation.usedFraction).toBe(0.15);
    expect(observation.remainingPct).toBe(85);
    expect(typeof observation.resetAt).toBe("string");
    expect(typeof observation.observedAt).toBe("string");
    expect(observation.resetCredits).toBe(1);
  });

  test("computes usedFraction and remainingPct from used and limit amounts", () => {
    const now = Date.now();
    const raw: OmpUsageResponse = {
      generatedAt: now,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: now,
          limits: [
            {
              id: "openai-codex:primary",
              window: {
                id: "7d",
                resetsAt: now + 300_000_000,
              },
              amount: {
                used: 25,
                limit: 100,
              },
            },
          ],
        },
      ],
    };

    const observation = parseOmpUsageResponse(raw);
    expect(observation.usedFraction).toBe(0.25);
    expect(observation.remainingPct).toBe(75);
  });

  test("rejects invalid payloads: missing reports, non-objects, missing openai-codex", () => {
    expect(() => parseOmpUsageResponse(null)).toThrow("root is not an object");
    expect(() => parseOmpUsageResponse([])).toThrow("root is not an object");
    expect(() => parseOmpUsageResponse({})).toThrow("reports array is missing");
    expect(() => parseOmpUsageResponse({ reports: [] })).toThrow("No openai-codex report found");
    expect(() => parseOmpUsageResponse({ reports: [{ provider: "google-antigravity" }] })).toThrow(
      "No openai-codex report found",
    );
  });

  test("rejects reports missing the weekly chat limit", () => {
    const now = Date.now();
    const raw: OmpUsageResponse = {
      generatedAt: now,
      reports: [
        {
          provider: "openai-codex",
          limits: [
            {
              id: "openai-codex:spark:primary",
              scope: { tier: "spark" },
              window: { id: "5h", resetsAt: now + 10_000_000 },
              amount: { used: 0, limit: 100 },
            },
          ],
        },
      ],
    };
    expect(() => parseOmpUsageResponse(raw)).toThrow("Weekly openai-codex limit window not found");
  });

  test("rejects future or stale observation timestamps", () => {
    const now = 1_700_000_000_000;
    const futureRaw = validUsageResponse({ generatedAt: now + 120_000 });
    expect(() => parseOmpUsageResponse(futureRaw, { now })).toThrow("in the future");

    const staleRaw = validUsageResponse({ generatedAt: now - 30 * 60 * 1_000 });
    expect(() => parseOmpUsageResponse(staleRaw, { now, maxStaleMs: 15 * 60 * 1_000 })).toThrow("is stale");
  });

  test("rejects reset timestamps in the past or unreasonably far in the future", () => {
    const now = 1_700_000_000_000;
    const pastResetRaw = validUsageResponse({
      generatedAt: now,
      reports: [
        {
          provider: "openai-codex",
          limits: [
            {
              id: "openai-codex:primary",
              window: { id: "7d", resetsAt: now - 120_000 },
              amount: { used: 10, limit: 100 },
            },
          ],
        },
      ],
    });
    expect(() => parseOmpUsageResponse(pastResetRaw, { now })).toThrow("in the past relative to observation");

    const farFutureResetRaw = validUsageResponse({
      generatedAt: now,
      reports: [
        {
          provider: "openai-codex",
          limits: [
            {
              id: "openai-codex:primary",
              window: { id: "7d", resetsAt: now + 30 * 24 * 60 * 60 * 1_000 },
              amount: { used: 10, limit: 100 },
            },
          ],
        },
      ],
    });
    expect(() => parseOmpUsageResponse(farFutureResetRaw, { now })).toThrow("unreasonably far in the future");
  });
});

describe("OMP quota error sanitization", () => {
  test("categorizes errors cleanly without leaking sensitive details", () => {
    expect(sanitizeOmpError(new Error("Request timed out after 45000ms"))).toBe("Probe timed out");
    expect(sanitizeOmpError(new Error("CLI process exited with code 1"))).toBe("CLI process exited with error");
    expect(sanitizeOmpError(new Error("ENOENT: executable node_modules/.bin/omp not found"))).toBe(
      "CLI executable not found",
    );
    expect(sanitizeOmpError(new Error("Unexpected token < in JSON at position 0"))).toBe(
      "Invalid usage response payload",
    );
    expect(sanitizeOmpError(new Error("Observation timestamp is stale."))).toBe("Invalid usage response payload");
    expect(sanitizeOmpError(new Error("Bearer secret-token-xyz failed to authenticate with http://100.127.29.78:8765"))).toBe(
      "Quota probe failure",
    );
    expect(sanitizeOmpError(null)).toBe("Quota probe failure");
  });
});

describe("OMP quota state machine", () => {
  const baseState: OmpQuotaState = {
    lastResetAt: null,
    lastNotifiedResetAt: null,
    lowQuotaActive: false,
    consecutiveFailures: 0,
    failureAlertSent: false,
    lastObservedAt: null,
    lastRemainingPct: null,
    lastUsedFraction: null,
    lastResetCredits: null,
    updatedAt: new Date().toISOString(),
  };

  const sampleObs: OmpQuotaObservation = {
    provider: "openai-codex",
    usedFraction: 0.2,
    remainingPct: 80,
    resetAt: "2026-09-07T12:00:00.000Z",
    observedAt: "2026-08-31T12:00:00.000Z",
    resetCredits: 0,
  };

  test("initial observation is quiet and records reset timestamp", () => {
    const { nextState, events } = evaluateObservation(baseState, sampleObs, { lowRemainingPct: 10 });
    expect(events).toHaveLength(0);
    expect(nextState.lastResetAt).toBe("2026-09-07T12:00:00.000Z");
    expect(nextState.lowQuotaActive).toBe(false);
  });

  test("initial observation with low quota sets lowQuotaActive quietly without alert", () => {
    const lowObs: OmpQuotaObservation = { ...sampleObs, usedFraction: 0.95, remainingPct: 5 };
    const { nextState, events } = evaluateObservation(baseState, lowObs, { lowRemainingPct: 10 });
    expect(events).toHaveLength(0);
    expect(nextState.lowQuotaActive).toBe(true);
  });

  test("emits reset event exactly once when resetAt advances", () => {
    const existingState: OmpQuotaState = {
      ...baseState,
      lastResetAt: "2026-08-31T12:00:00.000Z",
      lastNotifiedResetAt: "2026-08-31T12:00:00.000Z",
    };

    const nextObs: OmpQuotaObservation = {
      ...sampleObs,
      resetAt: "2026-09-07T12:00:00.000Z",
    };

    const { nextState, events } = evaluateObservation(existingState, nextObs, { lowRemainingPct: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reset");
    if (events[0].type === "reset") {
      expect(events[0].previousResetAt).toBe("2026-08-31T12:00:00.000Z");
    }
    expect(nextState.lastResetAt).toBe("2026-09-07T12:00:00.000Z");

    // Subsequent observation in the same reset window produces no duplicate reset event
    const { events: subsequentEvents } = evaluateObservation(nextState, nextObs, { lowRemainingPct: 10 });
    expect(subsequentEvents).toHaveLength(0);
  });

  test("emits low_remaining event once on threshold crossing, suppresses duplicates", () => {
    const initializedState: OmpQuotaState = {
      ...baseState,
      lastResetAt: sampleObs.resetAt,
      lastNotifiedResetAt: sampleObs.resetAt,
      lowQuotaActive: false,
    };

    const lowObs: OmpQuotaObservation = {
      ...sampleObs,
      usedFraction: 0.92,
      remainingPct: 8,
    };

    const { nextState, events } = evaluateObservation(initializedState, lowObs, { lowRemainingPct: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("low_remaining");
    expect(nextState.lowQuotaActive).toBe(true);

    // Further low samples in the same window do not re-alert
    const evenLowerObs: OmpQuotaObservation = {
      ...sampleObs,
      usedFraction: 0.95,
      remainingPct: 5,
    };
    const { events: duplicateEvents } = evaluateObservation(nextState, evenLowerObs, { lowRemainingPct: 10 });
    expect(duplicateEvents).toHaveLength(0);

    // If quota goes back above threshold, lowQuotaActive is cleared
    const recoveredObs: OmpQuotaObservation = {
      ...sampleObs,
      usedFraction: 0.8,
      remainingPct: 20,
    };
    const { nextState: recoveredState, events: recoveredEvents } = evaluateObservation(
      nextState,
      recoveredObs,
      { lowRemainingPct: 10 },
    );
    expect(recoveredEvents).toHaveLength(0);
    expect(recoveredState.lowQuotaActive).toBe(false);
  });

  test("repeated failures alert once at threshold and recover once", () => {
    let state = { ...baseState };

    // Failure 1 (threshold 3): no alert
    let result = evaluateFailure(state, "Probe timed out", { repeatedFailureCount: 3 });
    expect(result.events).toHaveLength(0);
    expect(result.nextState.consecutiveFailures).toBe(1);
    expect(result.nextState.failureAlertSent).toBe(false);
    state = result.nextState;

    // Failure 2: no alert
    result = evaluateFailure(state, "Probe timed out", { repeatedFailureCount: 3 });
    expect(result.events).toHaveLength(0);
    expect(result.nextState.consecutiveFailures).toBe(2);
    state = result.nextState;

    // Failure 3: alert emitted once
    result = evaluateFailure(state, "Probe timed out", { repeatedFailureCount: 3 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("repeated_failure");
    expect(result.nextState.consecutiveFailures).toBe(3);
    expect(result.nextState.failureAlertSent).toBe(true);
    state = result.nextState;

    // Failure 4: duplicate alert suppressed
    result = evaluateFailure(state, "Probe timed out", { repeatedFailureCount: 3 });
    expect(result.events).toHaveLength(0);
    expect(result.nextState.consecutiveFailures).toBe(4);
    expect(result.nextState.failureAlertSent).toBe(true);
    state = result.nextState;

    // Recovery upon success: emits recovery event once
    const recoveryResult = evaluateObservation(state, sampleObs, { lowRemainingPct: 10 });
    expect(recoveryResult.events).toHaveLength(1);
    expect(recoveryResult.events[0].type).toBe("recovery");
    expect(recoveryResult.nextState.consecutiveFailures).toBe(0);
    expect(recoveryResult.nextState.failureAlertSent).toBe(false);

    // Subsequent successful checks do not re-emit recovery
    const nextResult = evaluateObservation(recoveryResult.nextState, sampleObs, { lowRemainingPct: 10 });
    expect(nextResult.events).toHaveLength(0);
  });
});

describe("OMP quota state persistence", () => {
  test("loads default state when file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-state-test-"));
    temporaryDirectories.push(dir);
    const store = new OmpQuotaStateStore(join(dir, "state.json"));
    const state = await store.load();

    expect(state.lastResetAt).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.failureAlertSent).toBe(false);
  });

  test("persists state atomically with mode 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-state-test-"));
    temporaryDirectories.push(dir);
    const filePath = join(dir, "omp-quota-state.json");
    const store = new OmpQuotaStateStore(filePath);

    const testState: OmpQuotaState = {
      lastResetAt: "2026-09-07T12:00:00.000Z",
      lastNotifiedResetAt: "2026-09-07T12:00:00.000Z",
      lowQuotaActive: true,
      consecutiveFailures: 2,
      failureAlertSent: false,
      lastObservedAt: "2026-08-31T12:00:00.000Z",
      lastRemainingPct: 8,
      lastUsedFraction: 0.92,
      lastResetCredits: 1,
      updatedAt: "2026-08-31T12:00:01.000Z",
    };

    await store.save(testState);

    const loaded = await store.load();
    expect(loaded.lastResetAt).toBe("2026-09-07T12:00:00.000Z");
    expect(loaded.lowQuotaActive).toBe(true);
    expect(loaded.consecutiveFailures).toBe(2);
    expect(loaded.lastRemainingPct).toBe(8);

    if (process.platform !== "win32") {
      const fileStat = await stat(filePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });
});

describe("OmpQuotaPoller integration", () => {
  function makeConfig(stateFilePath: string): OmpQuotaConfig {
    return {
      enabled: true,
      executable: "node_modules/.bin/omp",
      brokerUrl: "http://127.0.0.1:8765",
      stateFilePath,
      intervalMinutes: 5,
      timeoutMs: 45_000,
      lowRemainingPct: 10,
    };
  }

  test("polls using injected executor and updates state without leaking secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-poller-test-"));
    temporaryDirectories.push(dir);
    const config = makeConfig(join(dir, "state.json"));

    const executedCalls: Array<{ executable: string; brokerUrl: string }> = [];
    const mockExecutor = async (params: {
      executable: string;
      brokerUrl: string;
      brokerToken: string;
      timeoutMs: number;
    }) => {
      executedCalls.push({ executable: params.executable, brokerUrl: params.brokerUrl });
      return validUsageResponse();
    };

    const poller = new OmpQuotaPoller(config, null, 3, mockExecutor);
    const obs = await poller.pollOnce();

    expect(obs).not.toBeNull();
    expect(obs?.provider).toBe("openai-codex");
    expect(executedCalls).toHaveLength(1);
    expect(executedCalls[0].executable).toBe("node_modules/.bin/omp");
    expect(executedCalls[0].brokerUrl).toBe("http://127.0.0.1:8765");

    const state = await poller.getState();
    expect(state.lastResetAt).not.toBeNull();
  });

  test("handles executor errors cleanly and updates failure state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-poller-test-"));
    temporaryDirectories.push(dir);
    const config = makeConfig(join(dir, "state.json"));

    const failingExecutor = async () => {
      throw new Error("CLI process exited with code 1");
    };

    const poller = new OmpQuotaPoller(config, null, 3, failingExecutor);
    const obs = await poller.pollOnce();

    expect(obs).toBeNull();
    const state = await poller.getState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.failureAlertSent).toBe(false);
  });
});
