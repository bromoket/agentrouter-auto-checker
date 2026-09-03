/**
 * Antigravity HTTP client: token refresh/exchange + direct endpoint probes.
 *
 * Request style mirrors gemini_stack token.ts/quota.ts. Every request carries an
 * Antigravity or Gemini-CLI User-Agent (never a generic one). Raw payload bodies are
 * parsed into narrow typed results; nothing is logged verbatim.
 */

import {
  buildAntigravityIdeHeaders,
  buildRandomizedAntigravityHeaders,
  GEMINI_CLI_HEADERS,
  type AntigravityHeaderSet,
} from "./constants";
import type { AntigravityCatalogModel, AntigravityModelBucket } from "./types";
import { normalizeModelBucket, normalizeIsoTimestamp } from "./aggregate";

export interface AntigravityOauthConfig {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
}

export interface AntigravityTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
  email: string | null;
}

export interface AntigravityClientFingerprint {
  deviceId?: unknown;
  sessionToken?: unknown;
  userAgent?: unknown;
  apiClient?: unknown;
  clientMetadata?: unknown;
  createdAt?: unknown;
}

export type HttpFetcher = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

export const defaultFetcher: HttpFetcher = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** Error carrying a stable category for failure tracking. */
export class AntigravityClientError extends Error {
  readonly category: "network" | "timeout" | "auth" | "server" | "payload" | "unknown";
  readonly status: number | null;
  constructor(
    message: string,
    options: { category?: AntigravityClientError["category"]; status?: number | null } = {},
  ) {
    super(message);
    this.name = "AntigravityClientError";
    this.category = options.category ?? "unknown";
    this.status = options.status ?? null;
  }
}

export function errorCategoryFrom(e: unknown): AntigravityClientError["category"] {
  if (e instanceof AntigravityClientError) return e.category;
  if (e instanceof DOMException && e.name === "AbortError") return "timeout";
  if (e instanceof TypeError) return "network";
  return "unknown";
}

