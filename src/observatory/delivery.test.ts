import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { createDashboardAuth } from "../dashboard-auth";
import { Store } from "../storage";
import { TelegramNotifier } from "../telegram";
import {
  categorizeDeliveryError,
  formatObservatoryEventMessage,
  ObservatoryDeliveryManager,
} from "./delivery";
import { createDeterministicFingerprint } from "./events";
import { ObservatoryStore } from "./store";
import type { StoredObservatoryEvent } from "./types";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "delivery-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function createTestConfig(dataDir: string): AppConfig {
  const dashboardAuth = createDashboardAuth({ host: "127.0.0.1" });
  return {
    baseUrl: "https://agentrouter.org",
    requestTimeoutMs: 1_000,
    loginTimeoutMs: 1_000,
    dashboardPort: 3100,
    dashboardHost: "127.0.0.1",
    dashboardAllowedOrigins: ["http://127.0.0.1:3100"],
    dataDir,
    screenshotDir: join(dataDir, "screenshots"),
    accountStateDir: join(dataDir, "states"),
    browserProfileDir: join(dataDir, "profiles"),
    browserChannel: "chromium",
    accountFilePath: join(dataDir, "accounts.json"),
    settingsFilePath: join(dataDir, "settings.json"),
    dbPath: ":memory:",
    antigravity: {
      enabled: false,
      dbPath: ":memory:",
      encryptionKey: null,
      probeIntervalMinutes: 5,
      probeTimeoutMs: 30_000,
      catalogIntervalMinutes: 60,
      oauthClientId: "test-client-id",
      oauthClientSecret: null,
      oauthRedirectUri: "http://localhost:51121/oauth-callback",
    },
    maxRecentRuns: 500,
    disableWebAuthn: true,
    telegram: {
      botToken: `12345678:${"A".repeat(40)}`,
      chatId: "123456789",
      allowedUsername: "testowner",
      stateFilePath: join(dataDir, "telegram.json"),
      lowBalanceUsd: 50,
      largeDropUsd: 25,
      repeatedFailureCount: 3,
      graphsEnabled: false,
      dashboardUrl: "http://127.0.0.1:3100",
    },
    ompQuota: {
      enabled: false,
      executable: "node_modules/.bin/omp",
      brokerUrl: null,
      stateFilePath: join(dataDir, "omp.json"),
      intervalMinutes: 5,
      timeoutMs: 45_000,
      lowRemainingPct: 10,
    },
    observatory: {
      enabled: true,
      dbPath: ":memory:",
      hmacKey: "a".repeat(32),
      ompExecutable: "node_modules/.bin/omp",
      ompVersion: "18.0.11",
      sourceHostId: "test-node",
      pollIntervalMinutes: 5,
      retentionDays: 14,
      retentionPruneIntervalMinutes: 60,
      deliveryLeaseDurationMs: 1_000,
      deliveryMaxRetries: 3,
      maxAccountsPerProvider: 10,
      perAccountTimeoutMs: 10_000,
      ompTimeoutMs: 215_000,
    },
    collector: {
      enabled: false,
      host: "127.0.0.1",
      port: 8457,
      publicOrigin: "https://bkserver.tailbbaa91.ts.net:8457",
      registryFilePath: null,
      tailscaleExecutablePath: null,
      proxyTokenFilePath: null,
    },
    dashboardAuth,
  };
}

