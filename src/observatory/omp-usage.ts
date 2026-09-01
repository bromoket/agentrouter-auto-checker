import { createHmac } from "node:crypto";
import { delimiter, dirname, isAbsolute } from "node:path";
import type {
  ProviderHealth,
  ProviderIdentityKind,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "./types";

export type UsageUnit =
  | "percent"
  | "tokens"
  | "requests"
  | "credits"
  | "usd"
  | "minutes"
  | "bytes"
  | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Time window for a limit (e.g. 5h, 7d, monthly) in OMP 18.0.11 */
export interface UsageWindow {
  id: string;
  label: string;
  durationMs?: number;
  resetsAt?: number;
  resetLabel?: string;
}

/** Quantitative usage data in OMP 18.0.11 */
export interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit: UsageUnit;
}

/** Scope metadata in OMP 18.0.11 */
export interface UsageScope {
  provider: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
  shared?: boolean;
}

/** Normalized limit entry in OMP 18.0.11 */
export interface UsageLimit {
  id: string;
  label: string;
  scope: UsageScope;
  window?: UsageWindow;
  amount: UsageAmount;
  status?: UsageStatus;
  notes?: string[];
}

/** Reset credit detail in OMP 18.0.11 */
export interface UsageResetCreditDetail {
  grantedAt?: string;
  expiresAt?: string;
  status?: string;
}

/** Reset credits container in OMP 18.0.11 */
export interface UsageResetCredits {
  availableCount: number;
  credits?: UsageResetCreditDetail[];
}

/** Usage report for a provider credential in OMP 18.0.11 */
export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  resetCredits?: UsageResetCredits;
  notes?: string[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/** Identity of an account without usage in OMP 18.0.11 */
export interface UsageAccountIdentity {
  provider: string;
  type: "api_key" | "oauth";
  email?: string;
  accountId?: string;
  projectId?: string;
  enterpriseUrl?: string;
  orgId?: string;
  orgName?: string;
  authorizedAt?: number;
}

/** Summary of a disabled credential in OMP 18.0.11 */
export interface DisabledCredentialSummary {
  id: number;
  provider: string;
  type: "api_key" | "oauth";
  email?: string;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  cause: string;
  disabledAtMs?: number;
}

/** Per-window capacity stat in OMP 18.0.11 */
export interface ProviderWindowStat {
  window: string;
  durationMs?: number;
  meter?: string;
  accounts: number;
  usedAccounts: number;
  remainingAccounts: number;
}

/** Wire JSON envelope emitted by `omp usage --json` */
export interface OmpUsageResponse {
  generatedAt: number;
  reports: UsageReport[];
  accountsWithoutUsage: UsageAccountIdentity[];
  disabledCredentials: DisabledCredentialSummary[];
  capacity: Record<string, ProviderWindowStat[]>;
}

export interface OmpUsageNormalizeOptions {
  /**
   * Secret key used to generate opaque HMAC-SHA256 identity IDs.
   * MUST be at least 32 bytes of cryptographically secure material.
   */
  hmacKey: string | Buffer | Uint8Array;
  /**
   * Logical fleet host identifier (default: "local-omp").
   */
  hostId?: string;
  /**
   * Current epoch ms or Date for reference time (default: Date.now()).
   */
  now?: number | Date;
  /**
   * Maximum observation age before considered stale (default: 15 minutes = 900,000 ms).
   */
  maxStaleMs?: number;
  /**
   * Maximum future clock skew allowed for observation timestamp (default: 60,000 ms).
   */
  maxFutureSkewMs?: number;
  /**
   * Maximum payload byte size allowed (default: 2 MB).
   */
  maxPayloadBytes?: number;
  /**
   * Maximum number of reports allowed in payload (default: 50).
   */
  maxReportsCount?: number;
  /**
   * Maximum number of limits per report allowed (default: 50).
   */
  maxLimitsPerReport?: number;
  /**
   * Target providers to retain (default: ["openai-codex", "google-antigravity"]).
   */
  /** Trusted pinned collector version. Defaults only for direct normalization tests. */
  sourceVersion?: "18.0.11";
  targetProviders?: string[];
}

export interface NormalizedOmpUsage {
  observedAt: string;
  identities: ProviderIdentityObservation[];
  quotas: QuotaObservationInput[];
  capacity: Record<string, ProviderWindowStat[]> | null;
  stats: {
    totalReports: number;
    totalLimits: number;
    totalIdentities: number;
    totalDisabled: number;
    totalWithoutUsage: number;
  };
}

const DOMAIN_PROVIDER_IDENTITY = "Observatory/provider-identity/v1";

/**
 * Validates HMAC key material and returns a Buffer of at least 32 bytes.
 */
export function validateHmacKey(key: string | Buffer | Uint8Array): Buffer {
  let buf: Buffer;
  if (typeof key === "string") {
    buf = Buffer.from(key, "utf8");
  } else if (Buffer.isBuffer(key)) {
    buf = key;
  } else if (key instanceof Uint8Array) {
    buf = Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  } else {
    throw new Error("OMP_USAGE_KEY_ERROR: Invalid HMAC key type");
  }
  if (buf.length < 32) {
    throw new Error("OMP_USAGE_KEY_ERROR: HMAC key must be at least 32 bytes");
  }
  return buf;
}

/**
 * Strips ANSI escape sequences from strings.
 */
export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

/**
 * Resolves a limit's used fraction (0..1) from amount fields following authoritative OMP precedence:
 * explicit fraction > used/limit > percent-unit used > inverted remaining.
 * Returns undefined if amount is unknown.
 */
export function resolveUsedFraction(amount: UsageAmount): number | undefined {
  if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
    return Math.max(0, Math.min(1, amount.usedFraction));
  }
  if (
    typeof amount.used === "number" &&
    typeof amount.limit === "number" &&
    Number.isFinite(amount.used) &&
    Number.isFinite(amount.limit) &&
    amount.limit > 0
  ) {
    return Math.max(0, Math.min(1, amount.used / amount.limit));
  }
  if (
    amount.unit === "percent" &&
    typeof amount.used === "number" &&
    Number.isFinite(amount.used)
  ) {
    return Math.max(0, Math.min(1, amount.used / 100));
  }
  if (
    typeof amount.remainingFraction === "number" &&
    Number.isFinite(amount.remainingFraction)
  ) {
    return Math.max(0, Math.min(1, 1 - amount.remainingFraction));
  }
  return undefined;
}

/** A typed identity component included in the provider pseudonym. */
export interface ProviderIdentityComponent {
  type: string;
  value: string;
}

/**
 * Generates an opaque, path/PII-free, stable identity ID using HMAC-SHA256
 * with domain separation and typed length-delimited encoding.
 */
