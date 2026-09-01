import { isIP } from "node:net";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { createDashboardAuth, type DashboardAuth } from "./dashboard-auth";

export interface AppConfig {
  baseUrl: string;
  requestTimeoutMs: number;
  loginTimeoutMs: number;
  dashboardPort: number;
  dashboardHost: string;
  dashboardAllowedOrigins: string[];
  dataDir: string;
  screenshotDir: string;
  accountStateDir: string;
  browserProfileDir: string;
  browserChannel: string;
  accountFilePath: string;
  settingsFilePath: string;
  dbPath: string;
  maxRecentRuns: number;
  disableWebAuthn: boolean;
  telegram: TelegramConfig;
  ompQuota: OmpQuotaConfig;
  observatory: ObservatoryConfig;
  collector: CollectorConfig;
  dashboardAuth: DashboardAuth;
}

export interface CollectorConfig {
  enabled: boolean;
  host: "127.0.0.1";
  port: 8457;
  publicOrigin: "https://bkserver.tailbbaa91.ts.net:8457";
  registryFilePath: string | null;
  tailscaleExecutablePath: string | null;
  proxyTokenFilePath: string | null;
}

export interface ObservatoryConfig {
  enabled: boolean;
  dbPath: string;
  hmacKey: string | null;
  ompExecutable: string;
  ompVersion: string | null;
  sourceHostId: string;
  pollIntervalMinutes: number;
  retentionDays: number;
  retentionPruneIntervalMinutes: number;
  deliveryLeaseDurationMs: number;
  deliveryMaxRetries: number;
  maxAccountsPerProvider: number;
  perAccountTimeoutMs: number;
  ompTimeoutMs: number;
}

export interface OmpQuotaConfig {
  enabled: boolean;
  executable: string;
  brokerUrl: string | null;
  stateFilePath: string;
  intervalMinutes: number;
  timeoutMs: number;
  lowRemainingPct: number;
}
export interface TelegramConfig {
  botToken: string | null;
  chatId: string | null;
  allowedUsername: string | null;
  stateFilePath: string;
  lowBalanceUsd: number;
  largeDropUsd: number;
  repeatedFailureCount: number;
  graphsEnabled: boolean;
  dashboardUrl: string;
}

const DEFAULT_BASE_URL = "https://agentrouter.org";
export const REGISTERED_DASHBOARD_PUBLIC_ORIGIN = "https://bkserver.tailbbaa91.ts.net";
export const REGISTERED_COLLECTOR_PUBLIC_ORIGIN = "https://bkserver.tailbbaa91.ts.net:8457";
function parsePositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

function parseNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function parseBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseBoundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeBrokerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OMP_AUTH_BROKER_URL must be a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("OMP_AUTH_BROKER_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("OMP_AUTH_BROKER_URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("OMP_AUTH_BROKER_URL must not contain query parameters or fragments.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && !isPrivateOrLoopbackIp(host)) {
    throw new Error("OMP_AUTH_BROKER_URL must point to a loopback or private interface address.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function loadOmpQuotaConfig(dataDir: string): OmpQuotaConfig {
  const enabled = parseBoolean("OMP_QUOTA_ENABLED", false);
  const rawBrokerUrl = process.env.OMP_AUTH_BROKER_URL?.trim();
  const brokerToken = process.env.OMP_AUTH_BROKER_TOKEN?.trim();

  if (enabled) {
    if (!rawBrokerUrl) {
      throw new Error("OMP_AUTH_BROKER_URL is required when OMP quota monitoring is enabled.");
    }
    if (!brokerToken) {
      throw new Error("OMP_AUTH_BROKER_TOKEN is required when OMP quota monitoring is enabled.");
    }
  }

  const brokerUrl = rawBrokerUrl ? normalizeBrokerUrl(rawBrokerUrl) : null;

  return {
    enabled,
    executable: process.env.OMP_EXECUTABLE?.trim() || "node_modules/.bin/omp",
    brokerUrl,
    stateFilePath: process.env.OMP_QUOTA_STATE_FILE?.trim() || `${dataDir}/omp-quota-state.json`,
    intervalMinutes: parseBoundedInteger("OMP_QUOTA_INTERVAL_MINUTES", 5, 1, 1440),
    timeoutMs: parsePositiveInteger("OMP_QUOTA_TIMEOUT_MS", 45_000),
    lowRemainingPct: parseBoundedNumber("OMP_QUOTA_LOW_REMAINING_PCT", 10, 0, 100),
  };
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("BASE_URL must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeDashboardHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (host === "localhost" || isPrivateOrLoopbackIp(host)) {
    return host;
  }
  throw new Error("DASHBOARD_HOST must be an exact loopback or private interface address.");
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127);
  }
  if (family === 6) {
    return host === "::1" || /^(f[cd]|fe[89ab])/i.test(host);
  }
  return false;
}

