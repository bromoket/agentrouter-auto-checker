import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("loadConfig dashboard network controls", () => {
  test("defaults to loopback-only origins", () => {
    delete process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_ALLOWED_ORIGINS;

    const config = loadConfig();
    expect(config.dashboardHost).toBe("127.0.0.1");
    expect(config.dashboardAllowedOrigins).toEqual([
      "http://127.0.0.1:3100",
      "http://localhost:3100",
    ]);
  });

  test("keeps collector ingestion disabled on registered loopback defaults", () => {
    delete process.env.COLLECTOR_ENABLED;
    const config = loadConfig();
    expect(config.collector.enabled).toBe(false);
    expect(config.collector.host).toBe("127.0.0.1");
    expect(config.collector.port).toBe(8457);
    expect(config.collector.registryFilePath).toBeNull();
    expect(config.collector.tailscaleExecutablePath).toBeNull();
  });

  test("rejects cleartext non-loopback dashboard binds", () => {
    process.env.DASHBOARD_HOST = "100.127.29.78";
    process.env.DASHBOARD_PORT = "8456";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";
    process.env.DASHBOARD_API_KEY = "k".repeat(32);

    expect(() => loadConfig()).toThrow("Cleartext non-loopback dashboard binds are forbidden");
  });

  test("rejects wildcard binds and cross-port origins", () => {
    process.env.DASHBOARD_HOST = "0.0.0.0";
    expect(() => loadConfig()).toThrow("exact loopback or private interface");

    process.env.DASHBOARD_HOST = "8.8.8.8";
    expect(() => loadConfig()).toThrow("exact loopback or private interface");

    process.env.DASHBOARD_HOST = "100.127.29.78";
    process.env.DASHBOARD_PORT = "8456";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "http://bkserver:9999";
    expect(() => loadConfig()).toThrow("using DASHBOARD_PORT");
  });
});

describe("loadConfig Telegram controls", () => {
  test("keeps Telegram disabled when no recipient is configured", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ALLOWED_USERNAME;

    const config = loadConfig();
    expect(config.telegram.botToken).toBeNull();
    expect(config.telegram.chatId).toBeNull();
    expect(config.telegram.allowedUsername).toBeNull();
  });

  test("requires a token, numeric chat id, and username together", () => {
    process.env.TELEGRAM_BOT_TOKEN = `12345678:${"A".repeat(40)}`;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ALLOWED_USERNAME;
    expect(() => loadConfig()).toThrow("must be configured together");
  });

  test("normalizes and validates a private Telegram recipient", () => {
    process.env.TELEGRAM_BOT_TOKEN = `12345678:${"A".repeat(40)}`;
    process.env.TELEGRAM_CHAT_ID = "123456789";
    process.env.TELEGRAM_ALLOWED_USERNAME = "@BromoketOne";
    process.env.TELEGRAM_LOW_BALANCE_USD = "40";
    process.env.TELEGRAM_LARGE_DROP_USD = "15";
    process.env.TELEGRAM_REPEATED_FAILURE_COUNT = "4";
    process.env.TELEGRAM_DASHBOARD_URL = "http://100.127.29.78:8456/";

    const config = loadConfig();
    expect(config.telegram.allowedUsername).toBe("bromoketone");
    expect(config.telegram.lowBalanceUsd).toBe(40);
    expect(config.telegram.largeDropUsd).toBe(15);
    expect(config.telegram.repeatedFailureCount).toBe(4);
    expect(config.telegram.dashboardUrl).toBe("http://100.127.29.78:8456");
  });
});

