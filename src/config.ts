import { isIP } from "node:net";

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
}

const DEFAULT_BASE_URL = "https://agentrouter.org";

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
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      Number(url.port || "80") !== port
    ) {
      throw new Error(
        "DASHBOARD_ALLOWED_ORIGINS must contain comma-separated HTTP origins using DASHBOARD_PORT.",
      );
    }
    defaults.push(url.origin);
  }

  return [...new Set(defaults)];
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  const dashboardPort = parsePositiveInteger("DASHBOARD_PORT", 3100);
  const dashboardHost = normalizeDashboardHost(process.env.DASHBOARD_HOST || "127.0.0.1");

  return {
    baseUrl: normalizeBaseUrl(process.env.BASE_URL?.trim() || DEFAULT_BASE_URL),
    requestTimeoutMs: parsePositiveInteger("REQUEST_TIMEOUT_MS", 45_000),
    loginTimeoutMs: parsePositiveInteger("LOGIN_TIMEOUT_MS", 120_000),
    dashboardPort,
    dashboardHost,
    dashboardAllowedOrigins: normalizeDashboardOrigins(
      process.env.DASHBOARD_ALLOWED_ORIGINS,
      dashboardHost,
      dashboardPort,
    ),
    dataDir,
    screenshotDir: process.env.SCREENSHOT_DIR?.trim() || `${dataDir}/screenshots`,
    accountStateDir: process.env.ACCOUNT_STATE_DIR?.trim() || `${dataDir}/states`,
    browserProfileDir: process.env.BROWSER_PROFILE_DIR?.trim() || `${dataDir}/browser-profiles`,
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || "chromium",
    accountFilePath: process.env.ACCOUNT_FILE?.trim() || `${dataDir}/accounts.json`,
    settingsFilePath: process.env.SETTINGS_FILE?.trim() || `${dataDir}/settings.json`,
    dbPath: process.env.DB_PATH?.trim() || `${dataDir}/checks.sqlite`,
    maxRecentRuns: parsePositiveInteger("MAX_RECENT_RUNS", 500),
    disableWebAuthn: parseBoolean("DISABLE_WEBAUTHN", true),
  };
}