export function generateOpaqueIdentityId(
  provider: string,
  identity: ProviderIdentityComponent | readonly ProviderIdentityComponent[] | null,
  hmacKey: string | Buffer | Uint8Array,
): string {
  const keyBuf = validateHmacKey(hmacKey);
  const normalizedProvider = provider.trim().toLowerCase();
  const components: readonly ProviderIdentityComponent[] =
    identity === null ? [] : Array.isArray(identity) ? identity : [identity as ProviderIdentityComponent];
  const hmac = createHmac("sha256", keyBuf);
  hmac.update(`${DOMAIN_PROVIDER_IDENTITY}\0${components.length === 0 ? "pool" : "cred"}`, "utf8");
  hmac.update(`\0${normalizedProvider.length}:${normalizedProvider}`, "utf8");

  for (const component of components) {
    const type = component.type.trim().toLowerCase();
    const value = component.value.trim();
    if (!type || !value) throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid identity component");
    hmac.update(`\0${type.length}:${type}\0${value.length}:${value}`, "utf8");
  }

  return hmac.digest("hex");
}

/**
 * Formats a safe display label for provider identities without exposing raw identifiers.
 */
export function formatSafeIdentityLabel(
  provider: string,
  identityId: string,
  isPool: boolean,
  tier?: string | null,
): string {
  const normalizedProvider = provider.trim().toLowerCase();
  let providerName = "Provider";
  if (normalizedProvider === "openai-codex") {
    providerName = "OpenAI Codex";
  } else if (normalizedProvider === "google-antigravity" || normalizedProvider === "google") {
    providerName = "Google Antigravity";
  } else if (normalizedProvider === "anthropic") {
    providerName = "Anthropic";
  } else if (normalizedProvider === "github-copilot") {
    providerName = "GitHub Copilot";
  }

  const shortId = identityId.slice(0, 8);
  const tierSuffix = tier && /^[a-zA-Z0-9_-]{1,24}$/.test(tier) ? ` [${tier}]` : "";

  if (isPool) {
    return `${providerName}${tierSuffix} (Shared Pool)`;
  }
  return `${providerName}${tierSuffix} (${shortId})`;
}

/**
 * Derives provider health status from quota status, usage fraction, and disabled/idle state.
 */
export function deriveProviderHealth(
  status: UsageStatus | string | undefined | null,
  usedFraction: number | undefined,
  isDisabled = false,
  isNoUsage = false,
): ProviderHealth {
  if (isDisabled) return "unhealthy";
  if (isNoUsage) return "unknown";

  const normalizedStatus = (status || "").trim().toLowerCase();
  if (
    normalizedStatus === "rate_limited" ||
    normalizedStatus === "429" ||
    normalizedStatus === "throttled"
  ) {
    return "rate_limited";
  }
  if (
    normalizedStatus === "exhausted" ||
    normalizedStatus === "quota_exceeded" ||
    (usedFraction !== undefined && usedFraction >= 1.0)
  ) {
    return "exhausted";
  }
  if (
    normalizedStatus === "unhealthy" ||
    normalizedStatus === "error" ||
    normalizedStatus === "failed"
  ) {
    return "unhealthy";
  }
  if (
    normalizedStatus === "degraded" ||
    normalizedStatus === "warning" ||
    (usedFraction !== undefined && usedFraction >= 0.85)
  ) {
    return "degraded";
  }
  if (normalizedStatus === "ok" || normalizedStatus === "healthy" || normalizedStatus === "") {
    return "healthy";
  }
  return "unknown";
}

function mergeHealth(current: ProviderHealth, next: ProviderHealth): ProviderHealth {
  const precedence: Record<ProviderHealth, number> = {
    unhealthy: 5,
    exhausted: 4,
    rate_limited: 3,
    degraded: 2,
    unknown: 1,
    healthy: 0,
  };
  return (precedence[next] ?? 0) > (precedence[current] ?? 0) ? next : current;
}

/**
 * Sanitizes errors to fixed, typed messages so sensitive details or raw stdout/tokens never escape into logs.
 */
export function sanitizeOmpUsageError(error: unknown): string {
  if (!error) return "OMP_USAGE_ERROR: Usage probe failed";
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes("OMP_USAGE_TIMEOUT") || msg.includes("timed out") || msg.includes("timeout")) {
    return "OMP_USAGE_TIMEOUT: Probe execution timed out";
  }
  if (msg.includes("OMP_USAGE_ALREADY_RUNNING") || msg.includes("already in flight")) {
    return "OMP_USAGE_ALREADY_RUNNING: Execution overlap prevented";
  }
  if (msg.includes("OMP_USAGE_KEY_ERROR")) {
    return "OMP_USAGE_KEY_ERROR: Invalid HMAC key configuration";
  }
  if (msg.includes("OMP_USAGE_PAYLOAD_TOO_LARGE") || msg.includes("size exceeded") || msg.includes("maxBuffer")) {
    return "OMP_USAGE_PAYLOAD_TOO_LARGE: Output size exceeded maximum allowed buffer";
  }
  if (msg.includes("OMP_USAGE_INVALID_ROOT")) {
    return "OMP_USAGE_INVALID_ROOT: Expected valid root envelope";
  }
  if (msg.includes("OMP_USAGE_INVALID_TIMESTAMP")) {
    return "OMP_USAGE_INVALID_TIMESTAMP: Observation timestamp is invalid, stale, or in the future";
  }
  if (msg.includes("OMP_USAGE_INVALID_RESET")) {
    return "OMP_USAGE_INVALID_RESET: Reset timestamp is invalid or outside valid window horizon";
  }
  if (msg.includes("OMP_USAGE_SCHEMA_ERROR")) {
    return "OMP_USAGE_SCHEMA_ERROR: Payload failed strict schema validation";
  }
  if (msg.includes("ENOENT") || msg.includes("not found")) {
    return "OMP_USAGE_PROCESS_ERROR: Executable not found";
  }
  if (msg.includes("exit code") || msg.includes("exited with code") || msg.includes("OMP_USAGE_PROCESS_ERROR")) {
    return "OMP_USAGE_PROCESS_ERROR: CLI process exited with error";
  }

  return "OMP_USAGE_ERROR: Usage probe execution failed";
}

