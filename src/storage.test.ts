import { afterEach, describe, expect, test } from "bun:test";
import type { RunSnapshot } from "./storage";
import { Store } from "./storage";

const stores: Store[] = [];

function createStore(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    accountId: "account-1",
    accountLabel: "Account 1",
    startedAt: "2026-08-09T10:00:00.000Z",
    endedAt: "2026-08-09T10:00:05.000Z",
    status: "ok",
    loginMs: 2_000,
    dashboardMs: 500,
    totalMs: 5_000,
    summary: { site: { version: "test" } },
    metrics: {
      balance: 75.5,
      consumed: 20,
      requestCount: 10,
      statisticalCount: 4,
      statisticalTokens: 1_000,
      quotaPerUnit: 500_000,
    },
    usagePoints: [
      {
        accountId: "account-1",
        granularity: "day",
        createdAt: 1_786_262_400,
        modelName: "model-a",
        requestCount: 4,
        tokenUsed: 1_000,
        quota: 250_000,
      },
    ],
    apiCalls: [
      { path: "/api/user/self", method: "GET", status: 200, ok: true, latencyMs: 20 },
    ],
    loggedOut: true,
    sessionReused: false,
    ...overrides,
  };
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

describe("Store", () => {
  test("persists endpoint observations without pretending a logout occurred", () => {
    const store = createStore();
    const id = store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Account 1",
      observedAt: "2026-08-15T00:00:00.000Z",
      status: "ok",
      balance: 267.5,
      consumed: 132.5,
      sourcePath: "/v1/dashboard/billing/subscription + /v1/dashboard/billing/usage",
      latencyMs: 20,
    });
    expect(id).toBeGreaterThan(0);
    expect(store.listEndpointObservations("account-1", 10)).toEqual([
      expect.objectContaining({
        id,
        status: "ok",
        balance: 267.5,
        consumed: 132.5,
      }),
    ]);
  });

  test("derives a material delta from consecutive successful endpoint observations", () => {
    const store = createStore();
    store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Account 1",
      observedAt: "2026-08-15T00:00:00.000Z",
      status: "ok",
      balance: -0.23,
      consumed: 132.5,
      requestCount: 11,
      sourcePath: "/api/user/self",
      latencyMs: 20,
    });
    const id = store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Account 1",
      observedAt: "2026-08-15T00:01:00.000Z",
      status: "ok",
      balance: 24.77,
      consumed: 132.5,
      requestCount: 14,
      sourcePath: "/api/user/self",
      latencyMs: 25,
    });

    expect(store.getEndpointBalanceObservation(id)).toEqual(expect.objectContaining({
      observationId: id,
      balanceDelta: 25,
      consumedDelta: 0,
      requestCountDelta: 3,
      minutesSincePrevious: 1,
    }));
  });
  test("persists normalized runs and metrics", () => {
    const store = createStore();
    const id = store.saveRun(snapshot());
    expect(id).toBeGreaterThan(0);

    const [run] = store.listRuns(10, "account-1");
    expect(run.status).toBe("ok");
    expect(run.metrics.balance).toBe(75.5);
    expect(run.loggedOut).toBe(true);
    expect(run.summary).toEqual({ site: { version: "test" } });

    const [history] = store.listMetricHistory("account-1", 10);
    expect(history.metrics.statisticalTokens).toBe(1_000);
  });

  test("rejects successful runs without verified money or browser session evidence", () => {
    const store = createStore();
    expect(() => store.saveRun(snapshot({ loggedOut: false }))).toThrow(
      "confirm AgentRouter logout or an intentionally retained authenticated session",
    );
    expect(store.saveRun(snapshot({
      loggedOut: false,
      summary: { authentication: "retained-authenticated-session" },
    }))).toBeGreaterThan(0);
    expect(() => store.saveRun(snapshot({ metrics: {} }))).toThrow("finite balance");
    expect(store.getRunStatusCounts()).toEqual({ successful: 1, failed: 0 });
  });

  test("persists a verified negative balance while rejecting negative consumption", () => {
    const store = createStore();
    const id = store.saveRun(snapshot({ metrics: { balance: -0.12, consumed: 275.12 } }));
    expect(store.getCreditObservationForRun(id)?.balance).toBe(-0.12);
    expect(() => store.saveRun(snapshot({ metrics: { balance: -0.12, consumed: -1 } }))).toThrow(
      "non-negative consumption",
    );
  });

  test("upserts overlapping usage points from later checks", () => {
    const store = createStore();
    store.saveRun(snapshot());
    store.saveRun(
      snapshot({
        startedAt: "2026-08-09T11:00:00.000Z",
        endedAt: "2026-08-09T11:00:05.000Z",
        usagePoints: [
          {
            accountId: "account-1",
            granularity: "day",
            createdAt: 1_786_262_400,
            modelName: "model-a",
            requestCount: 6,
            tokenUsed: 1_500,
            quota: 300_000,
          },
        ],
      }),
    );

    const usage = store.listUsagePoints("account-1", "day");
    expect(usage).toHaveLength(1);
    expect(usage[0].requestCount).toBe(6);
    expect(usage[0].tokenUsed).toBe(1_500);
  });

  test("keeps historical accounts after credentials are removed", () => {
    const store = createStore();
    store.saveRun(snapshot());
    expect(store.listHistoricalAccounts()).toEqual([
      {
        accountId: "account-1",
        label: "Account 1",
        lastRunAt: "2026-08-09T10:00:00.000Z",
        lastStatus: "ok",
      },
    ]);
  });

  test("counts run outcomes without parsing historical payloads", () => {
    const store = createStore();
    store.saveRun(snapshot());
    store.saveRun(snapshot({
      startedAt: "2026-08-09T11:00:00.000Z",
      endedAt: "2026-08-09T11:00:05.000Z",
      status: "error",
      loggedOut: false,
      metrics: {},
      errorMessage: "test failure",
    }));
    expect(store.getRunStatusCounts()).toEqual({ successful: 1, failed: 1 });
  });

  test("records balance changes as credit observations without claiming causality", () => {
    const store = createStore();
    store.saveRun(snapshot());
    store.saveRun(
      snapshot({
        startedAt: "2026-08-09T12:00:00.000Z",
        endedAt: "2026-08-09T12:00:05.000Z",
        metrics: { ...snapshot().metrics, balance: 100.5, consumed: 20 },
        sessionReused: true,
      }),
    );
    const observations = store.listCreditObservations("account-1", 10);
    expect(observations).toHaveLength(2);
    expect(observations[0].classification).toBe("credit-increase");
    expect(observations[0].balanceDelta).toBe(25);
    expect(observations[0].sessionReused).toBe(true);
    expect(observations[1].classification).toBe("initial");
  });

  test("measures credit observation intervals between observation timestamps, not run starts", () => {
    const store = createStore();
    store.saveRun(
      snapshot({
        startedAt: "2026-08-09T10:00:00.000Z",
        endedAt: "2026-08-09T10:00:30.000Z",
      }),
    );
    const id = store.saveRun(
      snapshot({
        startedAt: "2026-08-09T11:00:00.000Z",
        endedAt: "2026-08-09T11:05:00.000Z",
      }),
    );
    const observation = store.getCreditObservationForRun(id);
    expect(observation?.observedAt).toBe("2026-08-09T11:05:00.000Z");
    expect(observation?.minutesSincePrevious).toBe(64.5);
  });

  test("deduplicates confirmed AgentRouter daily sign-in grants", () => {
    const store = createStore();
    const creditGrantEvents = [{
      sourceEventId: "log-42",
      occurredAt: 1_786_286_400,
      amount: 25,
      classification: "daily-signin",
      description: "每日签到成功，增加额度 ＄25.000000 额度",
    }];
    store.saveRun(snapshot({ summary: { creditGrantEvents } }));
    store.saveRun(snapshot({
      startedAt: "2026-08-09T11:00:00.000Z",
      endedAt: "2026-08-09T11:00:05.000Z",
      summary: { creditGrantEvents },
    }));

    const grants = store.listCreditGrantEvents("account-1", 10);
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(25);
    expect(grants[0].classification).toBe("daily-signin");
    expect(store.getLatestCreditGrantEventId()).toBe(grants[0].id);
    expect(store.listCreditGrantEventsAfterId(0)).toEqual(grants);
    expect(store.listCreditGrantEventsAfterId(grants[0].id)).toEqual([]);
    expect(store.getCreditObservationForRun(grants[0].runId)?.balance).toBe(75.5);
  });
});