export function toClientError(e: unknown, status?: number | null): AntigravityClientError {
  if (e instanceof AntigravityClientError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AntigravityClientError(message, {
    category: e instanceof DOMException && e.name === "AbortError" ? "timeout" : "network",
    status: status ?? null,
  });
}

function stripUndefinedHeaders(input: Record<string, string | undefined>): AntigravityHeaderSet {
  const out: AntigravityHeaderSet = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/** Build request headers from a stored per-account fingerprint; fallback to randomized. */
export function buildProbeHeaders(
  fingerprint: AntigravityClientFingerprint | null,
  version?: string,
): AntigravityHeaderSet {
  const metadata = fingerprint?.clientMetadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    const record = metadata as Record<string, unknown>;
    const platform = typeof record.platform === "string" ? record.platform : "MACOS";
    const versionPart = version ?? undefined;
    return stripUndefinedHeaders({
      "User-Agent":
        typeof fingerprint.userAgent === "string" && fingerprint.userAgent
          ? fingerprint.userAgent
          : buildAntigravityIdeHeaders(versionPart, platform)["User-Agent"],
      "X-Goog-Api-Client":
        typeof fingerprint.apiClient === "string" && fingerprint.apiClient
          ? fingerprint.apiClient
          : buildRandomizedAntigravityHeaders("antigravity", versionPart)["X-Goog-Api-Client"],
      "Client-Metadata": JSON.stringify(record),
    });
  }
  return buildRandomizedAntigravityHeaders("antigravity", version);
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
  timeoutMs: number,
  fetcher: HttpFetcher,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    }, timeoutMs);
  } catch (e) {
    throw toClientError(e);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new AntigravityClientError(`token endpoint ${response.status}: ${text.slice(0, 200)}`, {
      category: response.status === 401 || response.status === 403 ? "auth" : "server",
      status: response.status,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AntigravityClientError("token endpoint returned non-JSON payload", {
      category: "payload",
      status: response.status,
    });
  }
}

export interface RefreshAccessTokenParams {
  refreshToken: string;
  oauth: AntigravityOauthConfig;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

/** Refresh an access token via the Google OAuth token endpoint (Gemini-CLI UA). */
export async function refreshAccessToken(
  params: RefreshAccessTokenParams,
): Promise<{ accessToken: string; expiresInSec: number; refreshToken: string | null }> {
  if (!params.oauth.clientSecret) {
    throw new AntigravityClientError("Antigravity OAuth client secret is not configured.", {
      category: "auth",
    });
  }
  const payload = (await postForm(
    "https://oauth2.googleapis.com/token",
    {
      client_id: params.oauth.clientId,
      client_secret: params.oauth.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    },
    { "User-Agent": GEMINI_CLI_HEADERS["User-Agent"] },
    params.timeoutMs ?? 15_000,
    params.fetcher ?? defaultFetcher,
  )) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!accessToken) {
    throw new AntigravityClientError("Token refresh response missing access_token.", {
      category: "payload",
    });
  }
  const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken,
    refreshToken: refresh,
    expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}

export interface ExchangeAuthorizationCodeParams {
  code: string;
  codeVerifier: string;
  oauth: AntigravityOauthConfig;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

/** Exchange an authorization code (PKCE) for tokens + email. */
export async function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
): Promise<AntigravityTokenResult> {
  if (!params.oauth.clientSecret) {
    throw new AntigravityClientError("Antigravity OAuth client secret is not configured.", {
      category: "auth",
    });
  }
  const payload = (await postForm(
    "https://oauth2.googleapis.com/token",
    {
      client_id: params.oauth.clientId,
      client_secret: params.oauth.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.oauth.redirectUri,
      code_verifier: params.codeVerifier,
    },
    { "User-Agent": GEMINI_CLI_HEADERS["User-Agent"] },
    params.timeoutMs ?? 15_000,
    params.fetcher ?? defaultFetcher,
  )) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  if (!accessToken || !refreshToken) {
    throw new AntigravityClientError("Token exchange missing access/refresh token.", {
      category: "payload",
    });
  }
  const expiresIn = Number(payload.expires_in);
  const email = await fetchUserEmail(accessToken, params.timeoutMs ?? 15_000, params.fetcher ?? defaultFetcher);
  return {
    accessToken,
    refreshToken,
    expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    email,
  };
}

export async function fetchUserEmail(
  accessToken: string,
  timeoutMs = 15_000,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<string | null> {
  try {
    const response = await fetcher(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
        },
      },
      timeoutMs,
    );
    if (!response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return typeof data.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

async function postJsonProbe(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetcher: HttpFetcher,
): Promise<{ status: number; data: unknown }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        ...headers,
      },
      body: JSON.stringify(body),
    }, timeoutMs);
  } catch (e) {
    throw toClientError(e);
  }
  const text = await response.text().catch(() => "");
  if (response.status >= 500) {
    throw new AntigravityClientError(`probe ${response.status}`, {
      category: "server",
      status: response.status,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AntigravityClientError(`probe ${response.status}: ${text.slice(0, 160)}`, {
      category: "auth",
      status: response.status,
    });
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new AntigravityClientError("probe returned non-JSON payload", {
        category: "payload",
        status: response.status,
      });
    }
  }
  return { status: response.status, data };
}