/** Read a trimmed metadata string without reflecting it into errors. */
function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** First non-empty scope identity of the requested type. */
function scopeIdentity(report: UsageReport, key: "accountId" | "projectId" | "orgId"): string | null {
  for (const limit of report.limits) {
    const value = limit.scope[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Extracts a stable report identity using the installed OMP provider rules.
 * Codex is keyed by its base account identity plus organization gate. Antigravity
 * uses accountId, then email, then projectId.
 */
function extractReportIdentity(report: UsageReport): ProviderIdentityComponent[] | null {
  const metadata = report.metadata || {};
  const accountId = metadataString(metadata, "accountId") ?? scopeIdentity(report, "accountId");
  const email = metadataString(metadata, "email")?.toLowerCase() ?? null;
  const projectId = metadataString(metadata, "projectId") ?? scopeIdentity(report, "projectId");
  const orgId = metadataString(metadata, "orgId") ?? scopeIdentity(report, "orgId");
  if (report.provider === "openai-codex") {
    const base = email
      ? { type: "email", value: email }
      : accountId
        ? { type: "accountId", value: accountId }
        : projectId
          ? { type: "projectId", value: projectId }
          : null;
    if (base && orgId) return [base, { type: "orgId", value: orgId }];
    if (base) return [base];
    return orgId ? [{ type: "orgId", value: orgId }] : null;
  }

  if (report.provider === "google-antigravity") {
    if (accountId) return [{ type: "accountId", value: accountId }];
    if (email) return [{ type: "email", value: email }];
    if (projectId) return [{ type: "projectId", value: projectId }];
    return null;
  }

  return null;
}
/** Provider-specific identity components for auxiliary credential rows. */
function auxiliaryIdentity(
  provider: string,
  fields: { accountId?: unknown; email?: unknown; projectId?: unknown; orgId?: unknown },
): ProviderIdentityComponent[] | null {
  const accountId = typeof fields.accountId === "string" && fields.accountId.trim() ? fields.accountId.trim() : null;
  const email = typeof fields.email === "string" && fields.email.trim() ? fields.email.trim().toLowerCase() : null;
  const projectId = typeof fields.projectId === "string" && fields.projectId.trim() ? fields.projectId.trim() : null;
  const orgId = typeof fields.orgId === "string" && fields.orgId.trim() ? fields.orgId.trim() : null;
  if (provider === "openai-codex") {
    const base = email
      ? { type: "email", value: email }
      : accountId
        ? { type: "accountId", value: accountId }
        : projectId
          ? { type: "projectId", value: projectId }
          : null;
    if (base && orgId) return [base, { type: "orgId", value: orgId }];
    if (base) return [base];
    return orgId ? [{ type: "orgId", value: orgId }] : null;
  }
  if (provider === "google-antigravity") {
    if (accountId) return [{ type: "accountId", value: accountId }];
    if (email) return [{ type: "email", value: email }];
    if (projectId) return [{ type: "projectId", value: projectId }];
  }
  return null;
}
/** Classify a raw disable cause into a fixed non-sensitive category. */
function classifyDisableCause(cause: string): string {
  const normalized = cause.toLowerCase();
  if (normalized.includes("revok")) return "revoked";
  if (normalized.includes("expir")) return "expired";
  if (normalized.includes("rate") || normalized.includes("429")) return "rate_limit";
  if (normalized.includes("auth") || normalized.includes("401") || normalized.includes("403")) return "auth";
  if (normalized.includes("manual") || normalized.includes("disable")) return "disabled";
  return "unknown";
}

const VALID_UNITS = new Set<string>([
  "percent",
  "tokens",
  "requests",
  "credits",
  "usd",
  "minutes",
  "bytes",
  "unknown",
]);
const MAX_SAFE_STRING = 256;
const MAX_NOTES = 32;
const MAX_RESET_CREDITS = 128;
const MAX_CAPACITY_WINDOWS = 128;

function assertClosedObject(value: unknown, allowedKeys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Expected a closed object");
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw new Error("OMP_USAGE_SCHEMA_ERROR: Unsupported nested field");
  }
}

function assertOptionalString(value: unknown, maxLength = MAX_SAFE_STRING): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > maxLength)) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid bounded string");
  }
}

function assertNotes(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_NOTES ||
    value.some(note => typeof note !== "string" || note.length === 0 || note.length > 512)) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid notes collection");
  }
}

function assertIdentityMetadata(provider: string, value: unknown): void {
  if (value === undefined) return;
  if (provider !== "openai-codex" && provider !== "google-antigravity") {
    assertClosedObject(value, Object.keys(value as object));
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32_768) {
      throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Unsupported provider metadata exceeded maximum bytes");
    }
    return;
  }
  const allowed = provider === "openai-codex"
    ? ["planType", "allowed", "limitReached", "email", "accountId", "orgId", "orgName", "projectId", "meterStates"]
    : ["endpoint", "projectId", "email", "accountId", "orgId", "orgName"];
  assertClosedObject(value, allowed);
  for (const key of ["planType", "email", "accountId", "projectId", "orgId", "orgName", "endpoint"]) {
    assertOptionalString(value[key]);
  }
  for (const key of ["allowed", "limitReached"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid metadata boolean");
    }
  }
  if (value.meterStates !== undefined) {
    assertClosedObject(value.meterStates, Object.keys(value.meterStates as object));
    const entries = Object.entries(value.meterStates);
    if (entries.length > 64) throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Too many meter states");
    for (const [meter, state] of entries) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(meter)) throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid meter state key");
      assertClosedObject(state, ["allowed", "limitReached"]);
      for (const field of ["allowed", "limitReached"]) {
        if (state[field] !== undefined && typeof state[field] !== "boolean") {
          throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid meter state boolean");
        }
      }
    }
  }
}

