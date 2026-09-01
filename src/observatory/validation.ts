/**
 * AI Fleet Observatory - Domain Validators & Sanitizers
 *
 * Strict validators for IDs, timestamps, fractions, integers, safe strings,
 * metadata objects, event candidates, policy rules, and tracker states.
 * Rejects forbidden keys, credentials, raw payloads, file paths, and PII.
 */

import type {
  AgentRouterTrackerState,
  CollectorBatchClaimInput,
  DailyQuotaRollupInput,
  EffectiveNotificationPolicy,
  EventSeverity,
  FleetHostObservation,
  HostTrackerState,
  ImportLedgerEntry,
  NonceClaimInput,
  NotificationDeliveryRecord,
  NotificationPolicyRule,
  ObservatoryAgentRouterAccount,
  ObservatoryAgentRouterBalanceObservation,
  ObservatoryAgentRouterEndpointObservation,
  ObservatoryAgentRouterGrantEvent,
  ObservatoryAgentRouterRun,
  ObservatoryAgentRouterUsagePoint,
  ObservatoryAuditEntry,
  ObservatoryEventCandidate,
  ObservatoryEventType,
  OmpSessionSummaryInput,
  ProviderHealth,
  ProviderIdentityKind,
  ProviderIdentityObservation,
  ProviderTrackerState,
  QuotaObservationInput,
  QuotaTrackerState,
  SessionTrackerState,
} from "./types";

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Validation failed for '${field}': ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

export const CANONICAL_EVENT_TYPES: readonly ObservatoryEventType[] = [
  "quota_warning",
  "quota_critical",
  "quota_exhausted",
  "quota_reset",
  "reset_credit_increased",
  "reset_credit_decreased",
  "provider_degraded",
  "provider_down",
  "provider_recovered",
  "credential_blocked",
  "credential_disabled",
  "credential_cooldown",
  "credential_recovered",
  "collector_failure",
  "collector_recovered",
  "host_offline",
  "host_recovered",
  "agentrouter_large_balance_drop",
  "agentrouter_balance_low",
  "agentrouter_grant_received",
  "agentrouter_challenge_required",
  "agentrouter_login_required",
  "agentrouter_login_failed",
  "agentrouter_endpoint_failed",
  "session_context_warning",
  "session_context_critical",
  "session_failed",
  "session_started",
  "session_closed",
  "digest_ready",
  "policy_changed",
  "import_completed",
] as const;

const CANONICAL_EVENT_LOOKUP: Record<string, true> = Object.fromEntries(
  CANONICAL_EVENT_TYPES.map((et) => [et, true]),
);

export function validateObservatoryEventType(value: unknown, fieldName = "eventType"): ObservatoryEventType {
  if (typeof value !== "string" || !CANONICAL_EVENT_LOOKUP[value]) {
    throw new ValidationError(
      fieldName,
      `must be one of 32 canonical event types: ${CANONICAL_EVENT_TYPES.join(", ")}`,
    );
  }
  return value as ObservatoryEventType;
}

const FORBIDDEN_KEY_PATTERNS = [
  /^prompt/i,
  /^completion/i,
  /^conversation/i,
  /^message(s)?$/i,
  /^raw_?payload/i,
  /^raw_?response/i,
  /^raw_?session/i,
  /^raw_?data/i,
  /^raw_?json/i,
  /^raw_?body/i,
  /^header(s)?$/i,
  /^auth(orization)?$/i,
  /^cookie(s)?$/i,
  /^session_?cookie/i,
  /^token$/i,
  /^access_?token/i,
  /^refresh_?token/i,
  /^oauth_?token/i,
  /^api_?key/i,
  /^secret/i,
  /^client_?secret/i,
  /^password/i,
  /^private_?key/i,
  /^credential(s)?$/i,
  /^email$/i,
  /^bearer/i,
  /^file_?path/i,
  /^path$/i,
  /^cwd$/i,
];

const FORBIDDEN_CONTENT_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/, // OpenAI-style keys
  /ghp_[a-zA-Z0-9]{10,}/, // GitHub tokens
  /xox[baprs]-[a-zA-Z0-9-]{10,}/, // Slack tokens
  /Bearer\s+[a-zA-Z0-9_\-\.]{10,}/i, // Bearer auth
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWT tokens
  /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/, // Email
  /CANARY_SECRET[a-zA-Z0-9_-]*/i,
];

const PATH_PATTERNS = [
  /[\\/]/,
  /\.\./,
  /^[a-zA-Z]:[\\/]/i, // Windows absolute
  /^\\\\[^\\]/, // UNC path
  /^\/(?:Users|home|root|var|etc|usr|private|tmp|opt|workspace|srv|bin|sbin)\b/i,
];

export function validateIsoUtcTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(fieldName, "must be a non-empty ISO UTC timestamp string");
  }
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new ValidationError(fieldName, `invalid timestamp format '${trimmed}'`);
  }
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) {
    throw new ValidationError(fieldName, `timestamp year ${year} out of reasonable range [2000, 2100]`);
  }
  return date.toISOString();
}

export function validateFraction(value: unknown, fieldName: string, required = true): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "fraction is required");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(fieldName, "must be a finite number");
  }
  if (value < 0 || value > 1) {
    throw new ValidationError(fieldName, `must be between 0 and 1 inclusive, got ${value}`);
  }
  return value;
}

export function validateNonNegativeNumber(
  value: unknown,
  fieldName: string,
  required = false,
): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "number is required");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(fieldName, "must be a finite number");
  }
  if (value < 0) {
    throw new ValidationError(fieldName, `must be non-negative, got ${value}`);
  }
  return value;
}

export function validateFiniteNumber(
  value: unknown,
  fieldName: string,
  required = false,
): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "number is required");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(fieldName, "must be a finite number");
  }
  return value;
}

export function validateNonNegativeInteger(
  value: unknown,
  fieldName: string,
  required = false,
): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "integer is required");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(fieldName, "must be a safe integer");
  }
  if (value < 0) {
    throw new ValidationError(fieldName, `must be non-negative, got ${value}`);
  }
  return value;
}

export function validateInteger(
  value: unknown,
  fieldName: string,
  required = false,
): number | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "integer is required");
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(fieldName, "must be a safe integer");
  }
  return value;
}

export function validateContextBps(
  value: unknown,
  fieldName = "contextBps",
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(fieldName, "must be an integer");
  }
  if (value < 0 || value > 10000) {
    throw new ValidationError(fieldName, `must be in range 0..10000 basis points, got ${value}`);
  }
  return value;
}

export function validateOpaqueId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(fieldName, "must be a non-empty string");
  }
  const trimmed = value.trim();
  if (trimmed.length > 128) {
    throw new ValidationError(fieldName, `exceeds max length of 128 characters (got ${trimmed.length})`);
  }
  for (const pattern of PATH_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ValidationError(fieldName, "must not contain path traversal or path separator characters");
    }
  }
  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ValidationError(fieldName, "contains forbidden content, credential, or PII pattern");
    }
  }
  return trimmed;
}

export function validateSafeString(
  value: unknown,
  fieldName: string,
  maxLength = 1000,
  required = true,
): string | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(fieldName, "string is required");
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new ValidationError(fieldName, "must be a string");
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    throw new ValidationError(fieldName, "must not be empty");
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(fieldName, `exceeds max length of ${maxLength} characters`);
  }
  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ValidationError(fieldName, "contains forbidden content, credential, or PII pattern");
    }
  }
  return trimmed;
}