describe("ObservatoryDeliveryManager durable outbox", () => {
  test("processes pending delivery and marks sent on Telegram success", async () => {
    const dir = await makeTempDir();
    const config = createTestConfig(dir);
    const store = new ObservatoryStore(":memory:");

    const sentCalls: string[] = [];
    const fakeNotifier = {
      sendObservatoryMessage: async (html: string) => {
        sentCalls.push(html);
        return { messageId: "msg-12345" };
      },
    } as unknown as TelegramNotifier;

    const manager = new ObservatoryDeliveryManager(store, fakeNotifier, config);

    // Record an event
    const { event } = store.recordEvent({
      eventType: "quota_warning",
      severity: "warning",
      fingerprint: "fp-test-1",
      occurredAt: new Date().toISOString(),
      hostId: "node-1",
      identityId: "id-openai",
    });

    // Enqueue delivery
    const fp = createDeterministicFingerprint("delivery", event.eventId, "telegram");
    const { delivery } = store.recordDeliveryAttempt({
      eventId: event.eventId,
      channel: "telegram",
      status: "pending",
      fingerprint: fp,
    });

    const result = await manager.processOutboxOnce();
    expect(result.processed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    const updated = store.getDelivery(delivery.deliveryId);
    expect(updated?.status).toBe("sent");
    expect(updated?.providerMessageId).toBe("msg-12345");
    expect(sentCalls[0]).toContain("Quota Warning");

    store.close();
  });

  test("never advances to sent on Telegram failure and allows retry up to maxRetries", async () => {
    const dir = await makeTempDir();
    const config = createTestConfig(dir);
    const store = new ObservatoryStore(":memory:");

    let shouldFail = true;
    const fakeNotifier = {
      sendObservatoryMessage: async () => {
        if (shouldFail) {
          throw new Error("Telegram 429 Too Many Requests: retry_after 5");
        }
        return { messageId: "msg-recovered" };
      },
    } as unknown as TelegramNotifier;

    const manager = new ObservatoryDeliveryManager(store, fakeNotifier, config, {
      leaseDurationMs: 100,
      maxRetries: 3,
    });

    const { event } = store.recordEvent({
      eventType: "quota_exhausted",
      severity: "critical",
      fingerprint: "fp-test-2",
      occurredAt: new Date().toISOString(),
    });

    const fp = createDeterministicFingerprint("delivery", event.eventId, "telegram");
    const { delivery } = store.recordDeliveryAttempt({
      eventId: event.eventId,
      channel: "telegram",
      status: "pending",
      fingerprint: fp,
    });

    // Attempt 1: Fails
    const result1 = await manager.processOutboxOnce();
    expect(result1.processed).toBe(1);
    expect(result1.failed).toBe(1);
    expect(result1.sent).toBe(0);

    const attempt1 = store.getDelivery(delivery.deliveryId);
    expect(attempt1?.status).toBe("failed");
    expect(attempt1?.attemptCount).toBe(1);
    expect(attempt1?.errorCategory).toBe("rate_limit");

    // Attempt 2: Recovered
    shouldFail = false;
    const result2 = await manager.processOutboxOnce();
    expect(result2.processed).toBe(1);
    expect(result2.sent).toBe(1);

    const attempt2 = store.getDelivery(delivery.deliveryId);
    expect(attempt2?.status).toBe("sent");
    expect(attempt2?.attemptCount).toBe(2);
    expect(attempt2?.providerMessageId).toBe("msg-recovered");

    store.close();
  });
});

describe("Delivery error categorization and message formatting", () => {
  test("categorizes various error scenarios correctly", () => {
    expect(categorizeDeliveryError(new Error("HTTP 429 Too Many Requests"))).toBe("rate_limit");
    expect(categorizeDeliveryError(new Error("401 Unauthorized bot token"))).toBe("auth");
    expect(categorizeDeliveryError(new Error("503 Service Unavailable"))).toBe("server_error");
    expect(categorizeDeliveryError(new Error("fetch failed: ECONNREFUSED"))).toBe("network");
    expect(categorizeDeliveryError(new Error("Bad Request: parse_mode invalid"))).toBe("invalid_payload");
    expect(categorizeDeliveryError(new Error("something weird"))).toBe("unknown");
  });

  test("formats safe message and excludes secrets/paths", () => {
    const event: StoredObservatoryEvent = {
      eventId: "evt-999",
      eventType: "quota_warning",
      severity: "warning",
      fingerprint: "fp-safe",
      occurredAt: "2026-09-01T12:00:00.000Z",
      hostId: "host-safe",
      identityId: "id-safe",
      createdAt: "2026-09-01T12:00:00.000Z",
    };

    const formatted = formatObservatoryEventMessage(event, "http://127.0.0.1:3100");
    expect(formatted).toContain("Quota Warning");
    expect(formatted).toContain("warning quota warning event");
    expect(formatted).toContain("<b>Host:</b> host-safe");
    expect(formatted).toContain("<b>Identity:</b> id-safe");
    expect(formatted).toContain("<a href=\"http://127.0.0.1:3100\">Open Fleet Observatory</a>");
  });
});