function validateClosedReport(value: unknown): asserts value is UsageReport {
  assertClosedObject(value, ["provider", "fetchedAt", "limits", "resetCredits", "notes", "metadata"]);
  if (typeof value.provider !== "string" || value.provider.length === 0 || value.provider.length > 64 ||
    typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.limits)) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid report fields");
  }
  assertNotes(value.notes);
  assertIdentityMetadata(value.provider, value.metadata);

  if (value.resetCredits !== undefined) {
    assertClosedObject(value.resetCredits, ["availableCount", "credits"]);
    if (typeof value.resetCredits.availableCount !== "number" ||
      !Number.isInteger(value.resetCredits.availableCount) || value.resetCredits.availableCount < 0) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid reset credit count");
    }
    const credits = value.resetCredits.credits;
    if (credits !== undefined) {
      if (!Array.isArray(credits) || credits.length > MAX_RESET_CREDITS) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid reset credit details");
      }
      for (const credit of credits) {
        assertClosedObject(credit, ["grantedAt", "expiresAt", "status"]);
        for (const key of ["grantedAt", "expiresAt"] as const) {
          const timestamp = credit[key];
          if (timestamp !== undefined && (typeof timestamp !== "string" || timestamp.length > 64 || Number.isNaN(Date.parse(timestamp)))) {
            throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid reset credit timestamp");
          }
        }
        assertOptionalString(credit.status, 64);
      }
    }
  }

  for (const limit of value.limits) {
    assertClosedObject(limit, ["id", "label", "scope", "window", "amount", "status", "notes"]);
    assertOptionalString(limit.id, 192);
    assertOptionalString(limit.label, 256);
    assertNotes(limit.notes);
    assertClosedObject(limit.scope, ["provider", "accountId", "projectId", "orgId", "modelId", "tier", "windowId", "shared"]);
    if (limit.scope.provider !== value.provider) throw new Error("OMP_USAGE_SCHEMA_ERROR: Scope provider mismatch");
    for (const key of ["accountId", "projectId", "orgId", "modelId", "tier", "windowId"] as const) {
      assertOptionalString(limit.scope[key]);
    }
    if (limit.scope.shared !== undefined && typeof limit.scope.shared !== "boolean") {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid shared scope flag");
    }
    assertClosedObject(limit.amount, ["used", "limit", "remaining", "usedFraction", "remainingFraction", "unit"]);
    for (const key of ["used", "limit", "remaining", "usedFraction", "remainingFraction"] as const) {
      const numeric = limit.amount[key];
      if (numeric !== undefined && (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid usage amount number");
      }
    }
    if (typeof limit.amount.unit !== "string" || !VALID_UNITS.has(limit.amount.unit)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid usage unit");
    }
    if (limit.status !== undefined && !["ok", "warning", "exhausted", "unknown"].includes(limit.status as string)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid usage status");
    }
    if (limit.window !== undefined) {
      assertClosedObject(limit.window, ["id", "label", "durationMs", "resetsAt", "resetLabel"]);
      assertOptionalString(limit.window.id, 128);
      assertOptionalString(limit.window.label, 256);
      if (typeof limit.window.id !== "string" || typeof limit.window.label !== "string") {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Window id and label are required");
      }
      assertOptionalString(limit.window.resetLabel, 32);
      if (limit.window.durationMs !== undefined &&
        (typeof limit.window.durationMs !== "number" || !Number.isFinite(limit.window.durationMs) || limit.window.durationMs < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid window duration");
      }
      if (limit.window.resetsAt !== undefined &&
        (typeof limit.window.resetsAt !== "number" || !Number.isFinite(limit.window.resetsAt) || limit.window.resetsAt <= 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid window reset timestamp");
      }
    }
  }
}

interface CanonicalQuotaIdentity {
  bucketId: string;
  meter: string;
  tier: string | null;
  windowId: string;
}

const CANONICAL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const OPAQUE_SOURCE_COMPONENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CODEX_FALLBACK_WINDOW_HORIZON_MS = 31 * 24 * 60 * 60 * 1_000;

function opaqueQuotaComponent(
  domain: "codex-meter" | "antigravity-tier" | "antigravity-window",
  value: string,
  hmacKey: Buffer,
): string {
  const digest = createHmac("sha256", hmacKey)
    .update(`ai-fleet-observatory/quota-component/v1\0${domain.length}:${domain}\0${value.length}:${value}`, "utf8")
    .digest("hex");
  return `opaque-${digest.slice(0, 24)}`;
}

function canonicalizeCapacityWindow(provider: string, window: string, hmacKey: Buffer): string | null {
  if (/^\d+(?:\.\d+)?[a-z]{1,3}$/.test(window)) return window;
  if (provider === "openai-codex") {
    const normalized = window.trim().toLowerCase();
    if (normalized === "primary window") return "primary";
    if (normalized === "secondary window") return "secondary";
    return null;
  }
  if (provider !== "google-antigravity" || window.length === 0 || window.length > 128 || /[\u0000-\u001f\u007f]/.test(window)) {
    return null;
  }
  return opaqueQuotaComponent("antigravity-window", window, hmacKey);
}

function canonicalQuotaIdentity(provider: string, limit: UsageLimit, hmacKey: Buffer): CanonicalQuotaIdentity {
  const scopeWindow = limit.scope.windowId;
  const rawWindowId = limit.window?.id ?? scopeWindow;
  if (!rawWindowId || (scopeWindow !== undefined && scopeWindow !== rawWindowId)) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Quota window identifiers do not match");
  }

  if (provider === "openai-codex") {
    if (!CANONICAL_SLUG.test(rawWindowId)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid Codex quota window identifier");
    }
    const base = /^openai-codex:(primary|secondary)$/.exec(limit.id);
    if (base) {
      if (limit.scope.tier !== undefined) throw new Error("OMP_USAGE_SCHEMA_ERROR: Base Codex bucket cannot carry a tier");
      return { bucketId: limit.id, meter: "chat", tier: null, windowId: rawWindowId };
    }
    const additional = /^openai-codex:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?):(primary|secondary)$/.exec(limit.id);
    if (!additional || limit.scope.tier !== additional[1]) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Codex meter slug does not match its scope tier");
    }
    const meter = additional[1] === "spark"
      ? "spark"
      : opaqueQuotaComponent("codex-meter", additional[1], hmacKey);
    return { bucketId: `openai-codex:${meter}:${additional[2]}`, meter, tier: meter, windowId: rawWindowId };
  }

  const antigravity = /^google-antigravity:([a-z0-9][a-z0-9_-]{0,62}):([a-z0-9][a-z0-9_-]{0,62}):([a-z0-9][a-z0-9_-]{0,62})$/.exec(limit.id);
  if (
    !antigravity ||
    !["anthropic", "google", "openai", "default"].includes(antigravity[1]) ||
    !OPAQUE_SOURCE_COMPONENT.test(rawWindowId) ||
    antigravity[3] !== rawWindowId
  ) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Antigravity bucket components do not match its window");
  }
  const rawTier = limit.scope.tier?.toLowerCase() ?? "default";
  if (!OPAQUE_SOURCE_COMPONENT.test(rawTier) || antigravity[2] !== rawTier) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Antigravity tier slug does not match its scope tier");
  }
  const tier = rawTier === "default" ? null : opaqueQuotaComponent("antigravity-tier", rawTier, hmacKey);
  const windowId = ["daily", "weekly", "default"].includes(rawWindowId)
    ? rawWindowId
    : opaqueQuotaComponent("antigravity-window", rawWindowId, hmacKey);
  return {
    bucketId: `google-antigravity:${antigravity[1]}:${tier ?? "default"}:${windowId}`,
    meter: antigravity[1],
    tier,
    windowId,
  };
}
/**
 * Strict OMP 18.0.11 CLI usage normalizer.
 */