export function validateSafeMetadata(
  metadata: unknown,
  fieldName = "metadata",
): Record<string, string | number | boolean | null> | undefined {
  if (metadata === undefined || metadata === null) {
    return undefined;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ValidationError(fieldName, "must be a plain object");
  }

  const result: Record<string, string | number | boolean | null> = {};
  const entries = Object.entries(metadata as Record<string, unknown>);

  if (entries.length > 50) {
    throw new ValidationError(fieldName, "too many keys (maximum 50)");
  }

  for (const [key, val] of entries) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new ValidationError(fieldName, "object contains empty key");
    }
    if (key.length > 64) {
      throw new ValidationError(fieldName, `key '${key}' exceeds max length 64`);
    }
    for (const forbiddenKey of FORBIDDEN_KEY_PATTERNS) {
      if (forbiddenKey.test(key)) {
        throw new ValidationError(fieldName, `key '${key}' is forbidden due to sensitive data policy`);
      }
    }

    if (val === null) {
      result[key] = null;
    } else if (typeof val === "boolean") {
      result[key] = val;
    } else if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new ValidationError(`${fieldName}.${key}`, "numeric value must be finite");
      }
      result[key] = val;
    } else if (typeof val === "string") {
      for (const pattern of PATH_PATTERNS) {
        if (pattern.test(val)) {
          throw new ValidationError(`${fieldName}.${key}`, "filesystem paths are forbidden in metadata");
        }
      }
      const safeStr = validateSafeString(val, `${fieldName}.${key}`, 500, false);
      result[key] = safeStr;
    } else {
      throw new ValidationError(
        `${fieldName}.${key}`,
        "values must be primitive (string, number, boolean, null); nested objects/arrays/raw payloads forbidden",
      );
    }
  }

  return result;
}

export function validatePagination(options?: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  let limit = 1000;
  let offset = 0;

  if (options?.limit !== undefined) {
    const lim = validateNonNegativeInteger(options.limit, "limit", false);
    if (lim !== null && lim !== undefined) {
      limit = Math.max(1, Math.min(10000, lim));
    }
  } else if (options?.offset !== undefined) {
    limit = 10000;
  }

  if (options?.offset !== undefined) {
    const off = validateNonNegativeInteger(options.offset, "offset", false);
    if (off !== null && off !== undefined) {
      offset = off;
    }
  }

  return { limit, offset };
}

export function validateProviderIdentityObservation(input: unknown): ProviderIdentityObservation {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ProviderIdentityObservation", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const identityId = validateOpaqueId(obj.identityId, "identityId");
  const kind = (validateSafeString(obj.kind, "kind", 64, true) as ProviderIdentityKind);
  const provider = validateSafeString(obj.provider, "provider", 64, true)!;
  const sourceHostId = validateOpaqueId(obj.sourceHostId, "sourceHostId");
  const sourceVersion = obj.sourceVersion
    ? validateSafeString(obj.sourceVersion, "sourceVersion", 64, false)
    : null;
  const label = validateSafeString(obj.label, "label", 128, true)!;
  const observedAt = validateIsoUtcTimestamp(obj.observedAt, "observedAt");

  const validHealth = ["healthy", "degraded", "unhealthy", "rate_limited", "exhausted", "unknown"];
  const healthStr = typeof obj.health === "string" ? obj.health.toLowerCase() : "";
  if (!validHealth.includes(healthStr)) {
    throw new ValidationError("health", `must be one of: ${validHealth.join(", ")}`);
  }
  const health = healthStr as ProviderHealth;

  const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
  const blocked = typeof obj.blocked === "boolean" ? obj.blocked : false;
  const cooldownUntilUtc = obj.cooldownUntilUtc
    ? validateIsoUtcTimestamp(obj.cooldownUntilUtc, "cooldownUntilUtc")
    : null;
  const lastProbeAt = obj.lastProbeAt
    ? validateIsoUtcTimestamp(obj.lastProbeAt, "lastProbeAt")
    : null;
  const rawStatusCode = obj.statusCode ?? obj.statusMessage;
  const statusCode = rawStatusCode
    ? validateSafeString(rawStatusCode, "statusCode", 64, false)
    : null;
  const activeModel = obj.activeModel
    ? validateSafeString(obj.activeModel, "activeModel", 128, false)
    : null;
  const lastSuccessAt = obj.lastSuccessAt
    ? validateIsoUtcTimestamp(obj.lastSuccessAt, "lastSuccessAt")
    : null;
  const lastFailureAt = obj.lastFailureAt
    ? validateIsoUtcTimestamp(obj.lastFailureAt, "lastFailureAt")
    : null;
  const consecutiveFailures = obj.consecutiveFailures !== undefined
    ? (validateNonNegativeInteger(obj.consecutiveFailures, "consecutiveFailures", false) ?? 0)
    : 0;
  return {
    identityId,
    kind,
    provider,
    sourceHostId,
    sourceVersion,
    label,
    observedAt,
    health,
    disabled,
    blocked,
    cooldownUntilUtc,
    lastProbeAt,
    statusCode,
    statusMessage: statusCode,
    activeModel,
    lastSuccessAt,
    lastFailureAt,
    consecutiveFailures,
  };
}