describe("loadConfig OMP quota controls", () => {
  test("keeps OMP quota disabled by default with standard fallbacks", () => {
    delete process.env.OMP_QUOTA_ENABLED;
    delete process.env.OMP_AUTH_BROKER_URL;
    delete process.env.OMP_AUTH_BROKER_TOKEN;
    delete process.env.OMP_EXECUTABLE;

    const config = loadConfig();
    expect(config.ompQuota.enabled).toBe(false);
    expect(config.ompQuota.executable).toBe("node_modules/.bin/omp");
    expect(config.ompQuota.brokerUrl).toBeNull();
    expect(config.ompQuota.intervalMinutes).toBe(5);
    expect(config.ompQuota.timeoutMs).toBe(45_000);
    expect(config.ompQuota.lowRemainingPct).toBe(10);
    expect(config.ompQuota.stateFilePath).toBe("data/omp-quota-state.json");
  });

  test("requires broker URL and broker token when enabled", () => {
    process.env.OMP_QUOTA_ENABLED = "true";
    delete process.env.OMP_AUTH_BROKER_URL;
    delete process.env.OMP_AUTH_BROKER_TOKEN;
    expect(() => loadConfig()).toThrow("OMP_AUTH_BROKER_URL is required");

    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    delete process.env.OMP_AUTH_BROKER_TOKEN;
    expect(() => loadConfig()).toThrow("OMP_AUTH_BROKER_TOKEN is required");
  });

  test("rejects broker URLs with public IPs, credentials, query parameters, or non-http protocols", () => {
    process.env.OMP_QUOTA_ENABLED = "true";
    process.env.OMP_AUTH_BROKER_TOKEN = "secret-token";

    process.env.OMP_AUTH_BROKER_URL = "http://8.8.8.8:8765";
    expect(() => loadConfig()).toThrow("loopback or private interface address");

    process.env.OMP_AUTH_BROKER_URL = "http://user:pass@127.0.0.1:8765";
    expect(() => loadConfig()).toThrow("embedded credentials");

    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765?foo=bar";
    expect(() => loadConfig()).toThrow("query parameters or fragments");

    process.env.OMP_AUTH_BROKER_URL = "ftp://127.0.0.1:8765";
    expect(() => loadConfig()).toThrow("HTTP or HTTPS");
  });

  test("loads valid enabled configuration with bounds and custom paths", () => {
    process.env.OMP_QUOTA_ENABLED = "1";
    process.env.OMP_AUTH_BROKER_URL = "http://100.127.29.78:8765/";
    process.env.OMP_AUTH_BROKER_TOKEN = "secret-token-value";
    process.env.OMP_EXECUTABLE = "/opt/agentrouter-monitor/node_modules/.bin/omp";
    process.env.OMP_QUOTA_INTERVAL_MINUTES = "15";
    process.env.OMP_QUOTA_TIMEOUT_MS = "30000";
    process.env.OMP_QUOTA_LOW_REMAINING_PCT = "20";
    process.env.OMP_QUOTA_STATE_FILE = "/var/lib/agentrouter-monitor/data/omp-state.json";

    const config = loadConfig();
    expect(config.ompQuota.enabled).toBe(true);
    expect(config.ompQuota.brokerUrl).toBe("http://100.127.29.78:8765");
    expect(config.ompQuota.executable).toBe("/opt/agentrouter-monitor/node_modules/.bin/omp");
    expect(config.ompQuota.intervalMinutes).toBe(15);
    expect(config.ompQuota.timeoutMs).toBe(30_000);
    expect(config.ompQuota.lowRemainingPct).toBe(20);
    expect(config.ompQuota.stateFilePath).toBe("/var/lib/agentrouter-monitor/data/omp-state.json");
    // Ensure token is never retained on config.
    expect("brokerToken" in config.ompQuota).toBe(false);
  });

  test("enforces bounds on intervalMinutes and lowRemainingPct", () => {
    process.env.OMP_QUOTA_ENABLED = "0";
    process.env.OMP_QUOTA_INTERVAL_MINUTES = "0"; // below min 1
    process.env.OMP_QUOTA_LOW_REMAINING_PCT = "150"; // above max 100

    const config = loadConfig();
    expect(config.ompQuota.intervalMinutes).toBe(5); // fallback
    expect(config.ompQuota.lowRemainingPct).toBe(10); // fallback
  });
});