export function normalizeOmpUsage(
  rawPayload: unknown,
  options: OmpUsageNormalizeOptions,
): NormalizedOmpUsage {
  const hmacKey = validateHmacKey(options?.hmacKey);

  const maxPayloadBytes = options.maxPayloadBytes ?? 2 * 1024 * 1024; // 2 MB
  const maxReportsCount = options.maxReportsCount ?? 50;
  const maxLimitsPerReport = options.maxLimitsPerReport ?? 50;
  const hostId = options.hostId || "local-omp";
  const sourceVersion = options.sourceVersion ?? "18.0.11";
  if (sourceVersion !== "18.0.11") {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Unsupported collector source version");
  }
  const targetProviders = options.targetProviders
    ? options.targetProviders.map(p => p.trim().toLowerCase())
    : ["openai-codex", "google-antigravity"];

  let parsed: unknown = rawPayload;
  if (typeof rawPayload === "string") {
    const byteLength = Buffer.byteLength(rawPayload, "utf8");
    if (byteLength > maxPayloadBytes) {
      throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: String payload exceeded maximum bytes");
    }
    const cleaned = stripAnsi(rawPayload).trim();
    if (!cleaned) {
      throw new Error("OMP_USAGE_INVALID_ROOT: Empty payload string");
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Failed to parse JSON payload");
    }
  } else if (rawPayload && typeof rawPayload === "object") {
    // Check object size bounds via JSON length approximation
    const str = JSON.stringify(rawPayload);
    if (Buffer.byteLength(str, "utf8") > maxPayloadBytes) {
      throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Object payload exceeded maximum bytes");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMP_USAGE_INVALID_ROOT: Root must be an object");
  }

  const envelope = parsed as Record<string, unknown>;
  const rootKeys = Object.keys(envelope);
  if (rootKeys.some(key => !["generatedAt", "reports", "accountsWithoutUsage", "disabledCredentials", "capacity"].includes(key))) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Root envelope contains unsupported fields");
  }
  if (!Array.isArray(envelope.accountsWithoutUsage) || !Array.isArray(envelope.disabledCredentials) ||
    !envelope.capacity || typeof envelope.capacity !== "object" || Array.isArray(envelope.capacity)) {
    throw new Error("OMP_USAGE_INVALID_ROOT: Required auxiliary collections are missing");
  }
  const rawGeneratedAt = envelope.generatedAt;
  if (typeof rawGeneratedAt !== "number" || !Number.isFinite(rawGeneratedAt) || rawGeneratedAt <= 0) {
    throw new Error("OMP_USAGE_INVALID_TIMESTAMP: generatedAt must be a valid positive epoch-ms number");
  }

  const nowMs = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Date.now();
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 60_000;
  const maxStaleMs = options.maxStaleMs ?? 15 * 60 * 1_000;

  if (rawGeneratedAt > nowMs + maxFutureSkewMs) {
    throw new Error("OMP_USAGE_INVALID_TIMESTAMP: generatedAt is in the future");
  }
  if (rawGeneratedAt < nowMs - maxStaleMs) {
    throw new Error("OMP_USAGE_INVALID_TIMESTAMP: generatedAt is stale");
  }

  const reports = envelope.reports;
  if (!Array.isArray(reports)) {
    throw new Error("OMP_USAGE_INVALID_ROOT: reports must be an array");
  }
  if (reports.length > maxReportsCount) {
    throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Exceeded maximum reports count limit");
  }
  const auxiliaryLimit = maxReportsCount;
  for (const key of ["accountsWithoutUsage", "disabledCredentials"] as const) {
    const value = envelope[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Auxiliary credential collection must be an array");
    }
    if (Array.isArray(value) && value.length > auxiliaryLimit) {
      throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Auxiliary credential collection exceeded maximum count");
    }
  }
  if (envelope.capacity !== undefined && (!envelope.capacity || typeof envelope.capacity !== "object" || Array.isArray(envelope.capacity))) {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: capacity must be a provider map");
  }

  const observedAtIso = new Date(rawGeneratedAt).toISOString();
  const identitiesMap = new Map<string, ProviderIdentityObservation>();
  const quotas: QuotaObservationInput[] = [];
  let totalLimits = 0;

  for (const rawReport of reports) {
    validateClosedReport(rawReport);
    const report = rawReport as UsageReport;
    const provider = report.provider.trim().toLowerCase();

    // Every report is validated before unsupported providers are discarded.
    if (!targetProviders.includes(provider)) continue;

    const fetchedAt = (report as UsageReport).fetchedAt;
    if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      throw new Error("OMP_USAGE_INVALID_TIMESTAMP: Report fetchedAt must be a positive epoch-ms number");
    }
    if (fetchedAt > nowMs + maxFutureSkewMs) {
      throw new Error("OMP_USAGE_INVALID_TIMESTAMP: Report fetchedAt is in the future");
    }
    if (fetchedAt < nowMs - maxStaleMs) {
      throw new Error("OMP_USAGE_INVALID_TIMESTAMP: Report fetchedAt is stale");
    }

    const limits = (report as UsageReport).limits;
    if (!Array.isArray(limits)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Report limits must be an array");
    }
    if (limits.length > maxLimitsPerReport) {
      throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Exceeded maximum limits per report count");
    }

    // OMP emits one report per credential. Identityless rows are ambiguous and
    // must not be relabeled as an aggregate provider pool.
    const reportIdentity = extractReportIdentity(report as UsageReport);
    if (reportIdentity === null) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Per-credential report identity is missing or ambiguous");
    }
    const isExplicitPool = false;
    const identityId = generateOpaqueIdentityId(provider, reportIdentity, options.hmacKey);

    let resetCreditsCount: number | null = null;
    if ((report as UsageReport).resetCredits !== undefined && (report as UsageReport).resetCredits !== null) {
      const rc = (report as UsageReport).resetCredits;
      if (typeof rc !== "object" || Array.isArray(rc)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: resetCredits must be an object");
      }
      if (typeof rc.availableCount !== "number" || !Number.isInteger(rc.availableCount) || rc.availableCount < 0) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: resetCredits.availableCount must be a non-negative integer");
      }
      resetCreditsCount = rc.availableCount;
    }

    let reportWorstHealth: ProviderHealth = "healthy";
    let reportTier: string | null = null;

    for (const limit of limits) {
      if (!limit || typeof limit !== "object" || Array.isArray(limit)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit must be an object");
      }

      const limitId = limit.id;
      if (typeof limitId !== "string" || limitId.trim().length === 0) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit id must be a non-empty string");
      }

      const label = limit.label;
      if (typeof label !== "string" || label.trim().length === 0) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit label must be a non-empty string");
      }

      const scope = limit.scope;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit scope must be an object");
      }
      if (typeof scope.provider !== "string" || scope.provider.trim().toLowerCase() !== provider) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit scope.provider must match report provider");
      }

      const amount = limit.amount;
      if (!amount || typeof amount !== "object" || Array.isArray(amount)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit amount must be an object");
      }
      if (typeof amount.unit !== "string" || !VALID_UNITS.has(amount.unit)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit amount.unit must be a valid UsageUnit enum");
      }

      if (amount.used !== undefined && (typeof amount.used !== "number" || !Number.isFinite(amount.used) || amount.used < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Negative or non-finite used amount");
      }
      if (amount.limit !== undefined && (typeof amount.limit !== "number" || !Number.isFinite(amount.limit) || amount.limit < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Negative or non-finite limit amount");
      }
      if (amount.remaining !== undefined && (typeof amount.remaining !== "number" || !Number.isFinite(amount.remaining) || amount.remaining < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Negative or non-finite remaining amount");
      }
      if (amount.usedFraction !== undefined &&
        (typeof amount.usedFraction !== "number" || !Number.isFinite(amount.usedFraction) || amount.usedFraction < 0 || amount.usedFraction > 1)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: usedFraction must be within [0, 1]");
      }
      if (amount.remainingFraction !== undefined &&
        (typeof amount.remainingFraction !== "number" || !Number.isFinite(amount.remainingFraction) || amount.remainingFraction < 0 || amount.remainingFraction > 1)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: remainingFraction must be within [0, 1]");
      }
      if (limit.status !== undefined && !["ok", "warning", "exhausted", "unknown"].includes(limit.status)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Limit status must be a valid UsageStatus enum");
      }

      const window = limit.window;
      let durationMs: number | null = null;
      let resetsAtIso: string | null = null;
      let resetLabel: string | null = null;

      if (window !== undefined && window !== null) {
        if (typeof window !== "object" || Array.isArray(window)) {
          throw new Error("OMP_USAGE_SCHEMA_ERROR: Window must be an object");
        }
        if (typeof window.resetLabel === "string") resetLabel = window.resetLabel;

        if (window.durationMs !== undefined && window.durationMs !== null) {
          if (typeof window.durationMs !== "number" || !Number.isFinite(window.durationMs) || window.durationMs < 0) {
            throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid window.durationMs");
          }
          durationMs = window.durationMs;
        }

        if (window.resetsAt !== undefined && window.resetsAt !== null) {
          if (typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0) {
            throw new Error("OMP_USAGE_INVALID_RESET: window.resetsAt must be a positive epoch-ms number");
          }

          // Validate reset against report fetchedAt
          if (window.resetsAt < fetchedAt - 60_000) {
            throw new Error("OMP_USAGE_INVALID_RESET: Reset timestamp is in the past relative to report fetch time");
          }

          const inferredDurationMs = durationMs ?? (
            window.id === "5h" ? 18_000_000
              : window.id === "7d" || window.id === "weekly" ? 604_800_000
                : window.id === "daily" ? 86_400_000
                  : provider === "openai-codex" && /^(?:openai-codex:)?(?:primary|secondary)$/.test(limit.id)
                    ? CODEX_FALLBACK_WINDOW_HORIZON_MS
                    : null
          );
          if (inferredDurationMs === null || window.resetsAt > fetchedAt + inferredDurationMs + 5 * 60_000) {
            throw new Error("OMP_USAGE_INVALID_RESET: Reset timestamp is outside the valid window horizon");
          }
          resetsAtIso = new Date(window.resetsAt).toISOString();
        }
      }

      const resolvedUsedFraction = resolveUsedFraction(amount);
      const usedFraction = resolvedUsedFraction;
      let remainingFraction: number | null = null;

      if (typeof amount.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
        remainingFraction = amount.remainingFraction;
        if (usedFraction !== undefined && Math.abs(usedFraction + remainingFraction - 1) > 0.05) {
          throw new Error("OMP_USAGE_SCHEMA_ERROR: Inconsistent usedFraction and remainingFraction values");
        }
      } else if (usedFraction !== undefined) {
        remainingFraction = Math.max(0, Math.min(1, 1 - usedFraction));
      }

      if (
        typeof amount.used === "number" &&
        typeof amount.remaining === "number" &&
        typeof amount.limit === "number" &&
        amount.limit > 0
      ) {
        const sum = amount.used + amount.remaining;
        const allowedDelta = Math.max(0.02 * amount.limit, 0.01);
        if (Math.abs(sum - amount.limit) > allowedDelta) {
          throw new Error("OMP_USAGE_SCHEMA_ERROR: Inconsistent used, remaining, and limit quantities");
        }
      }

      const canonical = canonicalQuotaIdentity(provider, limit, hmacKey);
      const tier = canonical.tier;
      const model: string | null = null;
      if (resetLabel !== null && !["resets", "tick", "regen"].includes(resetLabel)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Unsupported reset label");
      }
      const status: UsageStatus = limit.status ?? (usedFraction === undefined ? "unknown" : "ok");

      if (tier && !reportTier) reportTier = tier;
      const health = deriveProviderHealth(status, usedFraction, false, false);
      reportWorstHealth = mergeHealth(reportWorstHealth, health);

      totalLimits++;
      if (usedFraction === undefined) continue;

      // Canonical durable bucket key is limit.id
      const quotaObs: QuotaObservationInput = {
        identityId,
        hostId,
        provider,
        bucketId: canonical.bucketId,
        windowId: canonical.windowId,
        windowDurationMs: durationMs,
        meter: canonical.meter,
        model,
        tier,
        fetchedAt: new Date(fetchedAt).toISOString(),
        observedAt: observedAtIso,
        resetsAt: resetsAtIso,
        resetLabel,
        usedFraction: Math.round(usedFraction * 10_000) / 10_000,
        remainingFraction: remainingFraction !== null ? Math.round(remainingFraction * 10_000) / 10_000 : null,
        usedUnits: typeof amount.used === "number" ? amount.used : null,
        totalUnits: typeof amount.limit === "number" ? amount.limit : null,
        remainingUnits: typeof amount.remaining === "number" ? amount.remaining : null,
        resetCredits: resetCreditsCount,
        unit: amount.unit,
        status,
        errorCategory: null,
        consecutiveFailures: 0,
        source: "omp_usage_cli",
        sourceVersion,
      };

      quotas.push(quotaObs);
    }

    const label = formatSafeIdentityLabel(provider, identityId, isExplicitPool, reportTier);
    const existing = identitiesMap.get(identityId);
    if (existing) {
      existing.health = mergeHealth(existing.health, reportWorstHealth);
    } else {
      const kind: ProviderIdentityKind = isExplicitPool ? "pool" : "credential";

      identitiesMap.set(identityId, {
        identityId,
        kind,
        provider,
        sourceHostId: hostId,
        sourceVersion,
        label,
        observedAt: observedAtIso,
        health: reportWorstHealth,
        disabled: false,
        blocked: false,
        lastProbeAt: observedAtIso,
        statusMessage: reportWorstHealth !== "healthy" ? reportWorstHealth : null,
        activeModel: null,
        lastSuccessAt: observedAtIso,
        lastFailureAt: null,
        consecutiveFailures: 0,
      });
    }
  }

  // Process accountsWithoutUsage
  let totalWithoutUsage = 0;
  for (const acc of envelope.accountsWithoutUsage as UsageAccountIdentity[]) {
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: accountsWithoutUsage item must be an object");
    }
    assertClosedObject(acc, ["provider", "type", "email", "accountId", "projectId", "enterpriseUrl", "orgId", "orgName", "authorizedAt"]);
    for (const key of ["email", "accountId", "projectId", "enterpriseUrl", "orgId", "orgName"] as const) {
      assertOptionalString(acc[key]);
    }
    if (typeof acc.provider !== "string" || !acc.provider.trim() || (acc.type !== "api_key" && acc.type !== "oauth")) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Auxiliary account identity fields are invalid");
    }
    if (acc.authorizedAt !== undefined &&
      (typeof acc.authorizedAt !== "number" || !Number.isFinite(acc.authorizedAt) || acc.authorizedAt <= 0)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Auxiliary account authorizedAt is invalid");
    }
    const provider = acc.provider.trim().toLowerCase();
    const rawIdent = auxiliaryIdentity(provider, acc);
    if (!targetProviders.includes(provider)) continue;
    if (rawIdent === null) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Auxiliary credential identity is missing or ambiguous");
    }

    totalWithoutUsage++;
    const identityId = generateOpaqueIdentityId(provider, rawIdent, options.hmacKey);
    const label = formatSafeIdentityLabel(provider, identityId, false, null);
    if (!identitiesMap.has(identityId)) {
      identitiesMap.set(identityId, {
        identityId,
        kind: "credential",
        provider,
        sourceHostId: hostId,
        label,
        observedAt: observedAtIso,
        health: "unknown",
        disabled: false,
        sourceVersion,
        blocked: false,
        lastProbeAt: observedAtIso,
        statusMessage: "no_active_usage",
        activeModel: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
      });
    }
  }

  // Process disabledCredentials
  let totalDisabled = 0;
  for (const dis of envelope.disabledCredentials as DisabledCredentialSummary[]) {
    if (!dis || typeof dis !== "object" || Array.isArray(dis)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: disabledCredentials item must be an object");
    }
    assertClosedObject(dis, ["id", "provider", "type", "email", "accountId", "orgId", "orgName", "cause", "disabledAtMs"]);
    for (const key of ["email", "accountId", "orgId", "orgName"] as const) {
      assertOptionalString(dis[key]);
    }
    if (!Number.isInteger(dis.id) || dis.id < 0 || typeof dis.provider !== "string" || !dis.provider.trim() ||
      (dis.type !== "api_key" && dis.type !== "oauth")) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Disabled credential identity fields are invalid");
    }
    if (typeof dis.cause !== "string" || dis.cause.length === 0 || dis.cause.length > 512) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Disabled credential cause is invalid");
    }
    if (dis.disabledAtMs !== undefined &&
      (typeof dis.disabledAtMs !== "number" || !Number.isFinite(dis.disabledAtMs) || dis.disabledAtMs <= 0)) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Disabled credential timestamp is invalid");
    }
    const provider = dis.provider.trim().toLowerCase();
    const rawIdent = auxiliaryIdentity(provider, dis);
    if (!targetProviders.includes(provider)) continue;
    if (rawIdent === null) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Disabled credential identity is missing or ambiguous");
    }

    totalDisabled++;
    const identityId = generateOpaqueIdentityId(provider, rawIdent, options.hmacKey);
    const label = formatSafeIdentityLabel(provider, identityId, false, null);
    const safeCause = classifyDisableCause(dis.cause);
    const existing = identitiesMap.get(identityId);
    if (existing) {
      existing.health = "unhealthy";
      existing.disabled = true;
      existing.statusMessage = safeCause;
    } else {
      identitiesMap.set(identityId, {
        identityId,
        kind: "credential",
        provider,
        sourceHostId: hostId,
        label,
        observedAt: observedAtIso,
        health: "unhealthy",
        disabled: true,
        blocked: false,
        lastProbeAt: observedAtIso,
        statusMessage: safeCause,
        activeModel: null,
        sourceVersion,
        lastSuccessAt: null,
        lastFailureAt: observedAtIso,
        consecutiveFailures: 1,
      });
    }
  }

  // Process capacity (Record<string, ProviderWindowStat[]>)
  const capacitySummary: Record<string, ProviderWindowStat[]> = {};
  const capacityEntries = Object.entries(envelope.capacity as Record<string, unknown>);
  if (capacityEntries.length > 32) throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Too many capacity providers");
  for (const [providerKeyRaw, stats] of capacityEntries) {
    const providerKey = providerKeyRaw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerKey) || !Array.isArray(stats) || stats.length > MAX_CAPACITY_WINDOWS) {
      throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid provider capacity collection");
    }
    const validStats: ProviderWindowStat[] = [];
    for (const stat of stats) {
      assertClosedObject(stat, ["window", "durationMs", "meter", "accounts", "usedAccounts", "remainingAccounts"]);
      const window = typeof stat.window === "string"
        ? canonicalizeCapacityWindow(providerKey, stat.window, hmacKey)
        : null;
      if (
        window === null ||
        typeof stat.accounts !== "number" ||
        !Number.isInteger(stat.accounts) ||
        stat.accounts < 0 ||
        typeof stat.usedAccounts !== "number" ||
        !Number.isFinite(stat.usedAccounts) ||
        stat.usedAccounts < 0 ||
        typeof stat.remainingAccounts !== "number" ||
        !Number.isFinite(stat.remainingAccounts) ||
        stat.remainingAccounts < 0
      ) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid provider capacity fields");
      }
      const accounts = stat.accounts;
      const usedAccounts = stat.usedAccounts;
      const remainingAccounts = stat.remainingAccounts;
      if (usedAccounts > accounts || remainingAccounts > accounts ||
        Math.abs(usedAccounts + remainingAccounts - accounts) > 0.001) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Inconsistent provider capacity totals");
      }
      if (stat.durationMs !== undefined &&
        (typeof stat.durationMs !== "number" || !Number.isFinite(stat.durationMs) || (stat.durationMs as number) < 0)) {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid capacity duration");
      }
      let meter: string | undefined;
      if (stat.meter !== undefined) {
        if (providerKey !== "openai-codex" || typeof stat.meter !== "string" || !CANONICAL_SLUG.test(stat.meter)) {
          throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid provider capacity meter");
        }
        meter = stat.meter === "spark"
          ? "spark"
          : opaqueQuotaComponent("codex-meter", stat.meter, hmacKey);
      }
      validStats.push({
        window,
        durationMs: stat.durationMs as number | undefined,
        meter,
        accounts,
        usedAccounts,
        remainingAccounts,
      });
    }
    if (targetProviders.includes(providerKey)) capacitySummary[providerKey] = validStats;
  }

  const identities = Array.from(identitiesMap.values());

  return {
    observedAt: observedAtIso,
    identities,
    quotas,
    capacity: capacitySummary,
    stats: {
      totalReports: reports.length,
      totalLimits,
      totalIdentities: identities.length,
      totalDisabled,
      totalWithoutUsage,
    },
  };
}

