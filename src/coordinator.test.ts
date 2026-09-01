import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "./accounts";
import { AuthenticationChallengeBroker } from "./challenges";
import type { AppConfig } from "./config";
import { CheckCoordinator } from "./coordinator";
import { createDashboardAuth } from "./dashboard-auth";
import { ObservatoryCoordinator } from "./observatory/coordinator";
import { ObservatoryStore } from "./observatory/store";
import { OmpQuotaPoller } from "./omp-quota";
import { SettingsStore } from "./settings";
import { Store } from "./storage";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function createTestConfig(directory: string, ompQuotaEnabled = false, observatoryEnabled = false): AppConfig {
  return {
    baseUrl: "https://agentrouter.org",
    requestTimeoutMs: 1_000,
    loginTimeoutMs: 1_000,
    dashboardPort: 3100,
    dashboardHost: "127.0.0.1",
    dashboardAllowedOrigins: ["http://127.0.0.1:3100"],
    dataDir: directory,
    screenshotDir: join(directory, "screenshots"),
    accountStateDir: join(directory, "states"),
    browserProfileDir: join(directory, "profiles"),
    browserChannel: "chromium",
    accountFilePath: join(directory, "accounts.json"),
    settingsFilePath: join(directory, "settings.json"),
    dbPath: ":memory:",
    maxRecentRuns: 500,
    disableWebAuthn: true,
    telegram: {
      botToken: null,
      chatId: null,
      allowedUsername: null,
      stateFilePath: join(directory, "telegram-state.json"),
      lowBalanceUsd: 50,
      largeDropUsd: 25,
      repeatedFailureCount: 3,
      graphsEnabled: false,
      dashboardUrl: "http://127.0.0.1:3100",
    },
    ompQuota: {
      enabled: ompQuotaEnabled,
      executable: "node_modules/.bin/omp",
      brokerUrl: ompQuotaEnabled || observatoryEnabled ? "http://127.0.0.1:8765" : null,
      stateFilePath: join(directory, "omp-quota-state.json"),
      intervalMinutes: 5,
      timeoutMs: 45_000,
      lowRemainingPct: 10,
    },
    observatory: {
      enabled: observatoryEnabled,
      dbPath: ":memory:",
      hmacKey: "a".repeat(32),
      ompExecutable: "node_modules/.bin/omp",
      ompVersion: "18.0.11",
      sourceHostId: "test-host",
      pollIntervalMinutes: 5,
      retentionDays: 14,
      retentionPruneIntervalMinutes: 60,
      deliveryLeaseDurationMs: 30_000,
      deliveryMaxRetries: 5,
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
    dashboardAuth: createDashboardAuth({
      env: { DASHBOARD_AUTH_DISABLED: "true" },
      host: "127.0.0.1",
    }),
  };
}

describe("CheckCoordinator OMP quota loop", () => {
  test("starts quota loop independently on scheduler start without blocking account runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
    temporaryDirectories.push(dir);
    const config = createTestConfig(dir, true);
    const store = new Store(":memory:");
    const accounts = new AccountStore(config.accountFilePath);
    const settings = new SettingsStore(config.settingsFilePath);
    const challenges = new AuthenticationChallengeBroker();

    let resolveProbe!: () => void;
    const probeFired = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });

    let quotaPollCount = 0;
    const mockExecutor = async () => {
      quotaPollCount += 1;
      resolveProbe();
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
                window: { id: "7d", resetsAt: now + 500_000_000 },
                amount: { usedFraction: 0.1, remainingFraction: 0.9 },
              },
            ],
          },
        ],
      };
    };

    const poller = new OmpQuotaPoller(config.ompQuota, null, 3, mockExecutor);
    const coordinator = new CheckCoordinator(store, accounts, config, settings, challenges, null, poller);

    coordinator.startScheduler();

    await probeFired;

    expect(quotaPollCount).toBeGreaterThanOrEqual(1);

    const status = coordinator.getStatus();
    expect(status.schedulerActive).toBe(true);
    expect(status.running).toBe(false);
  });

  test("does not start quota loop when ompQuota is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
    temporaryDirectories.push(dir);
    const config = createTestConfig(dir, false);
    const store = new Store(":memory:");
    const accounts = new AccountStore(config.accountFilePath);
    const settings = new SettingsStore(config.settingsFilePath);
    const challenges = new AuthenticationChallengeBroker();

    let quotaPollCount = 0;
    const mockExecutor = async () => {
      quotaPollCount += 1;
      return {};
    };

    const poller = new OmpQuotaPoller(config.ompQuota, null, 3, mockExecutor);
    const coordinator = new CheckCoordinator(store, accounts, config, settings, challenges, null, poller);

    coordinator.startScheduler();
    await Promise.resolve();

    expect(quotaPollCount).toBe(0);
  });
});

describe("ObservatoryCoordinator probe failure isolation and run ingestion", () => {
  test("isolates probe failure without throwing or stopping coordinator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coordinator-obs-test-"));
    temporaryDirectories.push(dir);
    const config = createTestConfig(dir, false, true);
    const obsStore = new ObservatoryStore(":memory:");

    // Failing OMP probe executor
    const failingExecutor = async () => {
      throw new Error("OMP CLI probe failed: network timeout");
    };

    const obsCoordinator = new ObservatoryCoordinator(obsStore, config, null, failingExecutor);

    // Probing should catch and isolate the error
    await obsCoordinator.pollOnce();

    const status = obsCoordinator.getStatus();
    expect(status.lastProbeStatus).toBe("error");
    expect(status.lastProbeError).toBe("OMP_USAGE_TIMEOUT: Probe execution timed out");
    expect(status.lastProbeError).not.toContain("network timeout");
    expect(status.consecutiveProbeFailures).toBe(1);
    obsStore.close();
  });

  test("runs one normalized Observatory loop while legacy quota poller is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coordinator-obs-success-test-"));
    temporaryDirectories.push(dir);
    const config = createTestConfig(dir, false, true);
    const obsStore = new ObservatoryStore(":memory:");
    const observedAt = new Date().toISOString();
    const obsCoordinator = new ObservatoryCoordinator(obsStore, config, null, async () => ({
      observedAt,
      identities: [{
        identityId: "b".repeat(64),
        kind: "credential",
        provider: "openai-codex",
        sourceHostId: "test-host",
        sourceVersion: "18.0.11",
        label: "OpenAI Codex (bbbbbbbb)",
        observedAt,
        health: "healthy",
      }],
      quotas: [{
        identityId: "b".repeat(64),
        provider: "openai-codex",
        windowId: "5h",
        observedAt,
        usedFraction: 0.25,
        remainingFraction: 0.75,
        source: "omp-usage",
        sourceVersion: "18.0.11",
      }],
      capacity: null,
      stats: { totalReports: 1, totalLimits: 1, totalIdentities: 1, totalDisabled: 0, totalWithoutUsage: 0 },
    }));

    expect(config.ompQuota.enabled).toBe(false);
    await obsCoordinator.pollOnce();
    expect(obsCoordinator.getStatus().lastProbeStatus).toBe("ok");
    expect(obsStore.listIdentities()).toHaveLength(1);
    expect(obsStore.listCurrentQuotaWindows()).toHaveLength(1);
    obsStore.close();
  });
});