/** Try the given POST body against each endpoint until one returns 200. */
async function probeEndpoints<T>(
  endpoints: readonly string[],
  methodName: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetcher: HttpFetcher,
  parse: (data: unknown) => T,
): Promise<{ endpoint: string; value: T }> {
  let lastError: AntigravityClientError | null = null;
  for (const endpoint of endpoints) {
    try {
      const result = await postJsonProbe(`${endpoint}/${methodName}`, headers, body, timeoutMs, fetcher);
      if (result.status === 404 || result.status === 400) {
        lastError = new AntigravityClientError(`${methodName} ${result.status} at ${endpoint}`, {
          category: "server",
          status: result.status,
        });
        continue;
      }
      if (result.status !== 200) {
        throw new AntigravityClientError(`${methodName} ${result.status} at ${endpoint}`, {
          category: result.status === 401 || result.status === 403 ? "auth" : "server",
          status: result.status,
        });
      }
      return { endpoint, value: parse(result.data) };
    } catch (e) {
      lastError = e instanceof AntigravityClientError ? e : toClientError(e);
      if (lastError.category === "auth") throw lastError; // do not retry auth failures on other endpoints
    }
  }
  throw lastError ?? new AntigravityClientError(`${methodName} failed on all endpoints`, { category: "unknown" });
}

export interface LoadCodeAssistResult {
  endpoint: string;
  projectId: string | null;
  currentTierId: string | null;
  currentTierName: string | null;
  paidTierId: string | null;
  availableCredits: number | null;
  verificationRequired: boolean;
  gcpManaged: boolean;
}

function parseCreditCount(data: unknown): number | null {
  const record = (data ?? {}) as Record<string, unknown>;
  const paid = record.paidTier as Record<string, unknown> | null | undefined;
  if (!paid || typeof paid !== "object") return null;
  const credits = paid.availableCredits;
  if (Array.isArray(credits)) {
    let sum = 0;
    for (const entry of credits) {
      if (typeof entry === "number") {
        sum += entry;
      } else if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        const numeric = ["count", "remaining", "amount", "available"].map((k) => item[k]);
        const value = numeric.find((v) => typeof v === "number" && Number.isFinite(v as number));
        if (value !== undefined) sum += value as number;
      }
    }
    return sum;
  }
  if (typeof credits === "number" && Number.isFinite(credits)) {
    return Math.max(0, credits);
  }
  return null;
}

