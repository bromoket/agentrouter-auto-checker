/**
 * Platform-safe child process environment allowlists and sanitizers.
 *
 * Prevents sensitive environment variables (Telegram tokens, broker credentials,
 * dashboard auth passwords, GitHub tokens, AgentRouter secrets, etc.) from leaking
 * to spawned child workers (Playwright browser worker and chart renderer).
 */

export type ChildEnvSource = Record<string, string | undefined> | NodeJS.ProcessEnv;

/**
 * Explicit allowlist of environment variables permitted for the browser worker.
 * Contains only required runtime, Playwright, display, home, temp, path, and platform variables.
 */
export const BROWSER_WORKER_ALLOWLIST: Record<string, true> = {
  // Platform & System Paths
  ALLUSERSPROFILE: true,
  APPDATA: true,
  COMMONPROGRAMFILES: true,
  "COMMONPROGRAMFILES(X86)": true,
  COMMONPROGRAMW6432: true,
  COMPUTERNAME: true,
  COMSPEC: true,
  DRIVERDATA: true,
  HOME: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  HOSTNAME: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NUMBER_OF_PROCESSORS: true,
  OS: true,
  PATH: true,
  PATHEXT: true,
  PROCESSOR_ARCHITECTURE: true,
  PROCESSOR_ARCHITEW6432: true,
  PROCESSOR_IDENTIFIER: true,
  PROCESSOR_LEVEL: true,
  PROCESSOR_REVISION: true,
  PROGRAMDATA: true,
  PROGRAMFILES: true,
  "PROGRAMFILES(X86)": true,
  PROGRAMW6432: true,
  PSMODULEPATH: true,
  PUBLIC: true,
  SHELL: true,
  SYSTEMDRIVE: true,
  SYSTEMROOT: true,
  TERM: true,
  TERM_PROGRAM: true,
  USER: true,
  USERNAME: true,
  USERPROFILE: true,
  WINDIR: true,

  // Temp Dirs
  TEMP: true,
  TMP: true,
  TMPDIR: true,

  // Display, Desktop & Linux subsystem
  DBUS_SESSION_BUS_ADDRESS: true,
  DISPLAY: true,
  WAYLAND_DISPLAY: true,
  XAUTHORITY: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_DIRS: true,
  XDG_CONFIG_HOME: true,
  XDG_CURRENT_DESKTOP: true,
  XDG_DATA_DIRS: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
  XDG_SESSION_DESKTOP: true,
  XDG_SESSION_TYPE: true,

  // Runtime, Locale & Proxy
  ALL_PROXY: true,
  FONTCONFIG_FILE: true,
  FONTCONFIG_PATH: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  LANG: true,
  LC_ALL: true,
  LC_COLLATE: true,
  LC_CTYPE: true,
  LC_MESSAGES: true,
  LC_MONETARY: true,
  LC_NUMERIC: true,
  LC_TIME: true,
  NODE_BINARY: true,
  NODE_ENV: true,
  NODE_EXTRA_CA_CERTS: true,
  NODE_NO_WARNINGS: true,
  NODE_OPTIONS: true,
  NODE_PATH: true,
  NO_PROXY: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  TZ: true,

  // Playwright & Browser binaries
  CHROME_BIN: true,
  CHROME_DEVEL_SANDBOX: true,
  CHROME_PATH: true,
  CHROMIUM_BIN: true,
  CHROMIUM_PATH: true,
  PLAYWRIGHT_BROWSERS_PATH: true,
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: true,
  PLAYWRIGHT_DOWNLOAD_HOST: true,
  PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH: true,
  PLAYWRIGHT_NODEJS_PATH: true,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: true,
  PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH: true,
};

/**
 * Explicit allowlist of environment variables permitted for the chart worker.
 * Minimal set required for Node execution, fonts, temp files, and Playwright screenshot rendering.
 */
export const CHART_WORKER_ALLOWLIST: Record<string, true> = {
  // Minimal Platform & Path
  ALLUSERSPROFILE: true,
  APPDATA: true,
  COMMONPROGRAMFILES: true,
  "COMMONPROGRAMFILES(X86)": true,
  COMMONPROGRAMW6432: true,
  COMSPEC: true,
  HOME: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NUMBER_OF_PROCESSORS: true,
  OS: true,
  PATH: true,
  PATHEXT: true,
  PROCESSOR_ARCHITECTURE: true,
  PROCESSOR_ARCHITEW6432: true,
  PROCESSOR_IDENTIFIER: true,
  PROCESSOR_LEVEL: true,
  PROCESSOR_REVISION: true,
  PROGRAMDATA: true,
  PROGRAMFILES: true,
  "PROGRAMFILES(X86)": true,
  PROGRAMW6432: true,
  PUBLIC: true,
  SYSTEMDRIVE: true,
  SYSTEMROOT: true,
  USER: true,
  USERNAME: true,
  USERPROFILE: true,
  WINDIR: true,

  // Temp Dirs
  TEMP: true,
  TMP: true,
  TMPDIR: true,

  // Runtime, Locale & Fonts (displayless)
  CHROME_BIN: true,
  CHROME_PATH: true,
  CHROMIUM_BIN: true,
  CHROMIUM_PATH: true,
  FONTCONFIG_FILE: true,
  FONTCONFIG_PATH: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LC_MESSAGES: true,
  NODE_BINARY: true,
  NODE_ENV: true,
  NODE_NO_WARNINGS: true,
  NODE_OPTIONS: true,
  PLAYWRIGHT_BROWSERS_PATH: true,
  TZ: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
};

/**
 * Secret variable prefixes that must never be passed to child processes.
 */