export interface CollectOmpUsageParams {
  hmacKey: string | Buffer | Uint8Array;
  hostId: string;
  sourceVersion: "18.0.11";
  /** Trusted absolute executable selected by deployment configuration. */
  executable: string;
  /** Trusted prefix arguments, primarily for controlled executable adapters/tests. */
  executablePrefixArgs?: string[];
  brokerUrl?: string;
  brokerToken?: string;
  /** Outer fleet timeout; must exceed OMP's per-account inner bound. */
  timeoutMs?: number;
  /** Maximum credentials per retained provider in one fleet snapshot. */
  maxAccountsPerProvider?: number;
  /** OMP broker's per-account timeout bound (default 10 seconds). */
  perAccountTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: number | Date;
}

interface OmpExecutionOptions {
  executable: string;
  executablePrefixArgs?: string[];
  brokerUrl?: string;
  brokerToken?: string;
  timeoutMs?: number;
  maxAccountsPerProvider?: number;
  perAccountTimeoutMs?: number;
  maxOutputBytes?: number;
}

export type OmpUsageExecutor = () => Promise<NormalizedOmpUsage>;

// One process-wide single flight, independent of executable configuration.
let usageProbeActive = false;

/** Execute and normalize before unredacted identity data crosses the collector boundary. */
export async function collectOmpUsage(params: CollectOmpUsageParams): Promise<NormalizedOmpUsage> {
  validateHmacKey(params.hmacKey);
  if (!params.hostId.trim() || params.sourceVersion !== "18.0.11") {
    throw new Error("OMP_USAGE_SCHEMA_ERROR: Invalid collector identity or source version");
  }
  if (usageProbeActive) throw new Error("OMP_USAGE_ALREADY_RUNNING: Execution overlap prevented");
  usageProbeActive = true;
  try {
    const envelope = await runSubprocess(params.executable, params.executablePrefixArgs ?? [], params);
    return normalizeOmpUsage(envelope, {
      hmacKey: params.hmacKey,
      hostId: params.hostId,
      sourceVersion: params.sourceVersion,
      now: params.now,
    });
  } finally {
    usageProbeActive = false;
  }
}