/** loadCodeAssist: project discovery + tier/credit/verification state. */
export async function loadCodeAssist(
  accessToken: string,
  endpoints: readonly string[],
  headers: Record<string, string>,
  timeoutMs: number,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<LoadCodeAssistResult> {
  const parse = (data: unknown): LoadCodeAssistResult => {
    const record = (data ?? {}) as Record<string, unknown>;
    let projectId: string | null = null;
    const rawProject = record.cloudaicompanionProject;
    if (typeof rawProject === "string" && rawProject) {
      projectId = rawProject;
    } else if (rawProject && typeof rawProject === "object") {
      const id = (rawProject as Record<string, unknown>).id;
      if (typeof id === "string" && id) projectId = id;
    }
    const currentTier = (record.currentTier ?? {}) as Record<string, unknown>;
    const paidTier = (record.paidTier ?? {}) as Record<string, unknown>;
    return {
      endpoint: "",
      projectId,
      currentTierId: typeof currentTier.id === "string" ? currentTier.id : null,
      currentTierName: typeof currentTier.name === "string" ? currentTier.name : null,
      paidTierId: typeof paidTier.id === "string" ? paidTier.id : null,
      availableCredits: parseCreditCount(record),
      verificationRequired: Boolean(record.verificationRequired),
      gcpManaged: Boolean(record.gcpManaged),
    };
  };
  const { endpoint, value } = await probeEndpoints(
    endpoints,
    "v1internal:loadCodeAssist",
    { Authorization: `Bearer ${accessToken}`, ...headers },
    { metadata: { ideType: "ANTIGRAVITY", platform: "MACOS", pluginType: "GEMINI" } },
    timeoutMs,
    fetcher,
    parse,
  );
  return { ...value, endpoint };
}

/** retrieveUserQuota: per-model buckets (WTUS via IDE headers, REQUESTS via CLI headers). */
export async function retrieveUserQuota(
  accessToken: string,
  projectId: string,
  endpoints: readonly string[],
  headers: Record<string, string>,
  timeoutMs: number,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<{ endpoint: string; buckets: AntigravityModelBucket[] }> {
  const parse = (data: unknown): AntigravityModelBucket[] => {
    const record = (data ?? {}) as Record<string, unknown>;
    if (!Array.isArray(record.buckets)) {
      throw new AntigravityClientError("retrieveUserQuota missing buckets array", {
        category: "payload",
      });
    }
    const buckets: AntigravityModelBucket[] = [];
    for (const raw of record.buckets) {
      if (!raw || typeof raw !== "object") continue;
      const bucket = normalizeModelBucket(raw as Record<string, unknown>);
      if (bucket) buckets.push(bucket);
    }
    return buckets;
  };
  const { endpoint, value } = await probeEndpoints(
    endpoints,
    "v1internal:retrieveUserQuota",
    { Authorization: `Bearer ${accessToken}`, ...headers },
    { project: projectId },
    timeoutMs,
    fetcher,
    parse,
  );
  return { endpoint, buckets: value };
}

/** fetchAvailableModels: catalog display + per-model quota info. */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  endpoints: readonly string[],
  headers: Record<string, string>,
  timeoutMs: number,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<{ endpoint: string; models: AntigravityCatalogModel[] }> {
  const parse = (data: unknown): AntigravityCatalogModel[] => {
    const record = (data ?? {}) as Record<string, unknown>;
    const models = record.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      throw new AntigravityClientError("fetchAvailableModels missing models map", {
        category: "payload",
      });
    }
    const out: AntigravityCatalogModel[] = [];
    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const quotaInfo = (entry.quotaInfo ?? {}) as Record<string, unknown>;
      const provider = typeof entry.modelProvider === "string" ? entry.modelProvider : null;
      const remaining = quotaInfo.remainingFraction;
      out.push({
        modelId,
        displayName: typeof entry.displayName === "string" ? entry.displayName : modelId,
        modelProvider:
          typeof provider === "string" && /^[a-z0-9-]{1,32}$/i.test(provider) ? provider : "unknown",
        quotaRemainingFraction:
          typeof remaining === "number" && Number.isFinite(remaining)
            ? Math.min(1, Math.max(0, remaining))
            : typeof remaining === "string" && remaining.trim()
              ? Math.min(1, Math.max(0, Number(remaining)))
              : null,
        quotaResetTime: normalizeIsoTimestamp(
          typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : null,
        ),
      });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  };
  const { endpoint, value } = await probeEndpoints(
    endpoints,
    "v1internal:fetchAvailableModels",
    { Authorization: `Bearer ${accessToken}`, ...headers },
    { project: projectId },
    timeoutMs,
    fetcher,
    parse,
  );
  return { endpoint, models: value };
}

/** Gemini-CLI-style quota probe (fixed CLI headers, PROD endpoint). */
export async function retrieveCliQuota(
  accessToken: string,
  projectId: string,
  endpoint: string,
  timeoutMs: number,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<AntigravityModelBucket[]> {
  const parse = (data: unknown): AntigravityModelBucket[] => {
    const record = (data ?? {}) as Record<string, unknown>;
    if (!Array.isArray(record.buckets)) {
      throw new AntigravityClientError("CLI retrieveUserQuota missing buckets array", {
        category: "payload",
      });
    }
    const buckets: AntigravityModelBucket[] = [];
    for (const raw of record.buckets) {
      if (!raw || typeof raw !== "object") continue;
      const bucket = normalizeModelBucket(raw as Record<string, unknown>);
      if (bucket) buckets.push(bucket);
    }
    return buckets;
  };
  const result = await probeEndpoints(
    [endpoint],
    "v1internal:retrieveUserQuota",
    { ...GEMINI_CLI_HEADERS, Authorization: `Bearer ${accessToken}` },
    { project: projectId },
    timeoutMs,
    fetcher,
    parse,
  );
  return result.value;
}