export const FORBIDDEN_ENV_PREFIXES: readonly string[] = [
  "AGENTROUTER_",
  "ANTHROPIC_",
  "AWS_",
  "AZURE_",
  "COLLECTOR_",
  "DASHBOARD_",
  "DISCORD_",
  "GCP_",
  "GEMINI_",
  "GH_",
  "GITHUB_",
  "GOOGLE_",
  "OBSERVATORY_",
  "OMP_",
  "OPENAI_",
  "PROVIDER_",
  "SLACK_",
  "TELEGRAM_",
];

/**
 * Explicit forbidden environment variable names.
 */
export const FORBIDDEN_ENV_NAMES: Record<string, true> = {
  ACCOUNT_STATE_DIR: true,
  AGENTROUTER_API_TOKEN: true,
  AGENTROUTER_AUTH: true,
  AGENTROUTER_KEY: true,
  AGENTROUTER_PASSWORD: true,
  AGENTROUTER_SECRET: true,
  AGENTROUTER_TOKEN: true,
  AI_API_KEY: true,
  ANTHROPIC_API_KEY: true,
  BASE_URL: true,
  BROWSER_PROFILE_DIR: true,
  CODEX_API_KEY: true,
  COLLECTOR_AUTH: true,
  COLLECTOR_KEY: true,
  COLLECTOR_SECRET: true,
  COLLECTOR_TOKEN: true,
  DASHBOARD_ALLOWED_ORIGINS: true,
  DASHBOARD_API_KEY: true,
  DASHBOARD_HOST: true,
  DASHBOARD_PORT: true,
  DASHBOARD_URL: true,
  DATA_DIR: true,
  DB_PATH: true,
  GEMINI_API_KEY: true,
  GH_ENTERPRISE_TOKEN: true,
  GH_TOKEN: true,
  GITHUB_API_TOKEN: true,
  GITHUB_AUTH: true,
  GITHUB_ENTERPRISE_TOKEN: true,
  GITHUB_PASSWORD: true,
  GITHUB_PAT: true,
  GITHUB_SECRET: true,
  GITHUB_TOKEN: true,
  LOGIN_TIMEOUT_MS: true,
  OBSERVATORY_SECRET: true,
  OBSERVATORY_TOKEN: true,
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_AUTH_BROKER_URL: true,
  OMP_BROKER_TOKEN: true,
  OMP_BROKER_URL: true,
  OMP_EXECUTABLE: true,
  OMP_QUOTA_ENABLED: true,
  OMP_QUOTA_INTERVAL_MINUTES: true,
  OMP_QUOTA_LOW_REMAINING_PCT: true,
  OMP_QUOTA_STATE_FILE: true,
  OMP_QUOTA_TIMEOUT_MS: true,
  OPENAI_API_KEY: true,
  REQUEST_TIMEOUT_MS: true,
  SCREENSHOT_DIR: true,
  TELEGRAM_ALLOWED_USERNAME: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  TELEGRAM_DASHBOARD_URL: true,
  TELEGRAM_LARGE_DROP_USD: true,
  TELEGRAM_LOW_BALANCE_USD: true,
  TELEGRAM_REPEATED_FAILURE_COUNT: true,
  TELEGRAM_STATE_FILE: true,
};

/**
 * Regular expression patterns matching sensitive credential and secret variable names.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /API[_-]?KEY/i,
  /AUTH[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
  /CREDENTIAL/i,
  /BEARER/i,
];

/**
 * Checks whether an environment variable key is safe and allowed for child processes.
 */
export function isAllowedEnvKey(
  key: string,
  allowlist: Record<string, true>,
): boolean {
  if (typeof key !== "string") return false;
  const upper = key.trim().toUpperCase();
  if (!upper) return false;

  // Must be in allowlist
  if (!allowlist[upper]) return false;

  // Must not match any explicit forbidden names
  if (FORBIDDEN_ENV_NAMES[upper]) return false;

  // Must not start with any forbidden prefix
  for (const prefix of FORBIDDEN_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) return false;
  }

  // Must not match any secret patterns
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(upper)) return false;
  }

  return true;
}

/**
 * Filters a source environment object against an allowlist and denylist.
 * Excludes undefined or non-string values and returns an isolated plain object.
 */
export function sanitizeChildEnv(
  sourceEnv: ChildEnvSource = process.env,
  allowlist: Record<string, true> = BROWSER_WORKER_ALLOWLIST,
  extraEnv?: ChildEnvSource,
): Record<string, string> {
  const result: Record<string, string> = {};

  const processEntries = (source?: ChildEnvSource) => {
    if (!source || typeof source !== "object") return;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string") continue;
      if (!isAllowedEnvKey(key, allowlist)) continue;
      result[key] = value;
    }
  };

  processEntries(sourceEnv);
  if (extraEnv) {
    processEntries(extraEnv);
  }

  return result;
}

/**
 * Builds a sanitized, platform-safe environment object for the browser worker child process.
 */
export function buildBrowserWorkerEnv(
  sourceEnv: ChildEnvSource = process.env,
  extraEnv?: ChildEnvSource,
): Record<string, string> {
  return sanitizeChildEnv(sourceEnv, BROWSER_WORKER_ALLOWLIST, extraEnv);
}

/**
 * Builds a sanitized, minimal environment object for the chart worker child process.
 */
export function buildChartWorkerEnv(
  sourceEnv: ChildEnvSource = process.env,
  extraEnv?: ChildEnvSource,
): Record<string, string> {
  return sanitizeChildEnv(sourceEnv, CHART_WORKER_ALLOWLIST, extraEnv);
}