describe("loadConfig Observatory controls", () => {
  test("keeps Observatory disabled by default with standard fallbacks", () => {
    delete process.env.OBSERVATORY_ENABLED;
    delete process.env.OBSERVATORY_DB_PATH;
    delete process.env.OBSERVATORY_HMAC_KEY;
    delete process.env.OBSERVATORY_SECRET;

    const config = loadConfig();
    expect(config.observatory.enabled).toBe(false);
    expect(config.observatory.dbPath).toBe("data/observatory.sqlite");
    expect(config.observatory.hmacKey).toBeNull();
    expect(config.observatory.pollIntervalMinutes).toBe(5);
    expect(config.observatory.retentionDays).toBe(14);
    expect(config.observatory.retentionPruneIntervalMinutes).toBe(60);
    expect(config.observatory.deliveryLeaseDurationMs).toBe(30_000);
    expect(config.observatory.deliveryMaxRetries).toBe(5);
    expect(config.dashboardAuth.enabled).toBe(false);
  });

  test("requires HMAC key of at least 32 bytes when enabled", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    delete process.env.OBSERVATORY_HMAC_KEY;
    delete process.env.OBSERVATORY_SECRET;

    expect(() => loadConfig()).toThrow("OBSERVATORY_HMAC_KEY is required");

    process.env.OBSERVATORY_HMAC_KEY = "short_key_under_32_bytes";
    expect(() => loadConfig()).toThrow("must be at least 32 bytes");
  });

  test("rejects shared database path with AgentRouter checks DB", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    process.env.OBSERVATORY_HMAC_KEY = "a".repeat(32);
    process.env.DB_PATH = "data/checks.sqlite";
    process.env.OBSERVATORY_DB_PATH = "data/checks.sqlite";

    expect(() => loadConfig()).toThrow("separate from the AgentRouter DB path");
  });

  test("loads valid enabled configuration with legacy poller disabled", () => {
    process.env.OBSERVATORY_ENABLED = "1";
    process.env.OBSERVATORY_HMAC_KEY = "01234567890123456789012345678901";
    process.env.OBSERVATORY_DB_PATH = "data/custom-observatory.sqlite";
    process.env.OBSERVATORY_SOURCE_HOST_ID = "host-alpha";
    process.env.OMP_QUOTA_ENABLED = "false";
    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    process.env.OMP_AUTH_BROKER_TOKEN = "broker-secret-token";
    process.env.OBSERVATORY_OMP_EXECUTABLE = process.platform === "win32" ? "C:\\opt\\omp.cmd" : "/opt/omp";
    process.env.OBSERVATORY_OMP_VERSION = "18.0.11";
    process.env.OBSERVATORY_POLL_INTERVAL_MINUTES = "10";
    process.env.OBSERVATORY_RETENTION_DAYS = "30";
    process.env.OBSERVATORY_RETENTION_PRUNE_INTERVAL_MINUTES = "120";
    process.env.OBSERVATORY_DELIVERY_LEASE_DURATION_MS = "45000";
    process.env.OBSERVATORY_DELIVERY_MAX_RETRIES = "10";
    process.env.DASHBOARD_API_KEY = "k".repeat(32);
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";

    const config = loadConfig();
    expect(config.ompQuota.enabled).toBe(false);
    expect(config.ompQuota.brokerUrl).toBe("http://127.0.0.1:8765");
    expect(config.observatory.enabled).toBe(true);
    expect(config.observatory.dbPath).toBe("data/custom-observatory.sqlite");
    expect(config.observatory.sourceHostId).toBe("host-alpha");
    expect(config.observatory.ompVersion).toBe("18.0.11");
    expect(config.observatory.pollIntervalMinutes).toBe(10);
    expect(config.observatory.retentionDays).toBe(30);
    expect(config.observatory.retentionPruneIntervalMinutes).toBe(120);
    expect(config.observatory.deliveryLeaseDurationMs).toBe(45_000);
    expect(config.observatory.deliveryMaxRetries).toBe(10);
  });
  test("rejects simultaneous legacy and Observatory quota pollers", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    process.env.OBSERVATORY_HMAC_KEY = "a".repeat(32);
    process.env.OBSERVATORY_OMP_EXECUTABLE = process.platform === "win32" ? "C:\\opt\\omp.cmd" : "/opt/omp";
    process.env.OBSERVATORY_OMP_VERSION = "18.0.11";
    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    process.env.OMP_AUTH_BROKER_TOKEN = "broker-secret-token";
    process.env.OMP_QUOTA_ENABLED = "true";
    process.env.DASHBOARD_API_KEY = "k".repeat(32);
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";

    expect(() => loadConfig()).toThrow("OMP_QUOTA_ENABLED must remain false when Observatory is enabled");
  });

  test("requires broker URL and token when Observatory is enabled independently", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    process.env.OBSERVATORY_HMAC_KEY = "a".repeat(32);
    process.env.OBSERVATORY_OMP_EXECUTABLE = process.platform === "win32" ? "C:\\opt\\omp.cmd" : "/opt/omp";
    process.env.OBSERVATORY_OMP_VERSION = "18.0.11";
    process.env.DASHBOARD_API_KEY = "k".repeat(32);
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";
    process.env.OMP_QUOTA_ENABLED = "false";
    delete process.env.OMP_AUTH_BROKER_URL;
    delete process.env.OMP_AUTH_BROKER_TOKEN;
    expect(() => loadConfig()).toThrow("OMP_AUTH_BROKER_URL is required when Observatory is enabled");

    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    expect(() => loadConfig()).toThrow("OMP_AUTH_BROKER_TOKEN is required when Observatory is enabled");
  });

  test("does not leak secret keys in error messages", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    const secretKey = "super_secret_short_key_123";
    process.env.OBSERVATORY_HMAC_KEY = secretKey;

    try {
      loadConfig();
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretKey);
    }
  });
});

