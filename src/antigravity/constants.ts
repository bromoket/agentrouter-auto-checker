/**
 * Antigravity direct-account integration constants.
 *
 * Ported from gemini_stack (packages/plugin/src/constants.ts) — verified against the
 * working OpenCode PoC and raw endpoint probes. Values are kept byte-for-byte where they
 * are server-visible identifiers; do not "clean up" endpoint names, UAs, or client ids.
 */

export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

/** Default loopback callback used by the Antigravity OAuth client registration. */
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

/** Quota probe fallback order: prod -> daily -> autopush (mirrors gemini_stack). */
export const ANTIGRAVITY_ENDPOINT_FALLBACKS: readonly string[] = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

/** Project discovery / loadCodeAssist order: prod first, then fallbacks. */
export const ANTIGRAVITY_LOAD_ENDPOINTS: readonly string[] = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

/** Hardcoded fallback project used when the server returns none (business/workspace). */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

/** Version fallback from the Antigravity Hub updater manifest (2026-08-15). */
export const ANTIGRAVITY_VERSION_FALLBACK = "2.8.1";

export const ANTIGRAVITY_PLATFORMS = [
  "windows/amd64",
  "darwin/arm64",
  "darwin/amd64",
] as const;

export const ANTIGRAVITY_API_CLIENTS = [
  "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "google-cloud-sdk vscode/1.96.0",
  "google-cloud-sdk vscode/1.95.0",
] as const;

/** All header values must be concrete strings (undefined keys are stripped by builders). */
export type AntigravityHeaderSet = Record<string, string>;

/** Fixed header set for Gemini-CLI-style requests (token exchange, CLI quota). */
export const GEMINI_CLI_HEADERS: AntigravityHeaderSet = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

/** Full IDE-style Electron headers (used for loadCodeAssist and quota probes). */
export function buildAntigravityIdeHeaders(
  version = ANTIGRAVITY_VERSION_FALLBACK,
  platform = "darwin",
): AntigravityHeaderSet {
  const metadataPlatform = platform === "win32" || platform === "windows" ? "WINDOWS" : "MACOS";
  return {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${version} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${metadataPlatform}","pluginType":"GEMINI"}`,
  };
}

/** Randomized header style used to vary per-request identity (port of getRandomizedHeaders). */
export function buildRandomizedAntigravityHeaders(
  style: "antigravity" | "gemini-cli" = "antigravity",
  version = ANTIGRAVITY_VERSION_FALLBACK,
): AntigravityHeaderSet {
  if (style === "gemini-cli") {
    return { ...GEMINI_CLI_HEADERS };
  }
  const platform = ANTIGRAVITY_PLATFORMS[Math.floor(Math.random() * ANTIGRAVITY_PLATFORMS.length)]!;
  const metadataPlatform = platform.startsWith("windows") ? "WINDOWS" : "MACOS";
  const apiClient = ANTIGRAVITY_API_CLIENTS[Math.floor(Math.random() * ANTIGRAVITY_API_CLIENTS.length)]!;
  return {
    "User-Agent": `antigravity/${version} ${platform}`,
    "X-Goog-Api-Client": apiClient,
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${metadataPlatform}","pluginType":"GEMINI"}`,
  };
}