function buildScrubbedChildPath(): string {
  const systemDirs = process.platform === "win32"
    ? ["C:\\Windows\\System32", "C:\\Windows"]
    : ["/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([dirname(process.execPath), ...systemDirs])].join(delimiter);
}
async function runSubprocess(
  executable: string,
  prefixArgs: string[],
  params: OmpExecutionOptions,
): Promise<unknown> {
  const brokerUrl = params.brokerUrl;
  const brokerToken = params.brokerToken;
  const maxAccountsPerProvider = params.maxAccountsPerProvider ?? 20;
  const perAccountTimeoutMs = params.perAccountTimeoutMs ?? 10_000;
  if (!isAbsolute(executable) || prefixArgs.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
    !Number.isInteger(maxAccountsPerProvider) || maxAccountsPerProvider < 0 || maxAccountsPerProvider > 500 ||
    !Number.isFinite(perAccountTimeoutMs) || perAccountTimeoutMs <= 0) {
    throw new Error("OMP_USAGE_PROCESS_ERROR: Invalid trusted fleet configuration");
  }
  const maxTargetAccounts = maxAccountsPerProvider * 2;
  const minimumFleetTimeoutMs = perAccountTimeoutMs * (maxTargetAccounts + 1) + 5_000;
  const timeoutMs = params.timeoutMs ?? minimumFleetTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumFleetTimeoutMs) {
    throw new Error("OMP_USAGE_PROCESS_ERROR: Fleet timeout undercuts OMP per-account bound");
  }
  const maxOutputBytes = params.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    throw new Error("OMP_USAGE_PROCESS_ERROR: Invalid output buffer limit");
  }

  // Single unfiltered OMP usage command; broker token remains environment-only.
  const args = [executable, ...prefixArgs, "usage", "--json"];
  const env: Record<string, string> = {
    PATH: buildScrubbedChildPath(),
    HOME: process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp",
  };
  if (brokerUrl) env.OMP_AUTH_BROKER_URL = brokerUrl;
  if (brokerToken) env.OMP_AUTH_BROKER_TOKEN = brokerToken;

  const controller = new AbortController();
  let hardKillTimer: Timer | NodeJS.Timeout | null = null;

  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const proc = Bun.spawn(args, {
      env,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    // Escalate SIGTERM to SIGKILL if child ignores SIGTERM on abort
    controller.signal.addEventListener("abort", () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      hardKillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 1000);
    });

    const stdoutTask = readBoundedStream(proc.stdout, maxOutputBytes);
    const stderrTask = readBoundedStream(proc.stderr, maxOutputBytes);
    try {
      const [stdoutText, _stderrText, exitCode] = await Promise.all([
        stdoutTask,
        stderrTask,
        proc.exited,
      ]);

      if (controller.signal.aborted) throw new Error("OMP_USAGE_TIMEOUT");
      if (exitCode !== 0) throw new Error(`OMP_USAGE_PROCESS_ERROR: Process exited with code ${exitCode}`);

      const cleaned = stripAnsi(stdoutText).trim();
      if (!cleaned) throw new Error("OMP_USAGE_INVALID_ROOT: Empty CLI stdout");
      try {
        return JSON.parse(cleaned);
      } catch {
        throw new Error("OMP_USAGE_SCHEMA_ERROR: CLI stdout was not valid JSON");
      }
    } catch (error) {
      // A stream cap or timeout must terminate and reap the child before the
      // shared lock is released; otherwise a runaway probe can overlap its successor.
      try {
        proc.kill("SIGTERM");
      } catch {}
      const exitedGracefully = await Promise.race([
        proc.exited.then(() => true, () => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (!exitedGracefully) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await proc.exited.catch(() => 0);
      }
      await Promise.allSettled([stdoutTask, stderrTask]);
      throw error;
    }
  } catch (err) {
    const sanitized = controller.signal.aborted
      ? "OMP_USAGE_TIMEOUT: Probe execution timed out"
      : sanitizeOmpUsageError(err);
    throw new Error(sanitized);
  } finally {
    clearTimeout(timeoutTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error("OMP_USAGE_PAYLOAD_TOO_LARGE: Stream buffer exceeded maximum limit");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** Create a normalized collector closure for coordinator dependency injection. */
export function createOmpUsageExecutor(params: CollectOmpUsageParams): OmpUsageExecutor {
  return () => collectOmpUsage(params);
}