function originForHost(host: string, port: number): string {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function normalizeDashboardOrigins(raw: string | undefined, host: string, port: number): string[] {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const defaults = host === "127.0.0.1" || host === "::1" || host === "localhost"
    ? [originForHost("127.0.0.1", port), originForHost("localhost", port)]
    : [originForHost(host, port)];

  for (const value of values) {
    const url = new URL(value);
    const specifiedPort = url.port ? Number(url.port) : null;
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (specifiedPort !== null && (specifiedPort < 1 || specifiedPort > 65_535)) ||
      (url.protocol === "http:" && Number(url.port || "80") !== port)
    ) {
      throw new Error(
        "DASHBOARD_ALLOWED_ORIGINS must contain comma-separated HTTP origins using DASHBOARD_PORT (or HTTPS origins).",
      );
    }
    defaults.push(url.origin);
  }

  return [...new Set(defaults)];
}

function loadTelegramConfig(dataDir: string, dashboardHost: string, dashboardPort: number): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || null;
  const allowedUsername = process.env.TELEGRAM_ALLOWED_USERNAME?.trim().replace(/^@/, "").toLowerCase() || null;
  if (botToken && !/^\d{8,12}:[A-Za-z0-9_-]{30,80}$/.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN has an invalid format.");
  }
  if (chatId && !/^-?\d{5,20}$/.test(chatId)) {
    throw new Error("TELEGRAM_CHAT_ID must be a numeric private chat or group id.");
  }
  if (allowedUsername && !/^[a-z0-9_]{5,32}$/.test(allowedUsername)) {
    throw new Error("TELEGRAM_ALLOWED_USERNAME has an invalid Telegram username format.");
  }
  if ((botToken || chatId || allowedUsername) && !(botToken && chatId && allowedUsername)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_ALLOWED_USERNAME must be configured together.",
    );
  }

  const dashboardUrl = new URL(
    process.env.TELEGRAM_DASHBOARD_URL?.trim() || originForHost(dashboardHost, dashboardPort),
  );
  if (!["http:", "https:"].includes(dashboardUrl.protocol) || dashboardUrl.username || dashboardUrl.password) {
    throw new Error("TELEGRAM_DASHBOARD_URL must be an HTTP(S) URL without embedded credentials.");
  }
  dashboardUrl.pathname = dashboardUrl.pathname.replace(/\/$/, "");
  dashboardUrl.search = "";
  dashboardUrl.hash = "";

  return {
    botToken,
    chatId,
    allowedUsername,
    stateFilePath: process.env.TELEGRAM_STATE_FILE?.trim() || `${dataDir}/telegram-state.json`,
    lowBalanceUsd: parseNonNegativeNumber("TELEGRAM_LOW_BALANCE_USD", 50),
    largeDropUsd: parseNonNegativeNumber("TELEGRAM_LARGE_DROP_USD", 25),
    repeatedFailureCount: parsePositiveInteger("TELEGRAM_REPEATED_FAILURE_COUNT", 3),
    graphsEnabled: parseBoolean("TELEGRAM_GRAPHS_ENABLED", true),
    dashboardUrl: dashboardUrl.toString().replace(/\/$/, ""),
  };
}

function loadCollectorConfig(): CollectorConfig {
  const enabled = parseBoolean("COLLECTOR_ENABLED", false);
  const host = process.env.COLLECTOR_HOST?.trim() || "127.0.0.1";
  const port = parsePositiveInteger("COLLECTOR_PORT", 8457);
  const publicOrigin = process.env.COLLECTOR_PUBLIC_ORIGIN?.trim() || REGISTERED_COLLECTOR_PUBLIC_ORIGIN;
  const registryFilePath = process.env.COLLECTOR_REGISTRY_FILE?.trim() || null;
  const tailscaleExecutablePath = process.env.COLLECTOR_TAILSCALE_EXECUTABLE?.trim() || null;
  const proxyTokenFilePath = process.env.COLLECTOR_PROXY_TOKEN_FILE?.trim() || null;

  if (enabled) {
    if (process.platform === "win32") {
      throw new Error("Collector ingestion is unsupported on Windows because secure POSIX secret ownership cannot be enforced.");
    }
    if (host !== "127.0.0.1" || port !== 8457) {
      throw new Error("Collector ingestion must listen on 127.0.0.1:8457 behind a trusted TLS proxy.");
    }
    if (publicOrigin !== REGISTERED_COLLECTOR_PUBLIC_ORIGIN) {
      throw new Error(`COLLECTOR_PUBLIC_ORIGIN must be ${REGISTERED_COLLECTOR_PUBLIC_ORIGIN}.`);
    }
    if (!registryFilePath || !isAbsolute(registryFilePath)) {
      throw new Error("COLLECTOR_REGISTRY_FILE must be an absolute path to the service-owned secret registry.");
    }
    if (!tailscaleExecutablePath || !isAbsolute(tailscaleExecutablePath)) {
      throw new Error("COLLECTOR_TAILSCALE_EXECUTABLE must be an absolute path to the pinned Tailscale CLI.");
    }
    if (!proxyTokenFilePath || !isAbsolute(proxyTokenFilePath)) {
      throw new Error("COLLECTOR_PROXY_TOKEN_FILE must be an absolute systemd credential path.");
    }
  }

  return {
    enabled,
    host: "127.0.0.1",
    port: 8457,
    publicOrigin: REGISTERED_COLLECTOR_PUBLIC_ORIGIN,
    registryFilePath,
    tailscaleExecutablePath,
    proxyTokenFilePath,
  };
}