describe("loadConfig dashboard API key auth controls", () => {
  test("rejects legacy username/password configuration", () => {
    process.env.DASHBOARD_AUTH_USERNAME = "owner";
    expect(() => loadConfig()).toThrow(
      "Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.",
    );

    delete process.env.DASHBOARD_AUTH_USERNAME;
    process.env.DASHBOARD_AUTH_PASSWORD = "secret-password";
    expect(() => loadConfig()).toThrow(
      "Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.",
    );
  });

  test("requires DASHBOARD_API_KEY when Observatory is enabled", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    process.env.OBSERVATORY_HMAC_KEY = "a".repeat(32);
    process.env.OBSERVATORY_OMP_EXECUTABLE = process.platform === "win32" ? "C:\\opt\\omp.cmd" : "/opt/omp";
    process.env.OBSERVATORY_OMP_VERSION = "18.0.11";
    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    process.env.OMP_AUTH_BROKER_TOKEN = "broker-secret-token";
    process.env.OMP_QUOTA_ENABLED = "false";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";
    delete process.env.DASHBOARD_API_KEY;

    expect(() => loadConfig()).toThrow("DASHBOARD_API_KEY is required when Observatory is enabled.");
  });

  test("rejects DASHBOARD_API_KEY under 32 bytes", () => {
    process.env.OBSERVATORY_ENABLED = "true";
    process.env.OBSERVATORY_HMAC_KEY = "a".repeat(32);
    process.env.OBSERVATORY_OMP_EXECUTABLE = process.platform === "win32" ? "C:\\opt\\omp.cmd" : "/opt/omp";
    process.env.OBSERVATORY_OMP_VERSION = "18.0.11";
    process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
    process.env.OMP_AUTH_BROKER_TOKEN = "broker-secret-token";
    process.env.OMP_QUOTA_ENABLED = "false";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bkserver.tailbbaa91.ts.net";
    process.env.DASHBOARD_API_KEY = "short-key-under-32-bytes";

    expect(() => loadConfig()).toThrow("DASHBOARD_API_KEY must be at least 32 bytes.");
  });

  test("never leaks raw DASHBOARD_API_KEY in error messages", () => {
    const rawKey = "my-secret-key-that-is-short";
    process.env.DASHBOARD_API_KEY = rawKey;

    try {
      loadConfig();
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(rawKey);
    }
  });
});