export function validateFleetHostObservation(input: unknown): FleetHostObservation {
  if (!input || typeof input !== "object") {
    throw new ValidationError("FleetHostObservation", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const hostId = validateOpaqueId(obj.hostId, "hostId");
  const operatorLabel = obj.operatorLabel
    ? validateSafeString(obj.operatorLabel, "operatorLabel", 128, false)
    : "default";
  const platform = obj.platform
    ? validateSafeString(obj.platform, "platform", 64, false)
    : "unknown";
  const collectorVersion = obj.collectorVersion
    ? validateSafeString(obj.collectorVersion, "collectorVersion", 64, false)
    : "18.0.11";
  const lastSeenAt = obj.lastSeenAt
    ? validateIsoUtcTimestamp(obj.lastSeenAt, "lastSeenAt")
    : validateIsoUtcTimestamp(obj.observedAt, "observedAt");
  const observedAt = validateIsoUtcTimestamp(obj.observedAt, "observedAt");
  const status = validateSafeString(obj.status, "status", 32, false) ?? "online";
  const activeSessionsCount = obj.activeSessionsCount !== undefined
    ? (validateNonNegativeInteger(obj.activeSessionsCount, "activeSessionsCount", false) ?? 0)
    : 0;
  const activeIdentitiesCount = obj.activeIdentitiesCount !== undefined
    ? (validateNonNegativeInteger(obj.activeIdentitiesCount, "activeIdentitiesCount", false) ?? 0)
    : 0;

  return {
    hostId,
    operatorLabel,
    platform,
    collectorVersion,
    lastSeenAt,
    observedAt,
    status,
    activeSessionsCount,
    activeIdentitiesCount,
  };
}

export function validateQuotaObservationInput(input: unknown): QuotaObservationInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("QuotaObservationInput", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const identityId = validateOpaqueId(obj.identityId, "identityId");
  const provider = validateSafeString(obj.provider, "provider", 64, true)!;
  const windowId = validateOpaqueId(obj.windowId, "windowId");
  const bucketId = obj.bucketId ? validateOpaqueId(obj.bucketId, "bucketId") : windowId;
  const windowDurationMs = validateNonNegativeInteger(obj.windowDurationMs, "windowDurationMs", false);
  const meter = obj.meter ? validateSafeString(obj.meter, "meter", 64, false) : null;
  const model = obj.model ? validateSafeString(obj.model, "model", 128, false) : null;
  const tier = obj.tier ? validateSafeString(obj.tier, "tier", 64, false) : null;
  const hostId = obj.hostId ? validateOpaqueId(obj.hostId, "hostId") : null;
  const fetchedAt = obj.fetchedAt ? validateIsoUtcTimestamp(obj.fetchedAt, "fetchedAt") : null;
  const observedAt = validateIsoUtcTimestamp(obj.observedAt, "observedAt");
  const resetsAt = obj.resetsAt ? validateIsoUtcTimestamp(obj.resetsAt, "resetsAt") : null;
  const resetLabel = obj.resetLabel ? validateSafeString(obj.resetLabel, "resetLabel", 64, false) : null;
  const usedFraction = validateFraction(obj.usedFraction, "usedFraction", true)!;
  const remainingFraction = validateFraction(obj.remainingFraction, "remainingFraction", false);
  const usedUnits = validateNonNegativeNumber(obj.usedUnits, "usedUnits", false);
  const totalUnits = validateNonNegativeNumber(obj.totalUnits, "totalUnits", false);
  const remainingUnits = validateNonNegativeNumber(obj.remainingUnits, "remainingUnits", false);
  const resetCredits = validateNonNegativeNumber(obj.resetCredits, "resetCredits", false);
  const unit = obj.unit ? validateSafeString(obj.unit, "unit", 32, false) : null;
  const status = obj.status ? validateSafeString(obj.status, "status", 32, false) : "ok";
  const errorCategory = obj.errorCategory
    ? validateSafeString(obj.errorCategory, "errorCategory", 64, false)
    : null;
  const consecutiveFailures = obj.consecutiveFailures !== undefined
    ? (validateNonNegativeInteger(obj.consecutiveFailures, "consecutiveFailures", false) ?? 0)
    : 0;
  const source = obj.source ? validateSafeString(obj.source, "source", 64, false) : null;
  const sourceVersion = obj.sourceVersion
    ? validateSafeString(obj.sourceVersion, "sourceVersion", 64, false)
    : null;
  return {
    identityId,
    provider,
    bucketId,
    windowId,
    windowDurationMs,
    meter,
    model,
    tier,
    hostId,
    fetchedAt,
    observedAt,
    resetsAt,
    resetLabel,
    usedFraction,
    remainingFraction,
    usedUnits,
    totalUnits,
    remainingUnits,
    resetCredits,
    unit,
    status,
    errorCategory,
    consecutiveFailures,
    source,
    sourceVersion,
  };
}

export function validateQuotaTrackerState(input: unknown): QuotaTrackerState {
  if (!input || typeof input !== "object") {
    throw new ValidationError("QuotaTrackerState", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const trackerKey = validateSafeString(obj.trackerKey, "trackerKey", 256, true)!;
  const identityId = validateOpaqueId(obj.identityId, "identityId");
  const provider = validateSafeString(obj.provider, "provider", 64, true)!;
  const bucketId = validateOpaqueId(obj.bucketId, "bucketId");
  const windowId = validateOpaqueId(obj.windowId, "windowId");
  const generation = validateNonNegativeInteger(obj.generation, "generation", true)!;
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");
  const lastUsedFraction = validateFraction(obj.lastUsedFraction, "lastUsedFraction", true)!;
  const lastRemainingFraction = validateFraction(obj.lastRemainingFraction, "lastRemainingFraction", false);
  const lastResetCredits = validateNonNegativeNumber(obj.lastResetCredits, "lastResetCredits", false);
  const warningFired = Boolean(obj.warningFired);
  const criticalFired = Boolean(obj.criticalFired);
  const exhaustedFired = Boolean(obj.exhaustedFired);
  const warningArmEpoch = validateNonNegativeInteger(obj.warningArmEpoch, "warningArmEpoch", false) ?? 0;
  const criticalArmEpoch = validateNonNegativeInteger(obj.criticalArmEpoch, "criticalArmEpoch", false) ?? 0;
  const exhaustedArmEpoch = validateNonNegativeInteger(obj.exhaustedArmEpoch, "exhaustedArmEpoch", false) ?? 0;
  const creditChangeSequence = validateNonNegativeInteger(obj.creditChangeSequence, "creditChangeSequence", false) ?? 0;
  const consecutiveFailures = validateNonNegativeInteger(obj.consecutiveFailures, "consecutiveFailures", false) ?? 0;
  const failureAlertSent = Boolean(obj.failureAlertSent);
  const lastResetAt = obj.lastResetAt ? validateIsoUtcTimestamp(obj.lastResetAt, "lastResetAt") : null;
  const lastNotifiedResetAt = obj.lastNotifiedResetAt
    ? validateIsoUtcTimestamp(obj.lastNotifiedResetAt, "lastNotifiedResetAt")
    : null;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    trackerKey,
    identityId,
    provider,
    bucketId,
    windowId,
    generation,
    lastObservedAt,
    lastUsedFraction,
    lastRemainingFraction,
    lastResetCredits,
    warningFired,
    criticalFired,
    exhaustedFired,
    warningArmEpoch,
    criticalArmEpoch,
    exhaustedArmEpoch,
    creditChangeSequence,
    consecutiveFailures,
    failureAlertSent,
    lastResetAt,
    lastNotifiedResetAt,
    updatedAt,
  };
}

export function validateProviderTrackerState(input: unknown): ProviderTrackerState {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ProviderTrackerState", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const trackerKey = validateSafeString(obj.trackerKey, "trackerKey", 256, true)!;
  const identityId = validateOpaqueId(obj.identityId, "identityId");
  const provider = validateSafeString(obj.provider, "provider", 64, true)!;
  const sourceHostId = validateOpaqueId(obj.sourceHostId, "sourceHostId");
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");

  const validHealth = ["healthy", "degraded", "unhealthy", "rate_limited", "exhausted", "unknown"];
  const healthStr = typeof obj.health === "string" ? obj.health.toLowerCase() : "";
  if (!validHealth.includes(healthStr)) {
    throw new ValidationError("health", `must be one of: ${validHealth.join(", ")}`);
  }
  const health = healthStr as ProviderHealth;

  const consecutiveFailures = validateNonNegativeInteger(obj.consecutiveFailures, "consecutiveFailures", false) ?? 0;
  const consecutiveBlocked = validateNonNegativeInteger(obj.consecutiveBlocked, "consecutiveBlocked", false) ?? 0;
  const consecutiveDisabled = validateNonNegativeInteger(obj.consecutiveDisabled, "consecutiveDisabled", false) ?? 0;
  const downIncidentActive = Boolean(obj.downIncidentActive);
  const blockedIncidentActive = Boolean(obj.blockedIncidentActive);
  const disabledIncidentActive = Boolean(obj.disabledIncidentActive);
  const cooldownIncidentActive = Boolean(obj.cooldownIncidentActive);
  const collectorFailureActive = Boolean(obj.collectorFailureActive);
  const incidentEpoch = validateNonNegativeInteger(obj.incidentEpoch, "incidentEpoch", false) ?? 0;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    trackerKey,
    identityId,
    provider,
    sourceHostId,
    lastObservedAt,
    health,
    consecutiveFailures,
    consecutiveBlocked,
    consecutiveDisabled,
    downIncidentActive,
    blockedIncidentActive,
    disabledIncidentActive,
    cooldownIncidentActive,
    collectorFailureActive,
    incidentEpoch,
    updatedAt,
  };
}

export function validateHostTrackerState(input: unknown): HostTrackerState {
  if (!input || typeof input !== "object") {
    throw new ValidationError("HostTrackerState", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const trackerKey = validateSafeString(obj.trackerKey, "trackerKey", 256, true)!;
  const hostId = validateOpaqueId(obj.hostId, "hostId");
  const lastSeenAt = validateIsoUtcTimestamp(obj.lastSeenAt, "lastSeenAt");
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");
  const status = validateSafeString(obj.status, "status", 32, true)!;
  const offlineSince = obj.offlineSince ? validateIsoUtcTimestamp(obj.offlineSince, "offlineSince") : null;
  const offlineAlertSent = Boolean(obj.offlineAlertSent);
  const offlineIncidentEpoch = validateNonNegativeInteger(obj.offlineIncidentEpoch, "offlineIncidentEpoch", false) ?? 0;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    trackerKey,
    hostId,
    lastSeenAt,
    lastObservedAt,
    status,
    offlineSince,
    offlineAlertSent,
    offlineIncidentEpoch,
    updatedAt,
  };
}

export function validateSessionTrackerState(input: unknown): SessionTrackerState {
  if (!input || typeof input !== "object") {
    throw new ValidationError("SessionTrackerState", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const trackerKey = validateSafeString(obj.trackerKey, "trackerKey", 256, true)!;
  const sessionId = validateOpaqueId(obj.sessionId, "sessionId");
  const hostId = validateOpaqueId(obj.hostId, "hostId");
  const identityId = obj.identityId ? validateOpaqueId(obj.identityId, "identityId") : null;
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");
  const lastContextBps = validateContextBps(obj.lastContextBps, "lastContextBps");
  const contextWarningFired = Boolean(obj.contextWarningFired);
  const contextCriticalFired = Boolean(obj.contextCriticalFired);
  const contextArmEpoch = validateNonNegativeInteger(obj.contextArmEpoch, "contextArmEpoch", false) ?? 0;
  const status = validateSafeString(obj.status, "status", 32, true)!;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    trackerKey,
    sessionId,
    hostId,
    identityId,
    lastObservedAt,
    lastContextBps,
    contextWarningFired,
    contextCriticalFired,
    contextArmEpoch,
    status,
    updatedAt,
  };
}

export function validateAgentRouterTrackerState(input: unknown): AgentRouterTrackerState {
  if (!input || typeof input !== "object") {
    throw new ValidationError("AgentRouterTrackerState", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const trackerKey = validateSafeString(obj.trackerKey, "trackerKey", 256, true)!;
  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");
  const lastBalance = validateFiniteNumber(obj.lastBalance, "lastBalance", false);
  const lowBalanceFired = Boolean(obj.lowBalanceFired);
  const lowBalanceArmEpoch = validateNonNegativeInteger(obj.lowBalanceArmEpoch, "lowBalanceArmEpoch", false) ?? 0;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    trackerKey,
    accountId,
    lastObservedAt,
    lastBalance,
    lowBalanceFired,
    lowBalanceArmEpoch,
    updatedAt,
  };
}

export function validateOmpSessionSummaryInput(input: unknown): OmpSessionSummaryInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("OmpSessionSummaryInput", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const sessionId = validateOpaqueId(obj.sessionId, "sessionId");
  const hostId = validateOpaqueId(obj.hostId, "hostId");
  const identityId = obj.identityId ? validateOpaqueId(obj.identityId, "identityId") : null;
  const startedAt = validateIsoUtcTimestamp(obj.startedAt, "startedAt");
  const lastActiveAt = obj.lastActiveAt ? validateIsoUtcTimestamp(obj.lastActiveAt, "lastActiveAt") : null;
  
  const rawClosedAt = obj.closedAt ?? obj.endedAt;
  const closedAt = rawClosedAt ? validateIsoUtcTimestamp(rawClosedAt, "closedAt") : null;
  const endedAt = closedAt;

  if (closedAt && Date.parse(closedAt) < Date.parse(startedAt)) {
    throw new ValidationError("closedAt", "cannot be earlier than startedAt");
  }
  if (lastActiveAt && Date.parse(lastActiveAt) < Date.parse(startedAt)) {
    throw new ValidationError("lastActiveAt", "cannot be earlier than startedAt");
  }

  const status = validateSafeString(obj.status, "status", 32, true)!;
  const model = obj.model ? validateSafeString(obj.model, "model", 128, false) : null;
  const provider = obj.provider ? validateSafeString(obj.provider, "provider", 64, false) : null;
  const durationMs = validateNonNegativeInteger(obj.durationMs, "durationMs", false);
  
  const rawInputTokens = obj.inputTokens ?? obj.promptTokens;
  const inputTokens = validateNonNegativeInteger(rawInputTokens, "inputTokens", false);
  const promptTokens = inputTokens;

  const rawOutputTokens = obj.outputTokens ?? obj.completionTokens;
  const outputTokens = validateNonNegativeInteger(rawOutputTokens, "outputTokens", false);
  const completionTokens = outputTokens;

  const cacheReadTokens = validateNonNegativeInteger(obj.cacheReadTokens, "cacheReadTokens", false);
  const cacheWriteTokens = validateNonNegativeInteger(obj.cacheWriteTokens, "cacheWriteTokens", false);
  const reasoningTokens = validateNonNegativeInteger(obj.reasoningTokens, "reasoningTokens", false);
  const totalTokens = validateNonNegativeInteger(obj.totalTokens, "totalTokens", false);

  const costMicros = validateNonNegativeInteger(obj.costMicros, "costMicros", false);
  const costEstimate = validateNonNegativeNumber(obj.costEstimate, "costEstimate", false);
  
  let costTrust: "exact" | "estimated" | "unknown" | null = null;
  if (obj.costTrust) {
    const ct = String(obj.costTrust).toLowerCase();
    if (["exact", "estimated", "unknown"].includes(ct)) {
      costTrust = ct as "exact" | "estimated" | "unknown";
    }
  }

  const contextBps = validateContextBps(obj.contextBps, "contextBps");
  const toolCallsCount = validateNonNegativeInteger(obj.toolCallsCount, "toolCallsCount", false);
  const errorCount = validateNonNegativeInteger(obj.errorCount, "errorCount", false);
  const exitCode = validateInteger(obj.exitCode, "exitCode", false);
  const collectedAt = obj.collectedAt ? validateIsoUtcTimestamp(obj.collectedAt, "collectedAt") : null;
  const source = obj.source ? validateSafeString(obj.source, "source", 64, false) : null;
  const sourceVersion = obj.sourceVersion
    ? validateSafeString(obj.sourceVersion, "sourceVersion", 64, false)
    : null;
  return {
    sessionId,
    hostId,
    identityId,
    status,
    startedAt,
    lastActiveAt,
    closedAt,
    endedAt,
    model,
    provider,
    durationMs,
    inputTokens,
    promptTokens,
    outputTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costMicros,
    costEstimate,
    costTrust,
    contextBps,
    toolCallsCount,
    errorCount,
    exitCode,
    collectedAt,
    source,
    sourceVersion,
  };
}

export function validateObservatoryEventCandidate(input: unknown): ObservatoryEventCandidate {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryEventCandidate", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const eventId = obj.eventId ? validateOpaqueId(obj.eventId, "eventId") : undefined;
  const eventType = validateObservatoryEventType(obj.eventType, "eventType");
  
  const validSeverities: EventSeverity[] = ["info", "warning", "error", "critical"];
  const severityStr = typeof obj.severity === "string" ? obj.severity.toLowerCase() : "";
  if (!validSeverities.includes(severityStr as EventSeverity)) {
    throw new ValidationError("severity", `must be one of: ${validSeverities.join(", ")}`);
  }
  const severity = severityStr as EventSeverity;

  const fingerprint = validateSafeString(obj.fingerprint, "fingerprint", 256, true)!;
  const occurredAt = validateIsoUtcTimestamp(obj.occurredAt, "occurredAt");
  const hostId = obj.hostId ? validateOpaqueId(obj.hostId, "hostId") : null;
  const identityId = obj.identityId ? validateOpaqueId(obj.identityId, "identityId") : null;
  const sessionId = obj.sessionId ? validateOpaqueId(obj.sessionId, "sessionId") : null;
  const provider = obj.provider ? validateSafeString(obj.provider, "provider", 64, false) : null;
  const identityKind = obj.identityKind
    ? (validateSafeString(obj.identityKind, "identityKind", 64, false) as ProviderIdentityKind)
    : null;
  const accountId = obj.accountId ? validateOpaqueId(obj.accountId, "accountId") : null;
  const bucketId = obj.bucketId ? validateOpaqueId(obj.bucketId, "bucketId") : null;
  const windowId = obj.windowId ? validateOpaqueId(obj.windowId, "windowId") : null;
  const meter = obj.meter ? validateSafeString(obj.meter, "meter", 64, false) : null;
  const model = obj.model ? validateSafeString(obj.model, "model", 128, false) : null;
  const tier = obj.tier ? validateSafeString(obj.tier, "tier", 64, false) : null;

  return {
    eventId,
    eventType,
    severity,
    fingerprint,
    occurredAt,
    hostId,
    identityId,
    sessionId,
    provider,
    identityKind,
    accountId,
    bucketId,
    windowId,
    meter,
    model,
    tier,
  };
}

export function validateNotificationPolicyRule(input: unknown): NotificationPolicyRule {
  if (!input || typeof input !== "object") {
    throw new ValidationError("NotificationPolicyRule", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const policyId = obj.policyId ? validateOpaqueId(obj.policyId, "policyId") : undefined;
  const target = validateSafeString(obj.target, "target", 128, true)!;

  if (/^global:/i.test(target)) {
    throw new ValidationError("target", "cannot use 'global:<key>' namespace prefix; use 'default' or scoped key");
  }

  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : undefined;
  const silenced = typeof obj.silenced === "boolean" ? obj.silenced : undefined;
  const telegramImmediate = typeof obj.telegramImmediate === "boolean" ? obj.telegramImmediate : undefined;
  const dashboardOnly = typeof obj.dashboardOnly === "boolean" ? obj.dashboardOnly : undefined;
  
  let minSeverity: EventSeverity | undefined;
  if (obj.minSeverity !== undefined) {
    const validSeverities: EventSeverity[] = ["info", "warning", "error", "critical"];
    const s = String(obj.minSeverity).toLowerCase();
    if (!validSeverities.includes(s as EventSeverity)) {
      throw new ValidationError("minSeverity", `must be one of: ${validSeverities.join(", ")}`);
    }
    minSeverity = s as EventSeverity;
  }

  let thresholds: Record<string, number> | null | undefined = undefined;
  if (obj.thresholds !== undefined) {
    if (obj.thresholds === null) {
      thresholds = null;
    } else if (typeof obj.thresholds === "object" && !Array.isArray(obj.thresholds)) {
      thresholds = {};
      for (const [k, v] of Object.entries(obj.thresholds as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          thresholds[k] = v;
        }
      }
    }
  }

  const consecutiveFailuresThreshold = validateNonNegativeInteger(
    obj.consecutiveFailuresThreshold,
    "consecutiveFailuresThreshold",
    false,
  ) ?? undefined;
  const cooldownMinutes = validateNonNegativeInteger(obj.cooldownMinutes, "cooldownMinutes", false) ?? undefined;
  const throttleIntervalMs = validateNonNegativeInteger(
    obj.throttleIntervalMs,
    "throttleIntervalMs",
    false,
  ) ?? undefined;

  const validateStringArray = (arr: unknown, name: string): string[] | undefined => {
    if (arr === undefined || arr === null) return undefined;
    if (!Array.isArray(arr)) {
      throw new ValidationError(name, "must be an array of strings");
    }
    return arr.map((item, index) => validateSafeString(item, `${name}[${index}]`, 64, true)!);
  };

  const channels = validateStringArray(obj.channels, "channels");

  let matchEventTypes: ObservatoryEventType[] | undefined = undefined;
  if (obj.matchEventTypes !== undefined && obj.matchEventTypes !== null) {
    if (!Array.isArray(obj.matchEventTypes)) {
      throw new ValidationError("matchEventTypes", "must be an array of event types");
    }
    matchEventTypes = obj.matchEventTypes.map((et, i) => validateObservatoryEventType(et, `matchEventTypes[${i}]`));
  }

  const matchHostIds = validateStringArray(obj.matchHostIds, "matchHostIds");
  const matchIdentityIds = validateStringArray(obj.matchIdentityIds, "matchIdentityIds");

  const quietHoursEnabled = typeof obj.quietHoursEnabled === "boolean" ? obj.quietHoursEnabled : undefined;
  const quietHoursTimezone = obj.quietHoursTimezone
    ? validateSafeString(obj.quietHoursTimezone, "quietHoursTimezone", 64, false)
    : undefined;

  const validateTimeOfDay = (val: unknown, name: string): string | null | undefined => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (typeof val !== "string" || !/^\d{2}:\d{2}$/.test(val)) {
      throw new ValidationError(name, "must be HH:MM in 24h format (e.g. 22:00)");
    }
    const [h, m] = val.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      throw new ValidationError(name, "out of valid hour/minute range");
    }
    return val;
  };

  const quietHoursStart = validateTimeOfDay(obj.quietHoursStart, "quietHoursStart");
  const quietHoursEnd = validateTimeOfDay(obj.quietHoursEnd, "quietHoursEnd");
  const criticalBypassQuietHours = typeof obj.criticalBypassQuietHours === "boolean"
    ? obj.criticalBypassQuietHours
    : undefined;

  const digestEnabled = typeof obj.digestEnabled === "boolean" ? obj.digestEnabled : undefined;
  const digestSchedule = obj.digestSchedule
    ? validateSafeString(obj.digestSchedule, "digestSchedule", 64, false)
    : undefined;
  const digestTimezone = obj.digestTimezone
    ? validateSafeString(obj.digestTimezone, "digestTimezone", 64, false)
    : undefined;

  const recipient = obj.recipient ? validateSafeString(obj.recipient, "recipient", 128, false) : undefined;

  return {
    policyId,
    target,
    enabled,
    silenced,
    telegramImmediate,
    dashboardOnly,
    minSeverity,
    thresholds,
    consecutiveFailuresThreshold,
    cooldownMinutes,
    throttleIntervalMs,
    channels,
    quietHoursEnabled,
    quietHoursTimezone,
    quietHoursStart,
    quietHoursEnd,
    criticalBypassQuietHours,
    digestEnabled,
    digestSchedule,
    digestTimezone,
    recipient,
    matchEventTypes,
    matchHostIds,
    matchIdentityIds,
  };
}

export function validateEffectiveNotificationPolicy(input: unknown): EffectiveNotificationPolicy {
  if (!input || typeof input !== "object") {
    throw new ValidationError("EffectiveNotificationPolicy", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const policyId = validateOpaqueId(obj.policyId, "policyId");
  const target = validateSafeString(obj.target, "target", 128, true)!;
  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : true;
  const silenced = Boolean(obj.silenced);
  const telegramImmediate = obj.telegramImmediate !== undefined ? Boolean(obj.telegramImmediate) : true;
  const dashboardOnly = Boolean(obj.dashboardOnly);
  
  const validSeverities: EventSeverity[] = ["info", "warning", "error", "critical"];
  const s = String(obj.minSeverity || "info").toLowerCase();
  if (!validSeverities.includes(s as EventSeverity)) {
    throw new ValidationError("minSeverity", `must be one of: ${validSeverities.join(", ")}`);
  }
  const minSeverity = s as EventSeverity;

  let thresholds: Record<string, number> | null = null;
  if (obj.thresholds && typeof obj.thresholds === "object" && !Array.isArray(obj.thresholds)) {
    thresholds = {};
    for (const [k, v] of Object.entries(obj.thresholds as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        thresholds[k] = v;
      }
    }
  }

  const consecutiveFailuresThreshold = validateNonNegativeInteger(
    obj.consecutiveFailuresThreshold,
    "consecutiveFailuresThreshold",
    false,
  );
  const cooldownMinutes = validateNonNegativeInteger(obj.cooldownMinutes, "cooldownMinutes", false) ?? 15;
  const throttleIntervalMs = validateNonNegativeInteger(
    obj.throttleIntervalMs,
    "throttleIntervalMs",
    false,
  ) ?? 60000;

  const validateStringArray = (arr: unknown, name: string): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr.map((item, index) => validateSafeString(item, `${name}[${index}]`, 64, true)!);
  };

  const channels = validateStringArray(obj.channels, "channels");

  const quietHoursEnabled = Boolean(obj.quietHoursEnabled);
  const quietHoursTimezone = validateSafeString(obj.quietHoursTimezone || "UTC", "quietHoursTimezone", 64, true)!;

  const validateTimeOfDay = (val: unknown, name: string): string | null => {
    if (!val) return null;
    if (typeof val !== "string" || !/^\d{2}:\d{2}$/.test(val)) {
      throw new ValidationError(name, "must be HH:MM in 24h format (e.g. 22:00)");
    }
    return val;
  };

  const quietHoursStart = validateTimeOfDay(obj.quietHoursStart, "quietHoursStart");
  const quietHoursEnd = validateTimeOfDay(obj.quietHoursEnd, "quietHoursEnd");
  const criticalBypassQuietHours = obj.criticalBypassQuietHours !== undefined
    ? Boolean(obj.criticalBypassQuietHours)
    : true;

  const digestEnabled = Boolean(obj.digestEnabled);
  const digestSchedule = obj.digestSchedule ? validateSafeString(obj.digestSchedule, "digestSchedule", 64, false) : null;
  const digestTimezone = validateSafeString(obj.digestTimezone || "UTC", "digestTimezone", 64, true)!;

  const recipient = obj.recipient ? validateSafeString(obj.recipient, "recipient", 128, false) : null;

  let matchEventTypes: ObservatoryEventType[] = [];
  if (Array.isArray(obj.matchEventTypes)) {
    matchEventTypes = obj.matchEventTypes.map((et, i) => validateObservatoryEventType(et, `matchEventTypes[${i}]`));
  }

  const matchHostIds = validateStringArray(obj.matchHostIds, "matchHostIds");
  const matchIdentityIds = validateStringArray(obj.matchIdentityIds, "matchIdentityIds");
  const updatedAt = validateIsoUtcTimestamp(obj.updatedAt || new Date().toISOString(), "updatedAt");

  return {
    policyId,
    target,
    enabled,
    silenced,
    telegramImmediate,
    dashboardOnly,
    minSeverity,
    thresholds,
    consecutiveFailuresThreshold,
    cooldownMinutes,
    throttleIntervalMs,
    channels,
    quietHoursEnabled,
    quietHoursTimezone,
    quietHoursStart,
    quietHoursEnd,
    criticalBypassQuietHours,
    digestEnabled,
    digestSchedule,
    digestTimezone,
    recipient,
    matchEventTypes,
    matchHostIds,
    matchIdentityIds,
    updatedAt,
  };
}

export function validateNotificationDeliveryRecord(input: unknown): NotificationDeliveryRecord {
  if (!input || typeof input !== "object") {
    throw new ValidationError("NotificationDeliveryRecord", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const deliveryId = obj.deliveryId ? validateOpaqueId(obj.deliveryId, "deliveryId") : undefined;
  const eventId = validateOpaqueId(obj.eventId, "eventId");
  const channel = validateSafeString(obj.channel, "channel", 64, true)!;
  const leaseToken = obj.leaseToken ? validateOpaqueId(obj.leaseToken, "leaseToken") : null;

  const validStatuses = ["pending", "sending", "sent", "failed", "throttled", "silenced"];
  const statusStr = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (!validStatuses.includes(statusStr)) {
    throw new ValidationError("status", `must be one of: ${validStatuses.join(", ")}`);
  }
  const status = statusStr as NotificationDeliveryRecord["status"];

  const attemptCount = validateNonNegativeInteger(obj.attemptCount, "attemptCount", false) ?? 0;
  const fingerprint = validateSafeString(obj.fingerprint, "fingerprint", 256, true)!;
  const leaseExpiresAt = obj.leaseExpiresAt
    ? validateIsoUtcTimestamp(obj.leaseExpiresAt, "leaseExpiresAt")
    : null;
  const sentAt = obj.sentAt ? validateIsoUtcTimestamp(obj.sentAt, "sentAt") : null;
  const errorCategory = obj.errorCategory
    ? validateSafeString(obj.errorCategory, "errorCategory", 64, false)
    : null;
  const lastAttemptAt = obj.lastAttemptAt
    ? validateIsoUtcTimestamp(obj.lastAttemptAt, "lastAttemptAt")
    : null;
  const providerMessageId = obj.providerMessageId
    ? validateSafeString(obj.providerMessageId, "providerMessageId", 128, false)
    : null;

  return {
    deliveryId,
    eventId,
    channel,
    leaseToken,
    status,
    attemptCount,
    fingerprint,
    leaseExpiresAt,
    sentAt,
    errorCategory,
    lastAttemptAt,
    providerMessageId,
  };
}

export function validateNonceClaimInput(input: unknown): NonceClaimInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("NonceClaimInput", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const nonce = validateOpaqueId(obj.nonce, "nonce");
  const scope = validateSafeString(obj.scope, "scope", 64, true)!;
  const hostId = obj.hostId ? validateOpaqueId(obj.hostId, "hostId") : null;
  const expiresAt = validateIsoUtcTimestamp(obj.expiresAt, "expiresAt");
  const claimedAt = obj.claimedAt
    ? validateIsoUtcTimestamp(obj.claimedAt, "claimedAt")
    : new Date().toISOString();

  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    throw new ValidationError("expiresAt", "must be strictly greater than claimedAt");
  }

  // Max TTL 24 hours (86400000 ms)
  const ttlMs = Date.parse(expiresAt) - Date.parse(claimedAt);
  if (ttlMs > 86400000) {
    throw new ValidationError("expiresAt", "nonce TTL exceeds maximum allowed duration of 24 hours");
  }

  return {
    nonce,
    scope,
    hostId,
    expiresAt,
    claimedAt,
  };
}

export function validateCollectorBatchClaimInput(input: unknown): CollectorBatchClaimInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("CollectorBatchClaimInput", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const hostId = validateOpaqueId(obj.hostId, "hostId");
  const batchId = validateOpaqueId(obj.batchId, "batchId");

  if (typeof obj.bodySha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(obj.bodySha256.trim())) {
    throw new ValidationError("bodySha256", "must be a 64-character hex SHA-256 string");
  }
  const bodySha256 = obj.bodySha256.trim().toLowerCase();

  const keyId = validateSafeString(obj.keyId, "keyId", 64, true)!;
  const receivedAt = obj.receivedAt
    ? validateIsoUtcTimestamp(obj.receivedAt, "receivedAt")
    : new Date().toISOString();

  let status: "accepted" | "rejected" = "accepted";
  if (obj.status !== undefined) {
    const s = String(obj.status).toLowerCase();
    if (s === "accepted" || s === "rejected") {
      status = s as "accepted" | "rejected";
    } else {
      throw new ValidationError("status", "must be 'accepted' or 'rejected'");
    }
  }

  return {
    hostId,
    batchId,
    bodySha256,
    keyId,
    receivedAt,
    status,
  };
}

export function validateAuditEntryInput(input: unknown): ObservatoryAuditEntry {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAuditEntry", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const auditId = obj.auditId ? validateOpaqueId(obj.auditId, "auditId") : undefined;
  const action = validateSafeString(obj.action, "action", 64, true)!;
  const actor = validateSafeString(obj.actor, "actor", 64, true)!;
  const targetType = validateSafeString(obj.targetType, "targetType", 64, true)!;
  const targetId = validateSafeString(obj.targetId, "targetId", 128, true)!;
  const occurredAt = validateIsoUtcTimestamp(obj.occurredAt, "occurredAt");
  return {
    auditId,
    action,
    actor,
    targetType,
    targetId,
    occurredAt,
  };
}

export function validateImportLedgerEntry(input: unknown): ImportLedgerEntry {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ImportLedgerEntry", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const batchId = validateOpaqueId(obj.batchId, "batchId");
  const source = validateSafeString(obj.source, "source", 64, true)!;
  const importedAt = validateIsoUtcTimestamp(obj.importedAt, "importedAt");
  const recordCount = validateNonNegativeInteger(obj.recordCount, "recordCount", true)!;

  const validStatuses = ["pending", "completed", "failed"];
  const statusStr = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (!validStatuses.includes(statusStr)) {
    throw new ValidationError("status", `must be one of: ${validStatuses.join(", ")}`);
  }
  const status = statusStr as ImportLedgerEntry["status"];
  return {
    batchId,
    source,
    importedAt,
    recordCount,
    status,
  };
}

export function validateObservatoryAgentRouterAccount(input: unknown): ObservatoryAgentRouterAccount {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterAccount", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const accountLabel = validateSafeString(obj.accountLabel, "accountLabel", 128, true)!;
  const createdAt = obj.createdAt ? validateIsoUtcTimestamp(obj.createdAt, "createdAt") : undefined;
  const updatedAt = obj.updatedAt ? validateIsoUtcTimestamp(obj.updatedAt, "updatedAt") : undefined;

  return {
    accountId,
    accountLabel,
    createdAt,
    updatedAt,
  };
}

export function validateObservatoryAgentRouterRun(input: unknown): ObservatoryAgentRouterRun {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterRun", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const id = validateNonNegativeInteger(obj.id, "id", false) ?? undefined;
  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const accountLabel = validateSafeString(obj.accountLabel, "accountLabel", 128, true)!;
  const startedAt = validateIsoUtcTimestamp(obj.startedAt, "startedAt");
  const endedAt = validateIsoUtcTimestamp(obj.endedAt, "endedAt");

  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new ValidationError("endedAt", "cannot be earlier than startedAt");
  }

  const validStatus = ["ok", "error"];
  const statusStr = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (!validStatus.includes(statusStr)) {
    throw new ValidationError("status", "must be 'ok' or 'error'");
  }
  const status = statusStr as "ok" | "error";

  const loginMs = validateNonNegativeInteger(obj.loginMs, "loginMs", true)!;
  const dashboardMs = validateNonNegativeInteger(obj.dashboardMs, "dashboardMs", true)!;
  const totalMs = validateNonNegativeInteger(obj.totalMs, "totalMs", true)!;
  const loggedOut = typeof obj.loggedOut === "boolean" ? obj.loggedOut : Boolean(obj.loggedOut);
  const sessionReused = typeof obj.sessionReused === "boolean" ? obj.sessionReused : Boolean(obj.sessionReused);
  const errorCategory = obj.errorCategory
    ? validateSafeString(obj.errorCategory, "errorCategory", 64, false)
    : null;

  const balance = validateFiniteNumber(obj.balance, "balance", false);
  const consumed = validateFiniteNumber(obj.consumed, "consumed", false);
  const requestCount = validateNonNegativeInteger(obj.requestCount, "requestCount", false);
  const quotaPerUnit = validateFiniteNumber(obj.quotaPerUnit, "quotaPerUnit", false);
  const averageRpm = validateFiniteNumber(obj.averageRpm, "averageRpm", false);
  const averageTpm = validateFiniteNumber(obj.averageTpm, "averageTpm", false);
  const availableModels = validateNonNegativeInteger(obj.availableModels, "availableModels", false);

  return {
    id,
    accountId,
    accountLabel,
    startedAt,
    endedAt,
    status,
    loginMs,
    dashboardMs,
    totalMs,
    loggedOut,
    sessionReused,
    errorCategory,
    balance,
    consumed,
    requestCount,
    quotaPerUnit,
    averageRpm,
    averageTpm,
    availableModels,
  };
}

export function validateObservatoryAgentRouterUsagePoint(input: unknown): ObservatoryAgentRouterUsagePoint {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterUsagePoint", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const id = validateNonNegativeInteger(obj.id, "id", false) ?? undefined;
  const accountId = validateOpaqueId(obj.accountId, "accountId");

  const validGranularity = ["hour", "day", "week"];
  const granStr = typeof obj.granularity === "string" ? obj.granularity.toLowerCase() : "";
  if (!validGranularity.includes(granStr)) {
    throw new ValidationError("granularity", "must be 'hour', 'day', or 'week'");
  }
  const granularity = granStr as "hour" | "day" | "week";

  const createdAtTs = validateNonNegativeInteger(obj.createdAtTs, "createdAtTs", true)!;
  
  let modelName: string | null = null;
  if (obj.modelName !== undefined && obj.modelName !== null) {
    if (typeof obj.modelName !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(obj.modelName.trim())) {
      throw new ValidationError("modelName", "must be null or a safe alphanumeric/delimiter model identifier");
    }
    modelName = obj.modelName.trim();
  }

  const requestCount = validateNonNegativeInteger(obj.requestCount, "requestCount", true)!;
  const tokenUsed = validateNonNegativeInteger(obj.tokenUsed, "tokenUsed", true)!;
  const quota = validateFiniteNumber(obj.quota, "quota", true)!;

  return {
    id,
    accountId,
    granularity,
    createdAtTs,
    modelName,
    requestCount,
    tokenUsed,
    quota,
  };
}

export function validateObservatoryAgentRouterBalanceObservation(input: unknown): ObservatoryAgentRouterBalanceObservation {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterBalanceObservation", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const id = validateNonNegativeInteger(obj.id, "id", false) ?? undefined;
  const runId = validateNonNegativeInteger(obj.runId, "runId", false);
  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const observedAt = validateIsoUtcTimestamp(obj.observedAt, "observedAt");
  const balance = validateFiniteNumber(obj.balance, "balance", true)!;
  const consumed = validateFiniteNumber(obj.consumed, "consumed", true)!;
  const previousBalance = validateFiniteNumber(obj.previousBalance, "previousBalance", false);
  const previousConsumed = validateFiniteNumber(obj.previousConsumed, "previousConsumed", false);
  const balanceDelta = validateFiniteNumber(obj.balanceDelta, "balanceDelta", false);
  const consumedDelta = validateFiniteNumber(obj.consumedDelta, "consumedDelta", false);
  const minutesSincePrevious = validateFiniteNumber(obj.minutesSincePrevious, "minutesSincePrevious", false);

  const validClass = ["initial", "credit-increase", "usage", "mixed", "unchanged"];
  const classStr = typeof obj.classification === "string" ? obj.classification.toLowerCase() : "";
  if (!validClass.includes(classStr)) {
    throw new ValidationError("classification", `must be one of: ${validClass.join(", ")}`);
  }
  const classification = classStr as ObservatoryAgentRouterBalanceObservation["classification"];

  return {
    id,
    runId,
    accountId,
    observedAt,
    balance,
    consumed,
    previousBalance,
    previousConsumed,
    balanceDelta,
    consumedDelta,
    minutesSincePrevious,
    classification,
  };
}

export function validateObservatoryAgentRouterGrantEvent(input: unknown): ObservatoryAgentRouterGrantEvent {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterGrantEvent", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const id = validateNonNegativeInteger(obj.id, "id", false) ?? undefined;
  const runId = validateNonNegativeInteger(obj.runId, "runId", false);
  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const sourceEventId = validateSafeString(obj.sourceEventId, "sourceEventId", 128, true)!;
  const occurredAt = validateIsoUtcTimestamp(obj.occurredAt, "occurredAt");
  const amount = validateFiniteNumber(obj.amount, "amount", true)!;
  if (amount <= 0) {
    throw new ValidationError("amount", "must be greater than 0");
  }
  const classification = validateSafeString(obj.classification, "classification", 64, true)! as "daily-signin";

  return {
    id,
    runId,
    accountId,
    sourceEventId,
    occurredAt,
    amount,
    classification,
  };
}

export function validateObservatoryAgentRouterEndpointObservation(input: unknown): ObservatoryAgentRouterEndpointObservation {
  if (!input || typeof input !== "object") {
    throw new ValidationError("ObservatoryAgentRouterEndpointObservation", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const id = validateNonNegativeInteger(obj.id, "id", false) ?? undefined;
  const accountId = validateOpaqueId(obj.accountId, "accountId");
  const accountLabel = validateSafeString(obj.accountLabel, "accountLabel", 128, true)!;
  const observedAt = validateIsoUtcTimestamp(obj.observedAt, "observedAt");

  const validStatus = ["ok", "error"];
  const statusStr = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (!validStatus.includes(statusStr)) {
    throw new ValidationError("status", "must be 'ok' or 'error'");
  }
  const status = statusStr as "ok" | "error";

  const balance = validateFiniteNumber(obj.balance, "balance", false);
  const consumed = validateFiniteNumber(obj.consumed, "consumed", false);
  const requestCount = validateNonNegativeInteger(obj.requestCount, "requestCount", false);
  const latencyMs = validateNonNegativeInteger(obj.latencyMs, "latencyMs", true)!;
  const errorCategory = obj.errorCategory
    ? validateSafeString(obj.errorCategory, "errorCategory", 64, false)
    : null;

  return {
    id,
    accountId,
    accountLabel,
    observedAt,
    status,
    balance,
    consumed,
    requestCount,
    latencyMs,
    errorCategory,
  };
}

export function validateUtcDay(value: unknown, fieldName = "dayUtc"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(fieldName, "must be a non-empty UTC date string (YYYY-MM-DD or ISO UTC timestamp)");
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + "T00:00:00.000Z");
    if (isNaN(d.getTime())) {
      throw new ValidationError(fieldName, "invalid date");
    }
    return trimmed;
  }
  const canonical = validateIsoUtcTimestamp(trimmed, fieldName);
  return canonical.slice(0, 10);
}

export function validateDailyQuotaRollupInput(input: unknown): DailyQuotaRollupInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("DailyQuotaRollupInput", "must be an object");
  }
  const obj = input as Record<string, unknown>;

  const dayUtc = validateUtcDay(obj.dayUtc, "dayUtc");
  const identityId = validateOpaqueId(obj.identityId, "identityId");
  const provider = validateSafeString(obj.provider, "provider", 64, true)!;
  const windowId = validateOpaqueId(obj.windowId, "windowId");
  const bucketId = obj.bucketId ? validateOpaqueId(obj.bucketId, "bucketId") : windowId;
  const meter = obj.meter ? validateSafeString(obj.meter, "meter", 64, false) : null;
  const model = obj.model ? validateSafeString(obj.model, "model", 128, false) : null;
  const tier = obj.tier ? validateSafeString(obj.tier, "tier", 64, false) : null;
  const observationCount = validateNonNegativeInteger(obj.observationCount, "observationCount", true)!;
  const minUsedFraction = validateFraction(obj.minUsedFraction, "minUsedFraction", true)!;
  const maxUsedFraction = validateFraction(obj.maxUsedFraction, "maxUsedFraction", true)!;
  const avgUsedFraction = validateFraction(obj.avgUsedFraction, "avgUsedFraction", true)!;
  const minRemainingFraction = validateFraction(obj.minRemainingFraction, "minRemainingFraction", false);
  const maxRemainingFraction = validateFraction(obj.maxRemainingFraction, "maxRemainingFraction", false);
  const avgRemainingFraction = validateFraction(obj.avgRemainingFraction, "avgRemainingFraction", false);
  const minResetCredits = validateNonNegativeNumber(obj.minResetCredits, "minResetCredits", false);
  const maxResetCredits = validateNonNegativeNumber(obj.maxResetCredits, "maxResetCredits", false);
  const firstObservedAt = validateIsoUtcTimestamp(obj.firstObservedAt, "firstObservedAt");
  const lastObservedAt = validateIsoUtcTimestamp(obj.lastObservedAt, "lastObservedAt");
  const finalizedAt = obj.finalizedAt ? validateIsoUtcTimestamp(obj.finalizedAt, "finalizedAt") : new Date().toISOString();

  return {
    dayUtc,
    identityId,
    provider,
    bucketId,
    windowId,
    meter,
    model,
    tier,
    observationCount,
    minUsedFraction,
    maxUsedFraction,
    avgUsedFraction,
    minRemainingFraction,
    maxRemainingFraction,
    avgRemainingFraction,
    minResetCredits,
    maxResetCredits,
    firstObservedAt,
    lastObservedAt,
    finalizedAt,
  };
}