function loadObservatoryConfig(
  dataDir: string,
  ompQuota: OmpQuotaConfig,
  agentRouterDbPath: string,
): ObservatoryConfig {
  const enabled = parseBoolean("OBSERVATORY_ENABLED", false);
  const rawDbPath = process.env.OBSERVATORY_DB_PATH?.trim() || `${dataDir}/observatory.sqlite`;
  const hmacKey = process.env.OBSERVATORY_HMAC_KEY?.trim() || process.env.OBSERVATORY_SECRET?.trim() || null;
  const ompExecutable =
    process.env.OBSERVATORY_OMP_EXECUTABLE?.trim() ||
    process.env.OMP_EXECUTABLE?.trim() ||
    ompQuota.executable ||
    "node_modules/.bin/omp";
  const ompVersion = process.env.OBSERVATORY_OMP_VERSION?.trim() || null;
  const sourceHostId =
    process.env.OBSERVATORY_SOURCE_HOST_ID?.trim() ||
    (typeof process.env.HOSTNAME === "string" && process.env.HOSTNAME.trim()
      ? process.env.HOSTNAME.trim()
      : hostname() || "local-host");
  const pollIntervalMinutes = parseBoundedInteger("OBSERVATORY_POLL_INTERVAL_MINUTES", 5, 1, 1440);
  const retentionDays = parseBoundedInteger("OBSERVATORY_RETENTION_DAYS", 14, 1, 3650);
  const retentionPruneIntervalMinutes = parseBoundedInteger(
    "OBSERVATORY_RETENTION_PRUNE_INTERVAL_MINUTES",
    60,
    1,
    1440,
  );
  const deliveryLeaseDurationMs = parseBoundedInteger(
    "OBSERVATORY_DELIVERY_LEASE_DURATION_MS",
    30_000,
    1_000,
    300_000,
  );
  const deliveryMaxRetries = parseBoundedInteger("OBSERVATORY_DELIVERY_MAX_RETRIES", 5, 1, 50);
  const maxAccountsPerProvider = parseBoundedInteger(
    "OBSERVATORY_MAX_ACCOUNTS_PER_PROVIDER",
    10,
    1,
    100,
  );
  const perAccountTimeoutMs = 10_000;
  const minimumOmpTimeoutMs = perAccountTimeoutMs * (maxAccountsPerProvider * 2 + 1) + 5_000;
  const rawOmpTimeoutMs = process.env.OBSERVATORY_OMP_TIMEOUT_MS?.trim();
  let ompTimeoutMs = minimumOmpTimeoutMs;
  if (rawOmpTimeoutMs) {
    const parsed = Number.parseInt(rawOmpTimeoutMs, 10);
    if (!Number.isSafeInteger(parsed) || parsed < minimumOmpTimeoutMs) {
      throw new Error(
        "OBSERVATORY_OMP_TIMEOUT_MS is inconsistent with OBSERVATORY_MAX_ACCOUNTS_PER_PROVIDER.",
      );
    }
    ompTimeoutMs = parsed;
  }

  if (enabled) {
    if (!hmacKey) {
      throw new Error("OBSERVATORY_HMAC_KEY is required when AI Fleet Observatory is enabled.");
    }
    if (Buffer.from(hmacKey, "utf8").length < 32) {
      throw new Error("OBSERVATORY_HMAC_KEY must be at least 32 bytes.");
    }
    if (agentRouterDbPath !== ":memory:" && rawDbPath !== ":memory:" && rawDbPath === agentRouterDbPath) {
      throw new Error("OBSERVATORY_DB_PATH must be separate from the AgentRouter DB path.");
    }
    if (!isAbsolute(ompExecutable)) {
      throw new Error("OBSERVATORY_OMP_EXECUTABLE must be an absolute path when Observatory is enabled.");
    }
    if (ompVersion !== "18.0.11") {
      throw new Error("OBSERVATORY_OMP_VERSION must be the verified version 18.0.11.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceHostId)) {
      throw new Error("OBSERVATORY_SOURCE_HOST_ID must be a normalized opaque host identifier.");
    }
    if (!ompQuota.brokerUrl) {
      throw new Error("OMP_AUTH_BROKER_URL is required when Observatory is enabled.");
    }
    if (!process.env.OMP_AUTH_BROKER_TOKEN?.trim()) {
      throw new Error("OMP_AUTH_BROKER_TOKEN is required when Observatory is enabled.");
    }
  }

  return {
    enabled,
    dbPath: rawDbPath,
    hmacKey,
    ompExecutable,
    ompVersion,
    sourceHostId,
    pollIntervalMinutes,
    retentionDays,
    retentionPruneIntervalMinutes,
    deliveryLeaseDurationMs,
    deliveryMaxRetries,
    maxAccountsPerProvider,
    perAccountTimeoutMs,
    ompTimeoutMs,
  };
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  const dashboardPort = parsePositiveInteger("DASHBOARD_PORT", 3100);
  const dashboardHost = normalizeDashboardHost(process.env.DASHBOARD_HOST || "127.0.0.1");
  const dashboardAllowedOrigins = normalizeDashboardOrigins(
    process.env.DASHBOARD_ALLOWED_ORIGINS,
    dashboardHost,
    dashboardPort,
  );
  const dbPath = process.env.DB_PATH?.trim() || `${dataDir}/checks.sqlite`;
  const ompQuota = loadOmpQuotaConfig(dataDir);
  const observatory = loadObservatoryConfig(dataDir, ompQuota, dbPath);
  const collector = loadCollectorConfig();
  if (collector.enabled && !observatory.enabled) {
    throw new Error("Collector ingestion requires Observatory to be enabled with its separate database.");
  }
  if (observatory.enabled && ompQuota.enabled) {
    throw new Error("OMP_QUOTA_ENABLED must remain false when Observatory is enabled; the legacy poller is not compatible with the Observatory probe lock.");
  }
  const dashboardAuth = createDashboardAuth({
    host: dashboardHost,
    observatoryEnabled: observatory.enabled,
  });

  if (!dashboardAuth.isLoopback) {
    throw new Error("Cleartext non-loopback dashboard binds are forbidden; listen on loopback behind Tailscale Serve HTTPS.");
  }
  if (observatory.enabled) {
    if (!dashboardAuth.enabled) {
      throw new Error("Owner dashboard authentication is required when Observatory is enabled.");
    }
    if (!dashboardAllowedOrigins.includes(REGISTERED_DASHBOARD_PUBLIC_ORIGIN)) {
      throw new Error(`DASHBOARD_ALLOWED_ORIGINS must include ${REGISTERED_DASHBOARD_PUBLIC_ORIGIN} when Observatory is enabled.`);
    }
  }

  return {
    baseUrl: normalizeBaseUrl(process.env.BASE_URL?.trim() || DEFAULT_BASE_URL),
    requestTimeoutMs: parsePositiveInteger("REQUEST_TIMEOUT_MS", 45_000),
    loginTimeoutMs: parsePositiveInteger("LOGIN_TIMEOUT_MS", 120_000),
    dashboardPort,
    dashboardHost,
    dashboardAllowedOrigins,
    dataDir,
    screenshotDir: process.env.SCREENSHOT_DIR?.trim() || `${dataDir}/screenshots`,
    accountStateDir: process.env.ACCOUNT_STATE_DIR?.trim() || `${dataDir}/states`,
    browserProfileDir: process.env.BROWSER_PROFILE_DIR?.trim() || `${dataDir}/browser-profiles`,
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || "chromium",
    accountFilePath: process.env.ACCOUNT_FILE?.trim() || `${dataDir}/accounts.json`,
    settingsFilePath: process.env.SETTINGS_FILE?.trim() || `${dataDir}/settings.json`,
    dbPath,
    maxRecentRuns: parsePositiveInteger("MAX_RECENT_RUNS", 500),
    disableWebAuthn: parseBoolean("DISABLE_WEBAUTHN", true),
    telegram: loadTelegramConfig(dataDir, dashboardHost, dashboardPort),
    ompQuota,
    observatory,
    collector,
    dashboardAuth,
  };
}
